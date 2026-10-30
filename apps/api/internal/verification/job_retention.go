// SPDX-License-Identifier: AGPL-3.0-only

package verification

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// VerificationJobMaxNonTerminalAge bounds how long an abandoned durable job
// may retain per-address rows without reaching a terminal state. The largest
// supported job can normally clear the provider rate limit in hours; seven
// days leaves ample room for slow providers and rolling maintenance while
// still giving the existing terminal-item retention policy a definite start.
const VerificationJobMaxNonTerminalAge = 7 * 24 * time.Hour

const failureCodeRetentionTimeout = "verification_job_retention_timeout"

type staleVerificationJob struct {
	tenantID string
	jobID    string
}

// expireStaleJobs gives abandoned pending/running jobs a terminal retention
// boundary. Candidate discovery is worker-scoped and deliberately returns only
// tenant/job ids; every mutation is then re-authorized under that tenant and
// rechecks leases while holding the parent row lock.
func (s *Store) expireStaleJobs(ctx context.Context, limit int) (int64, error) {
	if s == nil || s.Pool == nil {
		return 0, errors.New("verification: no database pool configured")
	}
	if limit <= 0 {
		limit = 10000
	}
	candidates, err := s.staleJobCandidates(ctx, limit)
	if err != nil {
		return 0, err
	}

	var expired int64
	for _, candidate := range candidates {
		changed, err := s.expireStaleJob(ctx, candidate)
		if err != nil {
			return expired, err
		}
		if changed {
			expired++
		}
	}
	return expired, nil
}

func (s *Store) staleJobCandidates(ctx context.Context, limit int) ([]staleVerificationJob, error) {
	tx, err := db.WithWorkerScope(ctx, s.Pool)
	if err != nil {
		return nil, fmt.Errorf("verification: begin stale-job discovery: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT tenant_id::text, id::text
  FROM verification_jobs
 WHERE status IN ($1, $2, $3, $4)
   AND created_at <= now() - $5::interval
   AND (lease_expires_at IS NULL OR lease_expires_at <= now())
 ORDER BY created_at, id
 LIMIT $6`, JobStatusPending, JobStatusRunning,
		jobStatusImportPending, jobStatusImportRunning,
		durationInterval(VerificationJobMaxNonTerminalAge), limit)
	if err != nil {
		return nil, fmt.Errorf("verification: discover stale jobs: %w", err)
	}
	defer rows.Close()

	candidates := make([]staleVerificationJob, 0)
	for rows.Next() {
		var candidate staleVerificationJob
		if err := rows.Scan(&candidate.tenantID, &candidate.jobID); err != nil {
			return nil, fmt.Errorf("verification: scan stale job identity: %w", err)
		}
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("verification: iterate stale jobs: %w", err)
	}
	return candidates, nil
}

func (s *Store) expireStaleJob(ctx context.Context, candidate staleVerificationJob) (bool, error) {
	tx, err := db.WithTenantWorker(ctx, s.Pool, candidate.tenantID)
	if err != nil {
		return false, fmt.Errorf("verification: begin stale-job transition: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var status string
	err = tx.QueryRow(ctx, `
SELECT status
  FROM verification_jobs AS job
 WHERE job.tenant_id = $1::uuid
   AND job.id = $2::uuid
   AND job.status IN ($3, $4, $5, $6)
   AND job.created_at <= now() - $7::interval
   AND (job.lease_expires_at IS NULL OR job.lease_expires_at <= now())
   AND NOT EXISTS (
       SELECT 1
         FROM verification_job_items AS item
        WHERE item.tenant_id = job.tenant_id
          AND item.job_id = job.id
          AND item.attempt_state = 'leased'
          AND item.lease_expires_at > now()
   )
 FOR UPDATE`, candidate.tenantID, candidate.jobID,
		JobStatusPending, JobStatusRunning, jobStatusImportPending,
		jobStatusImportRunning, durationInterval(VerificationJobMaxNonTerminalAge)).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("verification: lock stale job: %w", err)
	}

	// A durable dispatch receipt means a vendor may have charged the request.
	// Preserve that uncertainty exactly like normal expired-lease recovery and
	// never make the address automatically retryable.
	if _, err := tx.Exec(ctx, `
UPDATE verification_job_items
   SET attempt_state = 'ambiguous', status = $3, sub_status = $4,
       score = NULL, provider = '', billable = false, cached = false,
       did_you_mean = '', checked_at = NULL,
       lease_owner = NULL, lease_expires_at = NULL, completed_at = now()
 WHERE tenant_id = $1::uuid AND job_id = $2::uuid
   AND attempt_state = 'leased'
   AND request_started_at IS NOT NULL
   AND lease_expires_at <= now()`, candidate.tenantID, candidate.jobID,
		string(StatusUnknown), "provider_response_ambiguous"); err != nil {
		return false, fmt.Errorf("verification: preserve stale dispatched attempts: %w", err)
	}

	// A lease without a dispatch receipt crossed no billable boundary. Restore
	// the canonical pending shape before terminalizing the parent.
	if _, err := tx.Exec(ctx, `
UPDATE verification_job_items
   SET attempt_state = 'pending', attempt_token = NULL,
       request_started_at = NULL, lease_owner = NULL,
       lease_expires_at = NULL, completed_at = NULL
 WHERE tenant_id = $1::uuid AND job_id = $2::uuid
   AND attempt_state = 'leased'
   AND request_started_at IS NULL
   AND lease_expires_at <= now()`, candidate.tenantID, candidate.jobID); err != nil {
		return false, fmt.Errorf("verification: release stale undispatched attempts: %w", err)
	}

	var failureCode string
	err = tx.QueryRow(ctx, `
UPDATE verification_jobs AS job
   SET status = $3,
       failure_code = CASE
           WHEN EXISTS (
               SELECT 1 FROM verification_job_items AS item
                WHERE item.tenant_id = job.tenant_id
                  AND item.job_id = job.id
                  AND item.attempt_state = 'ambiguous'
           ) THEN $4
           ELSE $5
       END,
       error = CASE
           WHEN EXISTS (
               SELECT 1 FROM verification_job_items AS item
                WHERE item.tenant_id = job.tenant_id
                  AND item.job_id = job.id
                  AND item.attempt_state = 'ambiguous'
           ) THEN $6
           ELSE $7
       END,
       completed_at = now(),
       ambiguous = (
           SELECT count(*) FROM verification_job_items AS item
            WHERE item.tenant_id = job.tenant_id
              AND item.job_id = job.id
              AND item.attempt_state = 'ambiguous'
       ),
       lease_owner = NULL,
       lease_expires_at = NULL
 WHERE job.tenant_id = $1::uuid AND job.id = $2::uuid
 RETURNING failure_code`, candidate.tenantID, candidate.jobID,
		JobStatusFailed, failureCodeOutcomeAmbiguous, failureCodeRetentionTimeout,
		"A provider request ended without a durable result. Review ambiguous rows before explicitly starting a new verification.",
		"The verification job exceeded the non-terminal retention window and was stopped safely.").Scan(&failureCode)
	if err != nil {
		return false, fmt.Errorf("verification: terminalize stale job: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("verification: commit stale-job transition: %w", err)
	}
	observeVerificationJobTerminal(JobStatusFailed, failureCode)
	return true, nil
}
