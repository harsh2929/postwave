// SPDX-License-Identifier: AGPL-3.0-only
//
// jobs_runner.go — the bulk-verification worker: claim, lease, batch, and
// complete verification_jobs rows. Split from jobs.go, which keeps the job
// model, creation, stored-row validation, and read surfaces.

package verification

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// --- the worker ---

// Runner executes jobs.
type Runner struct {
	Store  *Store
	Logger *slog.Logger
	// ChainFor builds the verifier for a tenant. Injectable so tests
	// can script a vendor without a live key.
	ChainFor func(ctx context.Context, tenantID string) (*Chain, error)
	// BatchSize defaults to DefaultJobBatchSize.
	BatchSize int
	// MaxBatchesPerRun bounds one RunJob invocation. Zero means "run
	// to completion". A small value lets a scheduler interleave jobs
	// so one enormous list cannot starve every other tenant.
	MaxBatchesPerRun int
	// Interval is the poll cadence for Run.
	Interval time.Duration
	// Owner is an optional human-readable process prefix. Every actual job
	// claim appends a UUID, so concurrent goroutines in one process still have
	// disjoint ownership.
	Owner string
	// LeaseDuration defaults to DefaultJobLeaseDuration.
	LeaseDuration time.Duration
}

func (r *Runner) batchSize() int {
	if r.BatchSize > 0 {
		return r.BatchSize
	}
	return DefaultJobBatchSize
}

func (r *Runner) batchSizeForChain(chain *Chain) int {
	size := r.batchSize()
	if chain != nil && chain.Vendor != nil && chain.Vendor.Name() == ProviderZeroBounce &&
		size > zeroBounceMaxBatch {
		// One durable claim equals one validatebatch request. This keeps pacing
		// waits before the exact request-start receipt and prevents undispatched
		// rows in a multi-chunk claim from being swept into an ambiguous outcome.
		return zeroBounceMaxBatch
	}
	if chain != nil && chain.Vendor != nil && chain.Vendor.Name() == ProviderKickbox &&
		size > kickboxBatchConcurrency {
		// The dispatch hook durably marks the entire vendor-pending subset before
		// VerifyBatch starts. Kickbox uses concurrent single-address requests, so
		// never claim more rows than one bounded fan-out window; otherwise one
		// fatal response could make a 100-row claim look dispatched even though at
		// most eight requests crossed the provider boundary.
		return kickboxBatchConcurrency
	}
	return size
}

func (r *Runner) chainForMode(ctx context.Context, tenantID, executionMode string) (*Chain, error) {
	mode, err := normalizeJobExecutionMode(executionMode)
	if err != nil {
		return nil, err
	}

	var chain *Chain
	if r.ChainFor != nil {
		chain, err = r.ChainFor(ctx, tenantID)
	} else if mode == JobExecutionModeLocal {
		// Local execution may read reusable tenant cache entries but never
		// resolves a vendor credential or crosses a metered boundary.
		chain = &Chain{Local: r.Store.localVerifier()}
		if r.Store.Pool != nil {
			chain.Cache = &TenantCache{Store: r.Store, TenantID: tenantID, TTL: DefaultCacheTTL}
		}
	} else {
		chain, err = r.Store.BuildChain(ctx, tenantID)
	}
	if err != nil {
		return nil, err
	}
	if chain == nil || chain.Local == nil {
		return nil, fmt.Errorf("verification: execution chain has no local tier: %w", ErrNotConfigured)
	}

	switch mode {
	case JobExecutionModeLocal:
		// Copy only the free tiers even when a test/composition chain also has a
		// vendor. This makes the persisted mode an enforceable spend boundary.
		return &Chain{Local: chain.Local, Cache: chain.Cache}, nil
	case JobExecutionModeFull:
		if chain.Vendor == nil {
			return nil, fmt.Errorf("verification: full execution requires an enabled provider: %w", ErrNotConfigured)
		}
		// A full import/job is fail-closed. Tenant provider configuration may
		// choose degradation for interactive uses, but it cannot silently turn a
		// provider outage into admitted unknown rows in durable bulk execution.
		chain.DegradeOnVendorFailure = false
		return chain, nil
	default:
		return nil, fmt.Errorf("verification: unsupported execution mode %q", mode)
	}
}

