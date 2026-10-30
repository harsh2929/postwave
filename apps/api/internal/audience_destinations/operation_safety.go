// SPDX-License-Identifier: AGPL-3.0-only
//
// Durable operation identity, resource leases, and pre-effect request evidence
// for webhook and native ad-audience activation.
package audience_destinations

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
)

const (
	operationTriggerManual    = "manual"
	operationTriggerScheduled = "scheduled"
	operationLeaseDuration    = 2 * SyncRunTimeout
	operationErrorMaxLen      = 2000
)

var (
	ErrOperationInProgress = errors.New("audience_destinations: operation already in progress")
	ErrOperationLeaseLost  = errors.New("audience_destinations: operation lease lost")
	ErrLifecycleBlocked    = errors.New("audience_destinations: lifecycle blocks operation")
	ErrAudienceCapExceeded = errors.New("audience_destinations: audience exceeds per-run cap")
)

// manualOperationKey converts a caller-supplied Idempotency-Key into a bounded,
// non-sensitive resource-operation identity. Missing keys still receive a
// durable random identity, while a retry carrying the same key converges on the
// existing operation row.
func manualOperationKey(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		raw = uuid.NewString()
	}
	sum := sha256.Sum256([]byte(operationTriggerManual + "\x00" + raw))
	return operationTriggerManual + ":" + hex.EncodeToString(sum[:])
}

func boundedOperationError(errMsg string) string {
	errMsg = strings.TrimSpace(errMsg)
	if len(errMsg) > operationErrorMaxLen {
		return errMsg[:operationErrorMaxLen] + "…"
	}
	return errMsg
}

type syncOperationClaim struct {
	Sync         *Sync
	Run          *SyncRun
	OperationKey string
	LeaseOwner   string
	Created      bool
}

type destinationOperationClaim struct {
	Destination  *Destination
	Job          *SyncJob
	OperationKey string
	LeaseOwner   string
	Created      bool
}

type operationAttemptPlan struct {
	Sequence       int
	Kind           string
	IdempotencyKey string
	PayloadSHA256  string
	RowCount       int
}

const syncRunOperationSelect = `
       id::text, sync_id::text, status, rows_exported, batches_sent,
       started_at, finished_at, COALESCE(error,''),
       COALESCE(external_job_id,''), COALESCE(external_audience_id,''),
       COALESCE(provider_message,''),
       COALESCE(provider_status,''), provider_checked_at, provider_next_check_at,
       COALESCE(provider_poll_attempts,0),
       COALESCE(trigger_kind,'manual'), COALESCE(source_members_observed,0),
       COALESCE(cap_exceeded,false), COALESCE(excluded_count,0)`

func scanSyncRun(row pgx.Row) (*SyncRun, error) {
	var run SyncRun
	if err := row.Scan(
		&run.ID, &run.SyncID, &run.Status, &run.RowsExported, &run.BatchesSent,
		&run.StartedAt, &run.FinishedAt, &run.Error,
		&run.ExternalJobID, &run.ExternalAudienceID, &run.ProviderMessage,
		&run.ProviderStatus, &run.ProviderCheckedAt, &run.ProviderNextCheckAt,
		&run.ProviderPollAttempts,
		&run.TriggerKind, &run.SourceMembersObserved, &run.CapExceeded,
		&run.ExcludedCount,
	); err != nil {
		return nil, err
	}
	return &run, nil
}

const destinationOperationSelect = `
       id::text, tenant_id::text, provider,
       list_id::text, segment_id::text,
       COALESCE(external_audience_id,''), status,
       last_synced_at, config::text,
       created_at, updated_at`

func scanDestination(row pgx.Row) (*Destination, error) {
	var d Destination
	var listID, segmentID *string
	var cfgText string
	if err := row.Scan(
		&d.ID, &d.TenantID, (*string)(&d.Provider),
		&listID, &segmentID,
		&d.ExternalAudienceID, (*string)(&d.Status),
		&d.LastSyncedAt, &cfgText,
		&d.CreatedAt, &d.UpdatedAt,
	); err != nil {
		return nil, err
	}
	d.ListID = listID
	d.SegmentID = segmentID
	d.rawConfig = parseDestinationConfig(cfgText)
	d.Config = maskedAudienceDestinationConfigJSON(cfgText)
	return &d, nil
}

