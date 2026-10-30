// SPDX-License-Identifier: AGPL-3.0-only
package pii_scanner

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Tenant coverage reconciliation: leased reconciliation claims, the
// ReconcileTenant sweep, coverage aggregation and reconciliation requests.
// Scan-intent claiming, snapshot loading and scan completion stay in
// coverage_repo.go.

type reconciliationLease struct {
	TenantID     string
	Generation   int64
	OwnerID      string
	Token        string
	ScanContract string
}

func (r *Repo) ClaimReconciliations(ctx context.Context, ownerID string, ttl time.Duration, limit int, expectedScanContract string) ([]reconciliationLease, error) {
	owner, err := uuid.Parse(strings.TrimSpace(ownerID))
	if err != nil {
		return nil, ErrInvalidInput
	}
	expectedScanContract, err = requiredCoverageScanContract(expectedScanContract)
	if err != nil {
		return nil, err
	}
	ttl = normalizeLeaseTTL(ttl)
	if limit < 1 {
		limit = 4
	}
	if limit > 20 {
		limit = 20
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
WITH candidates AS (
    SELECT coverage.tenant_id
      FROM tenant_pii_scan_coverage coverage
     WHERE coverage.scan_enabled
       AND coverage.status <> 'unavailable'
	   AND coverage.scan_contract = $4
       AND (NOT coverage.snapshot_exact OR coverage.reconciliation_requested_at IS NOT NULL)
       AND (coverage.reconcile_lease_expires_at IS NULL OR coverage.reconcile_lease_expires_at <= now())
	       -- A persisted cursor means current-profile seeding still has pages and must
       -- continue. Once seeding is complete, defer another O(N) aggregate
       -- while ordinary pending/leased work is draining; the final completion
       -- dirties coverage and the next empty-queue pass publishes exact counts.
	   AND (
	       coverage.seeded_generation < coverage.generation
	       OR coverage.reconcile_cursor IS NOT NULL
	       OR NOT EXISTS (
               SELECT 1
                 FROM subscriber_pii_scan_intents intent
                WHERE intent.tenant_id = coverage.tenant_id
                  AND intent.status IN ('pending', 'leased')
           )
       )
     ORDER BY COALESCE(coverage.reconciliation_requested_at, coverage.updated_at), coverage.tenant_id
     FOR UPDATE SKIP LOCKED
     LIMIT $3
), claimed AS (
    UPDATE tenant_pii_scan_coverage coverage
       SET reconcile_lease_owner = $1::uuid,
           reconcile_lease_token = gen_random_uuid(),
           reconcile_lease_expires_at = now() + ($2::bigint * interval '1 millisecond'),
           status = 'backfilling',
           backfill_started_at = COALESCE(backfill_started_at, now()),
           updated_at = now()
      FROM candidates
     WHERE coverage.tenant_id = candidates.tenant_id
    RETURNING coverage.tenant_id::text, coverage.generation,
              coverage.reconcile_lease_token::text
)
SELECT * FROM claimed`, owner.String(), ttl.Milliseconds(), limit, expectedScanContract)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	leases := []reconciliationLease{}
	for rows.Next() {
		var lease reconciliationLease
		lease.OwnerID = owner.String()
		lease.ScanContract = expectedScanContract
		if err := rows.Scan(&lease.TenantID, &lease.Generation, &lease.Token); err != nil {
			return nil, err
		}
		leases = append(leases, lease)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return leases, nil
}

func (r *Repo) RenewReconciliationLease(ctx context.Context, lease reconciliationLease, ttl time.Duration) error {
	if _, err := uuid.Parse(lease.TenantID); err != nil {
		return ErrInvalidInput
	}
	if _, err := uuid.Parse(lease.OwnerID); err != nil {
		return ErrInvalidInput
	}
	if _, err := uuid.Parse(lease.Token); err != nil || lease.Generation < 0 {
		return ErrInvalidInput
	}
	if _, err := requiredCoverageScanContract(lease.ScanContract); err != nil {
		return err
	}
	ttl = normalizeLeaseTTL(ttl)
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	cmd, err := tx.Exec(ctx, `
UPDATE tenant_pii_scan_coverage
   SET reconcile_lease_expires_at = now() + ($6::bigint * interval '1 millisecond'),
       updated_at = now()
 WHERE tenant_id = $1::uuid AND scan_enabled AND status <> 'unavailable'
   AND reconcile_lease_owner = $2::uuid AND reconcile_lease_token = $3::uuid
   AND generation = $4 AND scan_contract = $5
   AND reconcile_lease_expires_at > now()`, lease.TenantID, lease.OwnerID,
		lease.Token, lease.Generation, lease.ScanContract, ttl.Milliseconds())
	if err != nil {
		return err
	}
	if cmd.RowsAffected() != 1 {
		return ErrLeaseLost
	}
	return tx.Commit(ctx)
}

// ReleaseReconciliationLease returns a failed/timed-out page to the durable
// queue without waiting for lease expiry. Exact token, generation, and
// executable-contract checks make a late worker unable to release a newer
// owner's work.
func (r *Repo) ReleaseReconciliationLease(ctx context.Context, lease reconciliationLease) error {
	if _, err := uuid.Parse(lease.TenantID); err != nil {
		return ErrInvalidInput
	}
	if _, err := uuid.Parse(lease.OwnerID); err != nil {
		return ErrInvalidInput
	}
	if _, err := uuid.Parse(lease.Token); err != nil || lease.Generation < 0 {
		return ErrInvalidInput
	}
	if _, err := requiredCoverageScanContract(lease.ScanContract); err != nil {
		return err
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	cmd, err := tx.Exec(ctx, `
UPDATE tenant_pii_scan_coverage
   SET status = CASE WHEN scan_enabled THEN 'backfill_pending' ELSE 'disabled' END,
       snapshot_exact = false,
       reconciliation_requested_at = CASE WHEN scan_enabled THEN now() ELSE reconciliation_requested_at END,
       reconcile_lease_owner = NULL, reconcile_lease_token = NULL,
       reconcile_lease_expires_at = NULL, updated_at = now()
 WHERE tenant_id = $1::uuid
   AND reconcile_lease_owner = $2::uuid AND reconcile_lease_token = $3::uuid
   AND generation = $4 AND scan_contract = $5`, lease.TenantID, lease.OwnerID,
		lease.Token, lease.Generation, lease.ScanContract)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() != 1 {
		return ErrLeaseLost
	}
	return tx.Commit(ctx)
}

func (r *Repo) ReconcileTenant(ctx context.Context, lease reconciliationLease, limit int) (*CoverageSnapshot, error) {
	if _, err := uuid.Parse(lease.TenantID); err != nil {
		return nil, ErrInvalidInput
	}
	if _, err := uuid.Parse(lease.OwnerID); err != nil {
		return nil, ErrInvalidInput
	}
	if _, err := uuid.Parse(lease.Token); err != nil || lease.Generation < 0 {
		return nil, ErrInvalidInput
	}
	if _, err := requiredCoverageScanContract(lease.ScanContract); err != nil {
		return nil, err
	}
	fingerprintScheme, fingerprintKeyVersion, ok := coverageFingerprintIdentity(lease.ScanContract)
	if !ok {
		return nil, ErrInvalidInput
	}
	if limit < 1 {
		limit = 200
	}
	if limit > MaxReconcileBatch {
		limit = MaxReconcileBatch
	}
	tx, err := db.WithTenant(ctx, r.Pool, lease.TenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if deadline, ok := ctx.Deadline(); ok {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return nil, context.DeadlineExceeded
		}
		if _, err := tx.Exec(ctx, `SELECT set_config('statement_timeout', $1, true)`,
			fmt.Sprintf("%dms", max(1, remaining.Milliseconds()))); err != nil {
			return nil, err
		}
	}
	var enabled bool
	var generation int64
	var cursor *string
	if err := tx.QueryRow(ctx, `
SELECT scan_enabled, generation, reconcile_cursor::text
  FROM tenant_pii_scan_coverage
 WHERE tenant_id = $1::uuid AND reconcile_lease_owner = $2::uuid
   AND reconcile_lease_token = $3::uuid AND generation = $4
	AND scan_contract = $5
	   AND reconcile_lease_expires_at > now()`, lease.TenantID, lease.OwnerID,
		lease.Token, lease.Generation, lease.ScanContract).Scan(&enabled, &generation, &cursor); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrLeaseLost
		}
		return nil, err
	}
	if !enabled {
		if _, err := tx.Exec(ctx, `
UPDATE tenant_pii_scan_coverage
   SET status = 'disabled', reconcile_lease_owner = NULL,
       reconcile_lease_token = NULL, reconcile_lease_expires_at = NULL,
       reconcile_cursor = NULL, updated_at = now()
 WHERE tenant_id = $1::uuid AND reconcile_lease_owner = $2::uuid
   AND reconcile_lease_token = $3::uuid AND generation = $4
   AND reconcile_lease_expires_at > now()`, lease.TenantID, lease.OwnerID,
			lease.Token, lease.Generation); err != nil {
			return nil, err
		}
		return &CoverageSnapshot{Generation: generation, Status: "disabled"}, tx.Commit(ctx)
	}

	rows, err := tx.Query(ctx, `
SELECT subscriber.id::text, GREATEST(subscriber.pii_scan_revision, 1)
  FROM subscribers subscriber
  LEFT JOIN subscriber_pii_scan_states state
    ON state.tenant_id = subscriber.tenant_id
   AND state.subscriber_id = subscriber.id
  LEFT JOIN subscriber_pii_scan_intents intent
    ON intent.tenant_id = subscriber.tenant_id
   AND intent.subscriber_id = subscriber.id
 WHERE subscriber.tenant_id = $1::uuid
   AND subscriber.id > COALESCE($11::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
   AND (
       state.subscriber_id IS NULL
       OR state.observed_revision < GREATEST(subscriber.pii_scan_revision, 1)
       OR (
           intent.subscriber_id IS NULL
           AND state.state NOT IN ('dead_letter', 'truncated')
           AND (
               state.scanned_revision < GREATEST(subscriber.pii_scan_revision, 1)
               OR state.scanned_generation < $2
               OR state.scanner_name IS DISTINCT FROM $3
               OR state.scanner_version IS DISTINCT FROM $4
               OR state.detector_name IS DISTINCT FROM $5
               OR state.detector_version IS DISTINCT FROM $6
               OR state.policy_name IS DISTINCT FROM $7
               OR state.policy_version IS DISTINCT FROM $8
	           OR ($9 <> '' AND state.fingerprint_scheme IS DISTINCT FROM $9)
	           OR ($10 <> '' AND state.fingerprint_key_version IS DISTINCT FROM $10)
           )
       )
       OR (
           intent.status = 'dead_letter'
           AND intent.target_generation < $2
       )
   )
   AND NOT COALESCE(
       intent.status = 'leased' AND intent.lease_expires_at > now(),
       false
   )
 ORDER BY subscriber.id
 LIMIT $12
 FOR KEY SHARE OF subscriber`, lease.TenantID, generation, ScannerName, ScannerVersion,
		DetectorName, DetectorVersion, PolicyName, PolicyVersion,
		fingerprintScheme, fingerprintKeyVersion, cursor, limit)
	if err != nil {
		return nil, err
	}
	type candidate struct {
		id       string
		revision int64
	}
	candidates := []candidate{}
	for rows.Next() {
		var candidate candidate
		if err := rows.Scan(&candidate.id, &candidate.revision); err != nil {
			rows.Close()
			return nil, err
		}
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(candidates) > 0 {
		ids := make([]string, 0, len(candidates))
		revisions := make([]int64, 0, len(candidates))
		for _, candidate := range candidates {
			ids = append(ids, candidate.id)
			revisions = append(revisions, candidate.revision)
		}
		// Keep the mutation lock order identical to the subscriber statement
		// trigger: intent -> state -> tenant coverage.
		if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_pii_scan_intents (
    tenant_id, subscriber_id, target_revision, target_generation,
    status, attempts, available_at, last_enqueued_at
)
SELECT $1::uuid, candidate.id, candidate.revision, $4,
       'pending', 0, now(), now()
  FROM unnest($2::uuid[], $3::bigint[]) AS candidate(id, revision)
ON CONFLICT (tenant_id, subscriber_id) DO UPDATE SET
    target_revision = GREATEST(subscriber_pii_scan_intents.target_revision, EXCLUDED.target_revision),
    target_generation = GREATEST(subscriber_pii_scan_intents.target_generation, EXCLUDED.target_generation),
    status = CASE WHEN subscriber_pii_scan_intents.status = 'leased' THEN 'leased' ELSE 'pending' END,
    attempts = CASE WHEN subscriber_pii_scan_intents.status = 'leased' THEN subscriber_pii_scan_intents.attempts ELSE 0 END,
    available_at = CASE WHEN subscriber_pii_scan_intents.status = 'leased' THEN subscriber_pii_scan_intents.available_at ELSE now() END,
    lease_owner = CASE WHEN subscriber_pii_scan_intents.status = 'leased' THEN subscriber_pii_scan_intents.lease_owner ELSE NULL END,
    lease_token = CASE WHEN subscriber_pii_scan_intents.status = 'leased' THEN subscriber_pii_scan_intents.lease_token ELSE NULL END,
    lease_expires_at = CASE WHEN subscriber_pii_scan_intents.status = 'leased' THEN subscriber_pii_scan_intents.lease_expires_at ELSE NULL END,
    claimed_revision = CASE WHEN subscriber_pii_scan_intents.status = 'leased' THEN subscriber_pii_scan_intents.claimed_revision ELSE NULL END,
    claimed_generation = CASE WHEN subscriber_pii_scan_intents.status = 'leased' THEN subscriber_pii_scan_intents.claimed_generation ELSE NULL END,
    last_error_code = NULL, dead_lettered_at = NULL,
    last_enqueued_at = now(), updated_at = now()`,
			lease.TenantID, ids, revisions, generation); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_pii_scan_states (
    tenant_id, subscriber_id, observed_revision, state, last_observed_at
)
SELECT $1::uuid, candidate.id, candidate.revision, 'pending', now()
  FROM unnest($2::uuid[], $3::bigint[]) AS candidate(id, revision)
ON CONFLICT (tenant_id, subscriber_id) DO UPDATE SET
    observed_revision = GREATEST(subscriber_pii_scan_states.observed_revision, EXCLUDED.observed_revision),
    state = CASE WHEN subscriber_pii_scan_states.state = 'leased' THEN 'leased' ELSE 'pending' END,
    last_observed_at = GREATEST(subscriber_pii_scan_states.last_observed_at, now()),
    last_error_code = CASE WHEN subscriber_pii_scan_states.state = 'leased' THEN subscriber_pii_scan_states.last_error_code ELSE NULL END,
    updated_at = now()`, lease.TenantID, ids, revisions); err != nil {
			return nil, err
		}
	}

	// Full batches persist only the high-water cursor and release the exact
	// token. This makes current-profile seeding O(N) with bounded transactions; the
	// one full aggregate runs only after the final (short) page.
	if len(candidates) == limit {
		lastID := candidates[len(candidates)-1].id
		cmd, err := tx.Exec(ctx, `
UPDATE tenant_pii_scan_coverage
   SET status = 'backfilling', snapshot_exact = false,
       dirty_epoch = dirty_epoch + 1,
       reconcile_cursor = $2::uuid,
       reconciliation_requested_at = now(),
       reconcile_lease_owner = NULL, reconcile_lease_token = NULL,
       reconcile_lease_expires_at = NULL, updated_at = now()
 WHERE tenant_id = $1::uuid AND reconcile_lease_owner = $3::uuid
   AND reconcile_lease_token = $4::uuid AND generation = $5
   AND reconcile_lease_expires_at > now()`, lease.TenantID, lastID,
			lease.OwnerID, lease.Token, generation)
		if err != nil {
			return nil, err
		}
		if cmd.RowsAffected() != 1 {
			return nil, ErrLeaseLost
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return &CoverageSnapshot{Generation: generation, Status: "backfilling", SnapshotExact: false}, nil
	}

	// Serialize only the final aggregate. Subscriber writers mutate
	// intent->state first and coverage last; a writer already in flight is either
	// visible before this lock or commits snapshot_exact=false after it.
	var exactLease bool
	if err := tx.QueryRow(ctx, `
SELECT true
  FROM tenant_pii_scan_coverage
 WHERE tenant_id = $1::uuid AND scan_enabled
   AND reconcile_lease_owner = $2::uuid AND reconcile_lease_token = $3::uuid
   AND generation = $4 AND reconcile_lease_expires_at > now()
 FOR UPDATE`, lease.TenantID, lease.OwnerID, lease.Token, generation).Scan(&exactLease); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrLeaseLost
		}
		return nil, err
	}

	snapshot, err := aggregateCoverageTx(
		ctx, tx, lease.TenantID, generation, fingerprintScheme, fingerprintKeyVersion,
	)
	if err != nil {
		return nil, err
	}
	status := "catching_up"
	if snapshot.DeadLetterSubscribers > 0 || snapshot.TruncatedSubscribers > 0 {
		status = "degraded"
	} else if snapshot.CoveredSubscribers == snapshot.TotalSubscribers &&
		snapshot.PendingSubscribers == 0 && snapshot.RetryingSubscribers == 0 &&
		snapshot.MissingStateSubscribers == 0 {
		status = "caught_up"
	}
	snapshot.Status = status
	snapshot.SnapshotExact = true
	cmd, err := tx.Exec(ctx, `
UPDATE tenant_pii_scan_coverage
   SET status = $2,
       snapshot_exact = true,
	   seeded_generation = $14,
       dirty_epoch = dirty_epoch + 1,
       total_subscribers = $3,
       covered_subscribers = $4,
       pending_subscribers = $5,
       retrying_subscribers = $6,
       dead_letter_subscribers = $7,
       truncated_subscribers = $8,
       missing_state_subscribers = $9,
       coalesced_revisions = $10,
       oldest_pending_at = $11,
       reconciliation_requested_at = NULL,
       last_reconciled_at = now(),
       backfill_completed_at = CASE WHEN $2 = 'caught_up' THEN now() ELSE NULL END,
       reconcile_lease_owner = NULL,
       reconcile_lease_token = NULL,
       reconcile_lease_expires_at = NULL,
       reconcile_cursor = NULL,
       updated_at = now()
 WHERE tenant_id = $1::uuid AND reconcile_lease_owner = $12::uuid
   AND reconcile_lease_token = $13::uuid AND generation = $14
   AND reconcile_lease_expires_at > now()`,
		lease.TenantID, status, snapshot.TotalSubscribers, snapshot.CoveredSubscribers,
		snapshot.PendingSubscribers, snapshot.RetryingSubscribers,
		snapshot.DeadLetterSubscribers, snapshot.TruncatedSubscribers,
		snapshot.MissingStateSubscribers, snapshot.CoalescedRevisions,
		snapshot.OldestPendingAt, lease.OwnerID, lease.Token, generation)
	if err != nil {
		return nil, err
	}
	if cmd.RowsAffected() != 1 {
		return nil, ErrLeaseLost
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	snapshot.LastReconciledAt = &now
	return snapshot, nil
}

func aggregateCoverageTx(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	generation int64,
	fingerprintScheme string,
	fingerprintKeyVersion string,
) (*CoverageSnapshot, error) {
	var snapshot CoverageSnapshot
	snapshot.Generation = generation
	err := tx.QueryRow(ctx, `
WITH rows AS (
    SELECT subscriber.id,
           GREATEST(subscriber.pii_scan_revision, 1) AS pii_scan_revision,
           state.subscriber_id AS state_id,
           state.observed_revision,
           state.scanned_revision,
           state.scanned_generation,
           state.state,
           state.coalesced_revisions,
           state.scanner_name, state.scanner_version,
           state.detector_name, state.detector_version,
           state.policy_name, state.policy_version,
	       state.fingerprint_scheme, state.fingerprint_key_version,
           intent.status AS intent_status,
           intent.first_enqueued_at
      FROM subscribers subscriber
      LEFT JOIN subscriber_pii_scan_states state
        ON state.tenant_id = subscriber.tenant_id
       AND state.subscriber_id = subscriber.id
      LEFT JOIN subscriber_pii_scan_intents intent
        ON intent.tenant_id = subscriber.tenant_id
       AND intent.subscriber_id = subscriber.id
     WHERE subscriber.tenant_id = $1::uuid
), classified AS (
    SELECT *,
           (state_id IS NOT NULL
            AND scanned_revision >= pii_scan_revision
            AND scanned_generation >= $2
            AND state IN ('scanned', 'findings')
            AND scanner_name = $3 AND scanner_version = $4
            AND detector_name = $5 AND detector_version = $6
	        AND policy_name = $7 AND policy_version = $8
	        AND ($9 = '' OR (
	            fingerprint_scheme = $9 AND fingerprint_key_version = $10
	        ))) AS covered
      FROM rows
)
SELECT count(*)::bigint,
       count(*) FILTER (WHERE covered)::bigint,
       count(*) FILTER (
           WHERE NOT covered
             AND COALESCE(intent_status, '') NOT IN ('retry_wait', 'dead_letter')
             AND COALESCE(state, '') NOT IN ('retry_wait', 'dead_letter', 'truncated')
       )::bigint,
       count(*) FILTER (WHERE intent_status = 'retry_wait' OR state = 'retry_wait')::bigint,
       count(*) FILTER (WHERE intent_status = 'dead_letter' AND state = 'dead_letter')::bigint,
       count(*) FILTER (WHERE state = 'truncated')::bigint,
       count(*) FILTER (WHERE state_id IS NULL)::bigint,
       COALESCE(sum(coalesced_revisions), 0)::bigint,
       min(first_enqueued_at) FILTER (WHERE NOT covered)
  FROM classified`, tenantID, generation, ScannerName, ScannerVersion,
		DetectorName, DetectorVersion, PolicyName, PolicyVersion,
		fingerprintScheme, fingerprintKeyVersion).Scan(
		&snapshot.TotalSubscribers, &snapshot.CoveredSubscribers,
		&snapshot.PendingSubscribers, &snapshot.RetryingSubscribers,
		&snapshot.DeadLetterSubscribers, &snapshot.TruncatedSubscribers,
		&snapshot.MissingStateSubscribers, &snapshot.CoalescedRevisions,
		&snapshot.OldestPendingAt,
	)
	return &snapshot, err
}

func (r *Repo) getCoverageTx(ctx context.Context, tx pgx.Tx, tenantID string) (*CoverageSnapshot, error) {
	var snapshot CoverageSnapshot
	err := tx.QueryRow(ctx, `
SELECT COALESCE(scan_contract, ''), generation, status, snapshot_exact,
       total_subscribers, covered_subscribers, pending_subscribers,
       retrying_subscribers, dead_letter_subscribers,
       truncated_subscribers, missing_state_subscribers, coalesced_revisions,
       oldest_pending_at, enable_requested_at, backfill_started_at,
       backfill_completed_at, reconciliation_requested_at,
       last_reconciled_at, last_observed_at, last_scanned_at
  FROM tenant_pii_scan_coverage
 WHERE tenant_id = $1::uuid`, tenantID).Scan(
		&snapshot.ScanContract, &snapshot.Generation, &snapshot.Status, &snapshot.SnapshotExact,
		&snapshot.TotalSubscribers, &snapshot.CoveredSubscribers,
		&snapshot.PendingSubscribers, &snapshot.RetryingSubscribers,
		&snapshot.DeadLetterSubscribers, &snapshot.TruncatedSubscribers,
		&snapshot.MissingStateSubscribers, &snapshot.CoalescedRevisions,
		&snapshot.OldestPendingAt, &snapshot.EnableRequestedAt,
		&snapshot.BackfillStartedAt, &snapshot.BackfillCompletedAt,
		&snapshot.ReconciliationRequestedAt, &snapshot.LastReconciledAt,
		&snapshot.LastObservedAt, &snapshot.LastScannedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &snapshot, err
}

func (r *Repo) RequestReconciliation(ctx context.Context, tenantID string) (int64, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	cmd, err := tx.Exec(ctx, `
UPDATE tenant_pii_scan_coverage
   SET snapshot_exact = false,
       status = CASE WHEN scan_enabled THEN 'backfill_pending' ELSE 'disabled' END,
	   seeded_generation = CASE
	       WHEN scan_enabled AND generation > 0 THEN generation - 1
	       ELSE seeded_generation
	   END,
       reconciliation_requested_at = CASE WHEN scan_enabled THEN now() ELSE reconciliation_requested_at END,
       reconcile_cursor = CASE WHEN scan_enabled THEN NULL ELSE reconcile_cursor END,
       reconcile_lease_owner = NULL, reconcile_lease_token = NULL,
       reconcile_lease_expires_at = NULL,
       updated_at = now()
 WHERE tenant_id = $1::uuid`, tenantID)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return cmd.RowsAffected(), nil
}