func (r *Runner) leaseDuration() time.Duration {
	if r.LeaseDuration > 0 {
		return r.LeaseDuration
	}
	return DefaultJobLeaseDuration
}

func (r *Runner) claimOwner() string {
	prefix := strings.TrimSpace(r.Owner)
	if prefix == "" {
		host, err := os.Hostname()
		if err != nil || strings.TrimSpace(host) == "" {
			host = "unknown-host"
		}
		prefix = fmt.Sprintf("%s-%d", host, os.Getpid())
	}
	return prefix + ":verification:" + uuid.NewString()
}

// RunJob processes outstanding items for one job.
//
// It is safe to call repeatedly: each call claims only unprocessed
// rows, so re-invocation resumes rather than restarts.
func (r *Runner) RunJob(ctx context.Context, tenantID, jobID string) error {
	if r == nil || r.Store == nil {
		return errors.New("verification: runner store is not configured")
	}
	owner := r.claimOwner()
	claimed, err := r.Store.claimJob(ctx, tenantID, jobID, owner, r.leaseDuration())
	if errors.Is(err, ErrJobLeaseHeld) {
		return nil
	}
	if err != nil {
		return err
	}
	if !claimed {
		return nil
	}
	return r.runClaim(ctx, tenantID, jobID, owner)
}

func (r *Runner) runClaim(ctx context.Context, tenantID, jobID, owner string) error {
	executionMode, err := r.Store.claimedJobExecutionMode(ctx, tenantID, jobID, owner)
	if err != nil {
		return err
	}
	chain, err := r.chainForMode(ctx, tenantID, executionMode)
	if err != nil {
		r.recordConfiguredProviderFailure(ctx, tenantID, err)
		return r.fail(ctx, tenantID, jobID, owner, err)
	}
	return r.runClaimWithChain(ctx, tenantID, jobID, owner, chain)
}

func isProviderOperationalError(err error) bool {
	return errors.Is(err, ErrNoCredits) || errors.Is(err, ErrUnauthorized) ||
		errors.Is(err, ErrProviderAccountRejected) || errors.Is(err, ErrProviderUnavailable) ||
		errors.Is(err, ErrNotConfigured) ||
		errors.Is(err, ErrProviderPartialOutcome)
}

func (r *Runner) recordConfiguredProviderFailure(ctx context.Context, tenantID string, cause error) {
	if r == nil || r.Store == nil || !isProviderOperationalError(cause) {
		return
	}
	cfg, err := r.Store.EnabledProvider(ctx, tenantID)
	if err != nil || cfg == nil || !cfg.Enabled {
		return
	}
	r.Store.RecordProviderError(ctx, tenantID, cfg.Provider, cause)
}

func (r *Runner) recordChainProviderFailure(ctx context.Context, tenantID string, chain *Chain, cause error) {
	if r == nil || r.Store == nil || chain == nil || chain.Vendor == nil || !isProviderOperationalError(cause) {
		return
	}
	r.Store.RecordProviderError(ctx, tenantID, chain.Vendor.Name(), cause)
}

func (s *Store) claimedJobExecutionMode(ctx context.Context, tenantID, jobID, owner string) (string, error) {
	tx, err := db.WithTenantWorker(ctx, s.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var mode string
	err = tx.QueryRow(ctx, `
SELECT execution_mode
  FROM verification_jobs
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND status IN ($3, $4) AND lease_owner = $5 AND lease_expires_at > now()`,
		tenantID, jobID, JobStatusRunning, jobStatusImportRunning, owner).Scan(&mode)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrJobLeaseLost
	}
	if err != nil {
		return "", err
	}
	return mode, nil
}