const syncJobOperationSelect = `
       id::text, tenant_id::text, destination_id::text,
       started_at, finished_at, status, COALESCE(error,''), members_synced,
       COALESCE(external_job_id,''), COALESCE(external_audience_id,''),
       COALESCE(provider_message,''), COALESCE(provider_status,''),
       provider_checked_at, provider_next_check_at,
       COALESCE(provider_poll_attempts,0),
       COALESCE(trigger_kind,'manual'), COALESCE(source_members_observed,0),
       COALESCE(cap_exceeded,false), created_at`

func scanSyncJob(row pgx.Row) (*SyncJob, error) {
	var job SyncJob
	if err := row.Scan(
		&job.ID, &job.TenantID, &job.DestinationID,
		&job.StartedAt, &job.FinishedAt, &job.Status, &job.Error, &job.MembersSynced,
		&job.ExternalJobID, &job.ExternalAudienceID, &job.ProviderMessage,
		&job.ProviderStatus, &job.ProviderCheckedAt, &job.ProviderNextCheckAt,
		&job.ProviderPollAttempts,
		&job.TriggerKind, &job.SourceMembersObserved, &job.CapExceeded,
		&job.CreatedAt,
	); err != nil {
		return nil, err
	}
	return &job, nil
}

// beginSyncOperation serializes manual and scheduled execution on one
// audience_syncs row and inserts the run ledger in the same transaction. A
// duplicate operation key returns the existing run without executing again.
func (r *Repo) beginSyncOperation(
	ctx context.Context,
	tenantID, syncID, operationKey, trigger, leaseOwner string,
	preclaimed, recovered bool,
) (*syncOperationClaim, error) {
	return r.beginSyncOperationIfCurrent(ctx, tenantID, syncID, operationKey, trigger, leaseOwner, preclaimed, recovered, "")
}