func (r *Runner) runClaimWithChain(
	ctx context.Context,
	tenantID, jobID, owner string,
	chain *Chain,
) error {
	batches := 0
	for {
		if r.MaxBatchesPerRun > 0 && batches >= r.MaxBatchesPerRun {
			return r.Store.yieldJob(ctx, tenantID, jobID, owner)
		}

		claim, err := r.Store.claimBatch(ctx, tenantID, jobID, owner,
			r.batchSizeForChain(chain), r.leaseDuration())
		if err != nil {
			return err
		}
		if len(claim.Emails) == 0 {
			return r.Store.completeJob(ctx, tenantID, jobID, owner)
		}
		if err := validateClaimedJobEmails(claim.Emails); err != nil {
			if markErr := r.Store.failUnbilledBatch(ctx, claim, err); markErr != nil && r.Logger != nil {
				r.Logger.Error("verification: could not reject malformed durable job addresses",
					"job_id", jobID, "error_class", safeJobLogErrorClass(markErr))
			}
			return err
		}
		var dispatched []string
		results, stats, err := chain.VerifyBatchWithDispatchHook(ctx, claim.Emails,
			func(dispatchCtx context.Context, emails []string) error {
				if err := r.Store.markBatchRequestStarted(dispatchCtx, claim, emails); err != nil {
					return err
				}
				dispatched = append(dispatched, emails...)
				return nil
			})
		if err != nil {
			r.recordChainProviderFailure(ctx, tenantID, chain, err)
			// Errors before the hook cannot have spent a vendor credit. Provider
			// auth and balance rejections are also explicit non-billable receipts.
			if len(dispatched) == 0 || isExplicitUnbilledProviderRejection(err) {
				if markErr := r.Store.failUnbilledBatch(ctx, claim, err); markErr != nil && r.Logger != nil {
					r.Logger.Error("verification: could not record provider rejection",
						"job_id", jobID, "error_class", safeJobLogErrorClass(markErr))
				}
				return err
			}
			if markErr := r.Store.markBatchAmbiguous(ctx, claim, dispatched, err); markErr != nil && r.Logger != nil {
				r.Logger.Error("verification: could not record ambiguous provider outcome",
					"job_id", jobID, "error_class", safeJobLogErrorClass(markErr))
			}
			return ErrJobOutcomeAmbiguous
		}
		if err := r.Store.applyBatch(ctx, claim, chain.Name(), results, stats); err != nil {
			return err
		}
		batches++
	}
}

func validateClaimedJobEmails(emails []string) error {
	seen := make(map[string]struct{}, len(emails))
	for _, email := range emails {
		if email == "" || len(email) > maxJobEmailBytes || hasUnsafeControlText(email) ||
			NormalizeEmail(email) != email {
			return errors.New("verification: durable job contains an invalid canonical address")
		}
		if _, duplicate := seen[email]; duplicate {
			return errors.New("verification: durable job contains a duplicate canonical address")
		}
		seen[email] = struct{}{}
	}
	return nil
}

func (r *Runner) fail(ctx context.Context, tenantID, jobID, owner string, cause error) error {
	if markErr := r.Store.failJob(ctx, tenantID, jobID, owner, cause); markErr != nil && r.Logger != nil {
		r.Logger.Error("verification: could not record job failure",
			"job_id", jobID, "error_class", safeJobLogErrorClass(markErr))
	}
	return cause
}

// Run polls for pending jobs until ctx is canceled.
//
// Claiming is cross-tenant, so it deliberately reads the jobs table
// WITHOUT a tenant GUC — a background worker has no single tenant.
// Every subsequent operation on a claimed job is tenant-scoped again.
func (r *Runner) Run(ctx context.Context) {
	interval := r.Interval
	if interval <= 0 {
		interval = 15 * time.Second
	}
	timer := time.NewTimer(0)
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			owner := r.claimOwner()
			tenantID, jobID, err := r.Store.claimNextJob(ctx, owner, r.leaseDuration())
			if err != nil {
				if r.Logger != nil {
					r.Logger.Error("verification: poll for pending jobs",
						"error_class", safeJobLogErrorClass(err))
				}
				timer.Reset(interval)
				continue
			}
			if jobID == "" {
				timer.Reset(interval)
				continue
			}
			if err := r.runClaim(ctx, tenantID, jobID, owner); err != nil && r.Logger != nil {
				r.Logger.Error("verification: job failed",
					"tenant_id", tenantID, "job_id", jobID,
					"error_class", safeJobLogErrorClass(err))
			}
			timer.Reset(10 * time.Millisecond)
		}
	}
}