func (r *Repo) beginSyncOperationIfCurrent(
	ctx context.Context,
	tenantID, syncID, operationKey, trigger, leaseOwner string,
	preclaimed, recovered bool,
	ifMatchToken string,
) (*syncOperationClaim, error) {
	if leaseOwner == "" {
		leaseOwner = uuid.NewString()
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var enabled, leaseActive bool
	var currentOwner, currentKey string
	var updatedAt time.Time
	err = tx.QueryRow(ctx, `
SELECT enabled,
       COALESCE(run_lease_owner::text,''),
       COALESCE(run_lease_operation_key,''),
       COALESCE(run_lease_expires_at > now(), false),
       updated_at
  FROM audience_syncs
 WHERE tenant_id = $1::uuid AND id = $2::uuid
 FOR UPDATE`, tenantID, syncID).Scan(&enabled, &currentOwner, &currentKey, &leaseActive, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}

	existing, existingErr := scanSyncRun(tx.QueryRow(ctx, `
SELECT `+syncRunOperationSelect+`
  FROM audience_sync_runs
 WHERE tenant_id = $1::uuid AND sync_id = $2::uuid AND operation_key = $3`,
		tenantID, syncID, operationKey))
	if existingErr == nil {
		if existing.Status == RunStatusRunning && (recovered || !leaseActive) {
			if _, err := tx.Exec(ctx, `
UPDATE audience_sync_runs
   SET status = 'needs_reconciliation',
       error = 'operation lease expired before a terminal acknowledgement; external effects require reconciliation',
       finished_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'running'`, tenantID, existing.ID); err != nil {
				return nil, err
			}
			if _, err := tx.Exec(ctx, `
UPDATE audience_syncs
   SET last_run_at = now(), last_run_status = 'needs_reconciliation',
       run_lease_owner = NULL, run_lease_expires_at = NULL,
       run_lease_operation_key = NULL, updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, syncID); err != nil {
				return nil, err
			}
			existing.Status = RunStatusNeedsReconciliation
			now := time.Now().UTC()
			existing.FinishedAt = &now
			existing.Error = "operation lease expired before a terminal acknowledgement; external effects require reconciliation"
		}
		s, err := scanSync(tx.QueryRow(ctx, `SELECT `+syncSelectColumns+` FROM audience_syncs WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, syncID))
		if err != nil {
			return nil, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return &syncOperationClaim{Sync: s, Run: existing, OperationKey: operationKey, LeaseOwner: leaseOwner}, nil
	}
	if !errors.Is(existingErr, pgx.ErrNoRows) {
		return nil, existingErr
	}
	if ifMatchToken != "" && ifMatchToken != httpcache.ConcurrencyToken("audience-sync", syncID, updatedAt) {
		return nil, ErrPreconditionFailed
	}
	if !enabled {
		return nil, fmt.Errorf("%w: audience sync is disabled", ErrLifecycleBlocked)
	}

	if preclaimed {
		if !leaseActive || currentOwner != leaseOwner || currentKey != operationKey {
			return nil, ErrOperationLeaseLost
		}
	} else {
		if leaseActive {
			return nil, ErrOperationInProgress
		}
		if _, err := tx.Exec(ctx, `
UPDATE audience_syncs
   SET run_lease_owner = $3::uuid,
       run_lease_expires_at = now() + ($5::bigint * interval '1 millisecond'),
       run_lease_operation_key = $4, updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
			tenantID, syncID, leaseOwner, operationKey, operationLeaseDuration.Milliseconds()); err != nil {
			return nil, err
		}
	}

	run, err := scanSyncRun(tx.QueryRow(ctx, `
INSERT INTO audience_sync_runs (tenant_id, sync_id, status, operation_key, trigger_kind)
VALUES ($1::uuid, $2::uuid, 'running', $3, $4)
RETURNING `+syncRunOperationSelect, tenantID, syncID, operationKey, trigger))
	if err != nil {
		return nil, err
	}
	s, err := scanSync(tx.QueryRow(ctx, `SELECT `+syncSelectColumns+` FROM audience_syncs WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, syncID))
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &syncOperationClaim{Sync: s, Run: run, OperationKey: operationKey, LeaseOwner: leaseOwner, Created: true}, nil
}

func (r *Repo) finishSyncOperationForTenant(
	ctx context.Context,
	tenantID string,
	claim *syncOperationClaim,
	status string,
	result syncExecutionResult,
	errMsg string,
) (*SyncRun, error) {
	evidence := result.Evidence.truncated()
	providerStatus, providerNextCheck := initialProviderDiagnosticsSchedule(evidence, result.DiagnosticsSchedule)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	return r.finishSyncOperationTx(ctx, tx, tenantID, claim, status, result, errMsg, providerStatus, providerNextCheck)
}

func (r *Repo) finishSyncOperationTx(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	claim *syncOperationClaim,
	status string,
	result syncExecutionResult,
	errMsg, providerStatus string,
	providerNextCheck *time.Time,
) (*SyncRun, error) {
	var leaseMatches bool
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(run_lease_owner::text,'') = $3
   AND COALESCE(run_lease_operation_key,'') = $4
  FROM audience_syncs
 WHERE tenant_id = $1::uuid AND id = $2::uuid
 FOR UPDATE`, tenantID, claim.Sync.ID, claim.LeaseOwner, claim.OperationKey).Scan(&leaseMatches); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if !leaseMatches {
		return nil, ErrOperationLeaseLost
	}
	evidence := result.Evidence.truncated()
	run, err := scanSyncRun(tx.QueryRow(ctx, `
UPDATE audience_sync_runs
   SET status = $3, rows_exported = $4, batches_sent = $5,
       error = NULLIF($6,''), finished_at = now(),
       external_job_id = NULLIF($7,''), external_audience_id = NULLIF($8,''),
       provider_message = NULLIF($9,''), provider_status = NULLIF($10,''),
       provider_next_check_at = $11,
       source_members_observed = $12, cap_exceeded = $13
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'running'
 RETURNING `+syncRunOperationSelect,
		tenantID, claim.Run.ID, status, result.RowsExported, result.BatchesSent,
		boundedOperationError(errMsg), evidence.ExternalJobID, evidence.ExternalAudienceID,
		evidence.ProviderMessage, providerStatus, providerNextCheck,
		result.SourceMembersObserved, result.CapExceeded))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrOperationLeaseLost
	}
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
UPDATE audience_syncs
   SET last_run_at = now(), last_run_status = $3,
       run_lease_owner = NULL, run_lease_expires_at = NULL,
       run_lease_operation_key = NULL, updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, claim.Sync.ID, status); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return run, nil
}

// releaseSyncClaim releases a preclaimed scheduler lease when infrastructure
// fails before the durable run row can be inserted.
func (r *Repo) releaseSyncClaim(ctx context.Context, tenantID, syncID, owner, operationKey string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE audience_syncs
   SET run_lease_owner = NULL, run_lease_expires_at = NULL,
       run_lease_operation_key = NULL, updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND run_lease_owner = $3::uuid AND run_lease_operation_key = $4
   AND NOT EXISTS (
       SELECT 1 FROM audience_sync_runs r
        WHERE r.tenant_id = $1::uuid
          AND r.sync_id = $2::uuid
          AND r.operation_key = $4
   )`,
		tenantID, syncID, owner, operationKey); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *Repo) planRunAttempts(ctx context.Context, tenantID, runID string, plans []operationAttemptPlan) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, plan := range plans {
		if _, err := tx.Exec(ctx, `
INSERT INTO audience_sync_run_attempts
       (tenant_id, run_id, sequence, attempt_kind, idempotency_key, payload_sha256, row_count)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
ON CONFLICT (tenant_id, run_id, sequence) DO NOTHING`,
			tenantID, runID, plan.Sequence, plan.Kind, plan.IdempotencyKey, plan.PayloadSHA256, plan.RowCount); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// beginDestinationOperation is the audience_destinations counterpart to
// beginSyncOperation. Crucially, it inserts audience_sync_jobs before source
// resolution or a provider call; the prior path inserted only after delivery.
func (r *Repo) beginDestinationOperation(ctx context.Context, tenantID, destinationID, operationKey string) (*destinationOperationClaim, error) {
	return r.beginDestinationOperationIfCurrent(ctx, tenantID, destinationID, operationKey, "")
}

func (r *Repo) beginDestinationOperationIfCurrent(ctx context.Context, tenantID, destinationID, operationKey, ifMatchToken string) (*destinationOperationClaim, error) {
	leaseOwner := uuid.NewString()
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var status Status
	var leaseActive bool
	var updatedAt time.Time
	err = tx.QueryRow(ctx, `
SELECT status, COALESCE(sync_lease_expires_at > now(), false), updated_at
  FROM audience_destinations
 WHERE tenant_id = $1::uuid AND id = $2::uuid
 FOR UPDATE`, tenantID, destinationID).Scan((*string)(&status), &leaseActive, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}

	existing, existingErr := scanSyncJob(tx.QueryRow(ctx, `
SELECT `+syncJobOperationSelect+`
  FROM audience_sync_jobs
 WHERE tenant_id = $1::uuid AND destination_id = $2::uuid AND operation_key = $3`,
		tenantID, destinationID, operationKey))
	if existingErr == nil {
		if existing.Status == RunStatusRunning && !leaseActive {
			existing, err = scanSyncJob(tx.QueryRow(ctx, `
UPDATE audience_sync_jobs
   SET status = 'needs_reconciliation',
       error = 'operation lease expired before a terminal provider acknowledgement; external effects require reconciliation',
       finished_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'running'
 RETURNING `+syncJobOperationSelect, tenantID, existing.ID))
			if err != nil {
				return nil, err
			}
			if _, err := tx.Exec(ctx, `
UPDATE audience_destinations
   SET status = 'error', sync_lease_owner = NULL,
       sync_lease_expires_at = NULL, sync_lease_operation_key = NULL,
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, destinationID); err != nil {
				return nil, err
			}
		}
		dest, err := scanDestination(tx.QueryRow(ctx, `SELECT `+destinationOperationSelect+` FROM audience_destinations WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, destinationID))
		if err != nil {
			return nil, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return &destinationOperationClaim{Destination: dest, Job: existing, OperationKey: operationKey, LeaseOwner: leaseOwner}, nil
	}
	if !errors.Is(existingErr, pgx.ErrNoRows) {
		return nil, existingErr
	}
	if ifMatchToken != "" && ifMatchToken != httpcache.ConcurrencyToken("audience-destination", destinationID, updatedAt) {
		return nil, ErrPreconditionFailed
	}
	if leaseActive {
		return nil, ErrOperationInProgress
	}
	if status != StatusActive && status != StatusError {
		return nil, fmt.Errorf("%w: audience destination is %s", ErrLifecycleBlocked, status)
	}

	if _, err := tx.Exec(ctx, `
UPDATE audience_destinations
   SET status = 'syncing', sync_lease_owner = $3::uuid,
       sync_lease_expires_at = now() + ($5::bigint * interval '1 millisecond'),
       sync_lease_operation_key = $4, updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, destinationID, leaseOwner, operationKey, operationLeaseDuration.Milliseconds()); err != nil {
		return nil, err
	}
	job, err := scanSyncJob(tx.QueryRow(ctx, `
INSERT INTO audience_sync_jobs
       (tenant_id, destination_id, status, operation_key, trigger_kind)
VALUES ($1::uuid, $2::uuid, 'running', $3, 'manual')
RETURNING `+syncJobOperationSelect, tenantID, destinationID, operationKey))
	if err != nil {
		return nil, err
	}
	dest, err := scanDestination(tx.QueryRow(ctx, `SELECT `+destinationOperationSelect+` FROM audience_destinations WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, destinationID))
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &destinationOperationClaim{Destination: dest, Job: job, OperationKey: operationKey, LeaseOwner: leaseOwner, Created: true}, nil
}

func (r *Repo) finishDestinationOperation(
	ctx context.Context,
	tenantID string,
	claim *destinationOperationClaim,
	status, errMsg string,
	membersSynced, sourceMembersObserved int,
	capExceeded bool,
	evidence ProviderRunEvidence,
) (*SyncJob, error) {
	evidence = evidence.truncated()
	schedule := providerDiagnosticsScheduleContext{
		Provider: string(claim.Destination.Provider),
		Config:   claim.Destination.AdapterConfig(),
	}
	providerStatus, providerNextCheck := initialProviderDiagnosticsSchedule(evidence, schedule)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var leaseMatches bool
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(sync_lease_owner::text,'') = $3
   AND COALESCE(sync_lease_operation_key,'') = $4
  FROM audience_destinations
 WHERE tenant_id = $1::uuid AND id = $2::uuid
 FOR UPDATE`, tenantID, claim.Destination.ID, claim.LeaseOwner, claim.OperationKey).Scan(&leaseMatches); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if !leaseMatches {
		return nil, ErrOperationLeaseLost
	}
	job, err := scanSyncJob(tx.QueryRow(ctx, `
UPDATE audience_sync_jobs
   SET status = $3, error = NULLIF($4,''), members_synced = $5,
       external_job_id = NULLIF($6,''), external_audience_id = NULLIF($7,''),
       provider_message = NULLIF($8,''), provider_status = NULLIF($9,''),
       provider_next_check_at = $10, source_members_observed = $11,
       cap_exceeded = $12, finished_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'running'
 RETURNING `+syncJobOperationSelect,
		tenantID, claim.Job.ID, status, boundedOperationError(errMsg), membersSynced,
		evidence.ExternalJobID, evidence.ExternalAudienceID, evidence.ProviderMessage,
		providerStatus, providerNextCheck, sourceMembersObserved, capExceeded))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrOperationLeaseLost
	}
	if err != nil {
		return nil, err
	}
	destinationStatus := StatusError
	if status == RunStatusSucceeded {
		destinationStatus = StatusActive
	}
	if _, err := tx.Exec(ctx, `
UPDATE audience_destinations
   SET status = $3,
       last_synced_at = CASE WHEN $4 THEN now() ELSE last_synced_at END,
       external_audience_id = COALESCE(NULLIF($5,''), external_audience_id),
       sync_lease_owner = NULL, sync_lease_expires_at = NULL,
       sync_lease_operation_key = NULL, updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, claim.Destination.ID, destinationStatus, status == RunStatusSucceeded, evidence.ExternalAudienceID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return job, nil
}

func (r *Repo) planJobAttempt(ctx context.Context, tenantID, jobID string, plan operationAttemptPlan) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO audience_sync_job_attempts
       (tenant_id, job_id, sequence, attempt_kind, idempotency_key, payload_sha256, row_count)
VALUES ($1::uuid, $2::uuid, $3, 'provider_operation', $4, $5, $6)
ON CONFLICT (tenant_id, job_id, sequence) DO NOTHING`,
		tenantID, jobID, plan.Sequence, plan.IdempotencyKey, plan.PayloadSHA256, plan.RowCount); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *Repo) markJobAttemptDelivering(ctx context.Context, tenantID, jobID string, sequence int) error {
	return r.updateAttempt(ctx, tenantID, "audience_sync_job_attempts", "job_id", jobID, sequence, "delivering", "")
}

func (r *Repo) finishJobAttempt(ctx context.Context, tenantID, jobID string, sequence int, acknowledged bool, errMsg string) error {
	status := "ambiguous"
	if acknowledged {
		status = "acknowledged"
	}
	return r.updateAttempt(ctx, tenantID, "audience_sync_job_attempts", "job_id", jobID, sequence, status, errMsg)
}

func (r *Repo) markRunAttemptDelivering(ctx context.Context, tenantID, runID string, sequence int) error {
	return r.updateAttempt(ctx, tenantID, "audience_sync_run_attempts", "run_id", runID, sequence, "delivering", "")
}

func (r *Repo) finishRunAttempt(ctx context.Context, tenantID, runID string, sequence int, acknowledged bool, errMsg string) error {
	status := "ambiguous"
	if acknowledged {
		status = "acknowledged"
	}
	return r.updateAttempt(ctx, tenantID, "audience_sync_run_attempts", "run_id", runID, sequence, status, errMsg)
}

func (r *Repo) updateAttempt(ctx context.Context, tenantID, table, parentColumn, parentID string, sequence int, status, errMsg string) error {
	if table != "audience_sync_run_attempts" && table != "audience_sync_job_attempts" {
		return errors.New("audience_destinations: invalid attempt table")
	}
	if parentColumn != "run_id" && parentColumn != "job_id" {
		return errors.New("audience_destinations: invalid attempt parent")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	query := `UPDATE ` + table + `
   SET status = $4,
       attempts = CASE WHEN $4 = 'delivering' THEN attempts + 1 ELSE attempts END,
       started_at = CASE WHEN $4 = 'delivering' THEN now() ELSE started_at END,
       acknowledged_at = CASE WHEN $4 = 'acknowledged' THEN now() ELSE acknowledged_at END,
       last_error = NULLIF($5,''), updated_at = now()
 WHERE tenant_id = $1::uuid AND ` + parentColumn + ` = $2::uuid AND sequence = $3`
	tag, err := tx.Exec(ctx, query, tenantID, parentID, sequence, status, boundedOperationError(errMsg))
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrOperationLeaseLost
	}
	return tx.Commit(ctx)
}

func membersPayloadSHA256(members []MemberRow) string {
	h := sha256.New()
	for _, member := range members {
		_, _ = h.Write([]byte(strings.ToLower(strings.TrimSpace(member.Email))))
		_, _ = h.Write([]byte{0})
		_, _ = h.Write([]byte(member.Status))
		_, _ = h.Write([]byte{0})
		for _, tag := range member.Tags {
			_, _ = h.Write([]byte(tag))
			_, _ = h.Write([]byte{0})
		}
	}
	return hex.EncodeToString(h.Sum(nil))
}

func payloadSHA256(payload []byte) string {
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}