// claimNextJob leases the oldest runnable job across tenants. FORCE RLS is
// satisfied by the dedicated worker policies installed in migration 1953.
func (s *Store) claimNextJob(ctx context.Context, owner string, lease time.Duration) (string, string, error) {
	if s.Pool == nil {
		return "", "", nil
	}
	tx, err := db.WithWorkerScope(ctx, s.Pool)
	if err != nil {
		return "", "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var tenantID, jobID string
	err = tx.QueryRow(ctx, `
WITH picked AS (
    SELECT id
      FROM verification_jobs
     WHERE status IN ($1, $2, $3, $4)
       AND next_attempt_at <= now()
       AND (lease_expires_at IS NULL OR lease_expires_at <= now())
       AND (execution_class <> $5 OR activated_at IS NOT NULL)
     ORDER BY next_attempt_at, created_at, id
     FOR UPDATE SKIP LOCKED
     LIMIT 1
)
UPDATE verification_jobs AS job
   SET status = CASE WHEN job.status IN ($3, $4) THEN $4 ELSE $2 END,
       started_at = COALESCE(started_at, now()),
       attempts = attempts + 1,
       lease_owner = $6,
       lease_expires_at = now() + $7::interval
  FROM picked
 WHERE job.id = picked.id
RETURNING job.tenant_id::text, job.id::text`,
		JobStatusPending, JobStatusRunning, jobStatusImportPending, jobStatusImportRunning,
		jobExecutionClassSubscriberImport, owner, durationInterval(lease)).Scan(&tenantID, &jobID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", nil
	}
	if err != nil {
		return "", "", err
	}
	ambiguous, err := s.reconcileClaimedJob(ctx, tx, tenantID, jobID, owner)
	if err != nil {
		return "", "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", "", err
	}
	if ambiguous {
		observeVerificationJobTerminal(JobStatusFailed, failureCodeOutcomeAmbiguous)
		// The terminal reconciliation is durable. Return an explicit signal so
		// the worker reports it, then continue with another job on the next poll.
		return "", "", ErrJobOutcomeAmbiguous
	}
	return tenantID, jobID, nil
}

func (s *Store) claimJob(ctx context.Context, tenantID, jobID, owner string, lease time.Duration) (bool, error) {
	tx, err := db.WithWorkerScope(ctx, s.Pool)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var claimedTenant, claimedJob string
	err = tx.QueryRow(ctx, `
WITH picked AS (
    SELECT id
      FROM verification_jobs
     WHERE tenant_id = $1::uuid AND id = $2::uuid
       AND status IN ($3, $4, $5, $6)
       AND next_attempt_at <= now()
       AND (lease_expires_at IS NULL OR lease_expires_at <= now())
       AND (execution_class <> $7 OR activated_at IS NOT NULL)
     FOR UPDATE SKIP LOCKED
)
UPDATE verification_jobs AS job
   SET status = CASE WHEN job.status IN ($5, $6) THEN $6 ELSE $4 END,
       started_at = COALESCE(started_at, now()),
       attempts = attempts + 1,
       lease_owner = $8,
       lease_expires_at = now() + $9::interval
  FROM picked
 WHERE job.id = picked.id
RETURNING job.tenant_id::text, job.id::text`,
		tenantID, jobID, JobStatusPending, JobStatusRunning,
		jobStatusImportPending, jobStatusImportRunning, jobExecutionClassSubscriberImport,
		owner, durationInterval(lease)).Scan(&claimedTenant, &claimedJob)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, ErrJobLeaseHeld
	}
	if err != nil {
		return false, err
	}
	ambiguous, err := s.reconcileClaimedJob(ctx, tx, claimedTenant, claimedJob, owner)
	if err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	if ambiguous {
		observeVerificationJobTerminal(JobStatusFailed, failureCodeOutcomeAmbiguous)
		return false, ErrJobOutcomeAmbiguous
	}
	return true, nil
}

func durationInterval(d time.Duration) string {
	if d <= 0 {
		d = DefaultJobLeaseDuration
	}
	return fmt.Sprintf("%d microseconds", d.Microseconds())
}

func (s *Store) reconcileClaimedJob(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, jobID, owner string,
) (bool, error) {
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		return false, err
	}
	if _, err := tx.Exec(ctx, `
UPDATE verification_job_items
   SET attempt_state = 'pending', attempt_token = NULL,
       lease_owner = NULL, lease_expires_at = NULL
 WHERE tenant_id = $1::uuid AND job_id = $2::uuid
   AND attempt_state = 'leased' AND request_started_at IS NULL
	   AND lease_owner IS DISTINCT FROM $3`, tenantID, jobID, owner); err != nil {
		return false, err
	}
	ambiguous, err := tx.Exec(ctx, `
UPDATE verification_job_items
   SET attempt_state = 'ambiguous', status = $3, sub_status = $4,
       lease_owner = NULL, lease_expires_at = NULL, completed_at = now()
 WHERE tenant_id = $1::uuid AND job_id = $2::uuid
   AND attempt_state = 'leased' AND request_started_at IS NOT NULL
	   AND lease_owner IS DISTINCT FROM $5`, tenantID, jobID, string(StatusUnknown),
		"provider_response_ambiguous", owner)
	if err != nil {
		return false, err
	}
	if ambiguous.RowsAffected() > 0 {
		tag, err := tx.Exec(ctx, `
UPDATE verification_jobs
   SET status = $3, failure_code = $4,
       error = $5, completed_at = now(),
       ambiguous = (SELECT count(*) FROM verification_job_items
                     WHERE tenant_id = $1::uuid AND job_id = $2::uuid
                       AND attempt_state = 'ambiguous'),
       lease_owner = NULL, lease_expires_at = NULL
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND lease_owner = $6`,
			tenantID, jobID, JobStatusFailed, failureCodeOutcomeAmbiguous,
			"A provider request ended without a durable result. Review ambiguous rows before explicitly starting a new verification.",
			owner)
		if err != nil {
			return false, err
		}
		if tag.RowsAffected() != 1 {
			return false, ErrJobLeaseLost
		}
		return true, nil
	}
	return false, nil
}

// claimBatch durably assigns exact rows to one job owner before any external
// provider call. The lease and attempt token are committed by the caller of
// this method before markBatchRequestStarted can cross the billable boundary.
func (s *Store) claimBatch(ctx context.Context, tenantID, jobID, owner string,
	size int, lease time.Duration) (jobBatchClaim, error) {
	claim := jobBatchClaim{TenantID: tenantID, JobID: jobID, Owner: owner}
	tx, err := db.WithTenantWorker(ctx, s.Pool, tenantID)
	if err != nil {
		return claim, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	leaseUntil := durationInterval(lease)
	tag, err := tx.Exec(ctx, `
UPDATE verification_jobs
   SET lease_expires_at = now() + $4::interval
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND status IN ($3, $5) AND lease_owner = $6 AND lease_expires_at > now()`,
		tenantID, jobID, JobStatusRunning, leaseUntil, jobStatusImportRunning, owner)
	if err != nil {
		return claim, err
	}
	if tag.RowsAffected() != 1 {
		return claim, ErrJobLeaseLost
	}
	claim.AttemptToken = uuid.NewString()
	rows, err := tx.Query(ctx, `
WITH picked AS (
    SELECT id
      FROM verification_job_items
     WHERE tenant_id = $1::uuid AND job_id = $2::uuid
       AND attempt_state = 'pending'
     ORDER BY id
     FOR UPDATE SKIP LOCKED
     LIMIT $3
)
UPDATE verification_job_items AS item
   SET attempt_state = 'leased', attempt_token = $4::uuid,
       request_started_at = NULL, lease_owner = $5,
       lease_expires_at = now() + $6::interval
  FROM picked
 WHERE item.id = picked.id
RETURNING item.email`, tenantID, jobID, size, claim.AttemptToken, owner, leaseUntil)
	if err != nil {
		return claim, err
	}
	defer rows.Close()
	claim.Emails = []string{}
	for rows.Next() {
		var e string
		if err := rows.Scan(&e); err != nil {
			return claim, err
		}
		claim.Emails = append(claim.Emails, e)
	}
	if err := rows.Err(); err != nil {
		return claim, err
	}
	if err := tx.Commit(ctx); err != nil {
		return claim, err
	}
	return claim, nil
}

func (s *Store) markBatchRequestStarted(
	ctx context.Context,
	claim jobBatchClaim,
	emails []string,
) error {
	emails = dedupeNormalized(emails)
	if len(emails) == 0 {
		return errors.New("verification: refusing to persist an empty vendor dispatch receipt")
	}
	tx, err := db.WithTenantWorker(ctx, s.Pool, claim.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE verification_job_items
   SET request_started_at = now()
 WHERE tenant_id = $1::uuid AND job_id = $2::uuid
	   AND attempt_token = $3::uuid AND attempt_state = 'leased'
	   AND lease_owner = $4 AND lease_expires_at > now()
	   AND request_started_at IS NULL
	   AND email = ANY($5::text[])`, claim.TenantID, claim.JobID,
		claim.AttemptToken, claim.Owner, emails)
	if err != nil {
		return err
	}
	if int(tag.RowsAffected()) != len(emails) {
		return ErrJobLeaseLost
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return nil
}

func (s *Store) markBatchAmbiguous(
	ctx context.Context,
	claim jobBatchClaim,
	dispatched []string,
	cause error,
) error {
	dispatched = dedupeNormalized(dispatched)
	if len(dispatched) == 0 {
		return errors.New("verification: refusing to mark an empty provider dispatch ambiguous")
	}
	tx, err := db.WithTenantWorker(ctx, s.Pool, claim.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	ambiguousTag, err := tx.Exec(ctx, `
UPDATE verification_job_items
   SET attempt_state = 'ambiguous', status = $4, sub_status = $5,
       lease_owner = NULL, lease_expires_at = NULL, completed_at = now()
	 WHERE tenant_id = $1::uuid AND job_id = $2::uuid
	   AND attempt_token = $3::uuid AND attempt_state = 'leased'
	   AND request_started_at IS NOT NULL
	   AND email = ANY($6::text[])`, claim.TenantID, claim.JobID,
		claim.AttemptToken, string(StatusUnknown), "provider_response_ambiguous", dispatched)
	if err != nil {
		return err
	}
	if int(ambiguousTag.RowsAffected()) != len(dispatched) {
		return ErrJobLeaseLost
	}
	// Cache/local rows in the same claim never crossed a metered boundary and
	// remain safe for an operator-authorized retry or forensic export.
	if _, err := tx.Exec(ctx, `
UPDATE verification_job_items
   SET attempt_state = 'pending', attempt_token = NULL,
       request_started_at = NULL, lease_owner = NULL, lease_expires_at = NULL
 WHERE tenant_id = $1::uuid AND job_id = $2::uuid
   AND attempt_token = $3::uuid AND attempt_state = 'leased'
   AND request_started_at IS NULL`, claim.TenantID, claim.JobID,
		claim.AttemptToken); err != nil {
		return err
	}
	jobTag, err := tx.Exec(ctx, `
UPDATE verification_jobs
   SET status = $3, failure_code = $4, error = $5,
       completed_at = now(),
       ambiguous = (SELECT count(*) FROM verification_job_items
                     WHERE tenant_id = $1::uuid AND job_id = $2::uuid
                       AND attempt_state = 'ambiguous'),
       lease_owner = NULL, lease_expires_at = NULL
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND lease_owner = $6`,
		claim.TenantID, claim.JobID, JobStatusFailed, failureCodeOutcomeAmbiguous,
		"A provider request failed after dispatch; its charge/result is ambiguous. Review the rows before explicitly starting new work.",
		claim.Owner)
	if err != nil {
		return err
	}
	if jobTag.RowsAffected() != 1 {
		return ErrJobLeaseLost
	}
	_ = cause // raw provider errors remain server-side; the durable row is safe.
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	observeVerificationJobTerminal(JobStatusFailed, failureCodeOutcomeAmbiguous)
	return nil
}

func (s *Store) failUnbilledBatch(ctx context.Context, claim jobBatchClaim, cause error) error {
	tx, err := db.WithTenantWorker(ctx, s.Pool, claim.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE verification_job_items
   SET attempt_state = 'pending', attempt_token = NULL,
       request_started_at = NULL, lease_owner = NULL, lease_expires_at = NULL
 WHERE tenant_id = $1::uuid AND job_id = $2::uuid
   AND attempt_token = $3::uuid AND attempt_state = 'leased'
   AND lease_owner = $4`, claim.TenantID, claim.JobID, claim.AttemptToken,
		claim.Owner); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `
UPDATE verification_jobs
	   SET status = $3, failure_code = $4, error = $5, completed_at = now(),
	       lease_owner = NULL, lease_expires_at = NULL
	 WHERE tenant_id = $1::uuid AND id = $2::uuid
	   AND status IN ($6, $7) AND lease_owner = $8`, claim.TenantID, claim.JobID,
		JobStatusFailed, jobFailureCode(cause), safeStoredJobError(cause),
		JobStatusRunning, jobStatusImportRunning, claim.Owner)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrJobLeaseLost
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	observeVerificationJobTerminal(JobStatusFailed, jobFailureCode(cause))
	return nil
}

// applyBatch writes only rows belonging to the exact durable attempt and
// advances counters atomically. A stale worker cannot commit after lease loss.
func (s *Store) applyBatch(ctx context.Context, claim jobBatchClaim, provider string,
	results []Result, stats ChainStats) error {
	for i := range results {
		results[i].Email = NormalizeEmail(results[i].Email)
		if err := validatePersistableResult(results[i]); err != nil {
			return fmt.Errorf("verification: refusing to persist a job result outside the canonical contract: %w", err)
		}
	}
	tx, err := db.WithTenantWorker(ctx, s.Pool, claim.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	processed := 0
	for _, r := range results {
		var score *int16
		if r.Score != nil {
			v := int16(*r.Score)
			score = &v
		}
		checkedAt := r.CheckedAt
		if checkedAt.IsZero() {
			checkedAt = time.Now().UTC()
		}
		status := r.Status
		if !status.Valid() || status == "" {
			// Defence in depth against a driver mapping bug: the
			// CHECK constraint would reject an unmapped value and
			// abort the whole batch, losing the results either side
			// of it.
			status = StatusUnknown
		}
		tag, err := tx.Exec(ctx,
			`UPDATE verification_job_items
			    SET processed = true, status = $4, sub_status = $5, score = $6,
			        provider = $7, billable = $8, cached = $9, did_you_mean = $10,
			        checked_at = $11, attempt_state = 'succeeded', completed_at = now(),
			        lease_owner = NULL, lease_expires_at = NULL
			  WHERE tenant_id = $1::uuid AND job_id = $2::uuid AND email = $3
			    AND attempt_token = $12::uuid AND attempt_state = 'leased'
			    AND lease_owner = $13 AND lease_expires_at > now()`,
			claim.TenantID, claim.JobID, NormalizeEmail(r.Email), string(status), string(r.SubStatus),
			score, r.Provider, r.Billable, r.Cached, r.DidYouMean, checkedAt,
			claim.AttemptToken, claim.Owner)
		if err != nil {
			return err
		}
		processed += int(tag.RowsAffected())
	}
	if processed != len(claim.Emails) || processed != len(results) {
		return ErrJobLeaseLost
	}

	jobTag, err := tx.Exec(ctx,
		`UPDATE verification_jobs
		    SET processed       = processed + $3,
		        cache_hits      = cache_hits + $4,
		        local_filtered  = local_filtered + $5,
		        vendor_verified = vendor_verified + $6,
		        credits_spent   = credits_spent + $7,
		        duplicates      = duplicates + $8,
		        provider        = CASE WHEN $9 = '' THEN provider ELSE $9 END
		  WHERE tenant_id = $1::uuid AND id = $2::uuid
		    AND status IN ($10, $11) AND lease_owner = $12 AND lease_expires_at > now()`,
		claim.TenantID, claim.JobID, processed, stats.CacheHits, stats.LocalFiltered,
		stats.VendorVerified, stats.CreditsSpent, stats.Duplicates, provider,
		JobStatusRunning, jobStatusImportRunning, claim.Owner)
	if err != nil {
		return err
	}
	if jobTag.RowsAffected() != 1 {
		return ErrJobLeaseLost
	}
	// Keep the operator usage rollup in the same transaction as item results
	// and job counters. A worker crash can therefore neither lose nor double
	// count the batch after its provider response was durably accepted.
	if stats.Total > 0 {
		if _, err := tx.Exec(ctx,
			`INSERT INTO verification_usage_daily
			     (tenant_id, day, provider, verified, credits_spent, local_filtered, cache_hits)
			 VALUES ($1::uuid, current_date, $2, $3, $4, $5, $6)
			 ON CONFLICT (tenant_id, day, provider) DO UPDATE
			    SET verified       = verification_usage_daily.verified + EXCLUDED.verified,
			        credits_spent  = verification_usage_daily.credits_spent + EXCLUDED.credits_spent,
			        local_filtered = verification_usage_daily.local_filtered + EXCLUDED.local_filtered,
			        cache_hits     = verification_usage_daily.cache_hits + EXCLUDED.cache_hits,
			        updated_at     = now()`,
			claim.TenantID, provider, stats.Total, stats.CreditsSpent,
			stats.LocalFiltered, stats.CacheHits); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return nil
}

func (s *Store) completeJob(ctx context.Context, tenantID, jobID, owner string) error {
	tx, err := db.WithTenantWorker(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx,
		`UPDATE verification_jobs
		    SET status = $3, completed_at = now(),
		        lease_owner = NULL, lease_expires_at = NULL
		  WHERE tenant_id = $1::uuid AND id = $2::uuid AND status IN ($4, $5)
		    AND lease_owner = $6 AND lease_expires_at > now()
		    AND NOT EXISTS (
		        SELECT 1 FROM verification_job_items
		         WHERE tenant_id = $1::uuid AND job_id = $2::uuid
		           AND attempt_state <> 'succeeded'
		    )`, tenantID, jobID, JobStatusCompleted, JobStatusRunning, jobStatusImportRunning, owner)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrJobLeaseLost
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	observeVerificationJobTerminal(JobStatusCompleted, "")
	return nil
}

func (s *Store) yieldJob(ctx context.Context, tenantID, jobID, owner string) error {
	tx, err := db.WithTenantWorker(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE verification_jobs
   SET lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND status IN ($3, $4) AND lease_owner = $5`, tenantID, jobID,
		JobStatusRunning, jobStatusImportRunning, owner)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrJobLeaseLost
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return nil
}

func (s *Store) failJob(ctx context.Context, tenantID, jobID, owner string, cause error) error {
	tx, err := db.WithTenantWorker(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx,
		`UPDATE verification_jobs
		    SET status = $3, failure_code = $4, error = $5, completed_at = now(),
		        lease_owner = NULL, lease_expires_at = NULL
		  WHERE tenant_id = $1::uuid AND id = $2::uuid
		    AND status NOT IN ($6, $7) AND lease_owner = $8`,
		tenantID, jobID, JobStatusFailed, jobFailureCode(cause), safeStoredJobError(cause),
		JobStatusCanceled, JobStatusCompleted, owner)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrJobLeaseLost
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	observeVerificationJobTerminal(JobStatusFailed, jobFailureCode(cause))
	return nil
}
