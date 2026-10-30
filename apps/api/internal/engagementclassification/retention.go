// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type TenantRetentionResult struct {
	TenantID            string
	Deleted             int
	ObjectBackedBlocked bool
}

type RetentionSweepResult struct {
	TenantCount int
	Deleted     int
	// Degraded counts rows reduced to the second tier — headers, IP and JA4
	// cleared, ASN retained. Reported separately from Deleted because they are
	// different outcomes: a degraded row can still be reclassified, a deleted one
	// cannot, and an operator reading one number would not know which happened.
	Degraded int64
	// StageTwoPruned counts SETTLED Stage-2 schedule rows reaped. Counted apart
	// from Deleted because it is a different table with different semantics:
	// Deleted destroys evidence past its privacy expiry, this only discards a
	// reminder whose verdicts and run counters both outlive it.
	StageTwoPruned             int64
	ObjectBackedBlockedTenants int
	NextTenantCursor           string
}

// RetentionWorker walks tenants through the existing resolver capability,
// then narrows every evidence read/delete to an independent tenant-worker
// transaction. Both dimensions are bounded. It deliberately never deletes an
// object-backed observation: until an exact-version object adapter is composed,
// retaining the DB pointer is safer than orphaning external PII.
type RetentionWorker struct {
	Repo                 *Repo
	Interval             time.Duration
	TenantBatchSize      int
	ObservationBatchSize int
	// FullFidelityWindow is the PRD's first tier: how long raw events keep their
	// fingerprinting columns. Past it, rows are degraded rather than deleted.
	//
	// Zero means the default rather than "degrade everything immediately" — a
	// zero-value window on a struct somebody forgot to fill would otherwise strip
	// every observation in the system on the next tick.
	FullFidelityWindow time.Duration
	// StageTwoRetention is how long a SETTLED Stage-2 schedule row is kept after
	// it completed or failed. Zero means the default, for the same reason as
	// above: a struct nobody filled in must not reap the schedule immediately.
	StageTwoRetention time.Duration
}

// DefaultFullFidelityWindow is the PRD's 90 days.
const DefaultFullFidelityWindow = 90 * 24 * time.Hour

const (
	// DefaultStageTwoRetention keeps a settled schedule row for six months.
	DefaultStageTwoRetention = 180 * 24 * time.Hour
	// minimumStageTwoRetention is deliberately longer than the LONGEST
	// permissible conversion window. Both stages of a message must be able to
	// settle before either of its rows becomes eligible, or a straggler event
	// arriving after the 'delayed' row was reaped would re-arm a schedule whose
	// sibling window-close row is still pending.
	//
	// This comment previously claimed the re-arm was "harmless, because the
	// deterministic run id finds the completed run and closes the new row
	// without appending a verdict". That was FALSE TWICE OVER and is recorded
	// here rather than deleted, because the same wrong model was written into
	// migration 1967 and would be re-derived by the next reader otherwise.
	//
	// It was false before the fix: a re-armed row carries a NEW first_event_at,
	// so the reclassification WINDOW changed while the run id did not — the id
	// omitted the window entirely — which produced ErrIdempotencyConflict, and
	// the straggler's evidence never received a Stage-2 verdict at all. Silently:
	// the conflict branch returns (result, nil), so the sweep reported success.
	//
	// It is false after the fix for the opposite reason: stageTwoRunRequestID now
	// covers the window, so a genuinely different window IS a different run. The
	// re-arm appends a verdict, on purpose — that is how the straggler's evidence
	// gets classified. The floor still earns its place by keeping the re-arm rare
	// rather than by making it a no-op.
	minimumStageTwoRetention = maximumStageTwoConversionWindow + 24*time.Hour
	maximumStageTwoRetention = 10 * 365 * 24 * time.Hour
)

func (worker *RetentionWorker) fullFidelityWindow() time.Duration {
	if worker.FullFidelityWindow > 0 {
		return worker.FullFidelityWindow
	}
	return DefaultFullFidelityWindow
}

func (worker *RetentionWorker) stageTwoRetention() time.Duration {
	if worker.StageTwoRetention > 0 {
		return worker.StageTwoRetention
	}
	return DefaultStageTwoRetention
}

func (worker *RetentionWorker) validate() error {
	if worker == nil || worker.Repo == nil || worker.Repo.Pool == nil {
		return fmt.Errorf("%w: retention repository is required", ErrInvalidInput)
	}
	if worker.Interval < 10*time.Second || worker.Interval > time.Hour ||
		worker.TenantBatchSize < 1 || worker.TenantBatchSize > 1000 ||
		worker.ObservationBatchSize < 1 || worker.ObservationBatchSize > 1000 {
		return fmt.Errorf("%w: retention schedule or batch bound is invalid", ErrInvalidInput)
	}
	if worker.StageTwoRetention != 0 &&
		(worker.StageTwoRetention < minimumStageTwoRetention ||
			worker.StageTwoRetention > maximumStageTwoRetention) {
		return fmt.Errorf("%w: stage two schedule retention is outside 91d..10y", ErrInvalidInput)
	}
	return nil
}

func (worker *RetentionWorker) SweepOnce(
	ctx context.Context,
	afterTenantID string,
) (RetentionSweepResult, error) {
	if err := worker.validate(); err != nil {
		return RetentionSweepResult{}, err
	}
	afterTenantID = strings.TrimSpace(afterTenantID)
	if afterTenantID != "" {
		if _, err := uuid.Parse(afterTenantID); err != nil {
			return RetentionSweepResult{}, fmt.Errorf("%w: retention tenant cursor is invalid", ErrInvalidInput)
		}
	}
	tenants, err := worker.listTenantPage(ctx, afterTenantID)
	if err != nil {
		return RetentionSweepResult{}, err
	}
	result := RetentionSweepResult{}
	previousCursor := afterTenantID
	// One failing tenant may not stop the sweep, for exactly the reason the
	// Stage-2 sweep states: tenants are visited in a stable id order, so aborting
	// at the first error parks every tenant that sorts after it behind a problem
	// that is not theirs.
	//
	// It matters more here than there. This is the privacy path — degradation
	// strips fingerprinting columns at the full-fidelity boundary and the purge
	// deletes past privacy expiry — so a sweep that aborts on tenant N leaves
	// every later tenant's expired personal data in place, silently, for as long
	// as tenant N keeps failing. A stalled classification is a worse number; a
	// stalled purge is a retention promise the product is no longer keeping.
	failures := make([]error, 0, 4)
	for _, tenantID := range tenants {
		// Degrade BEFORE purging.
		//
		// The two tiers act on different populations — degradation on rows past
		// the full-fidelity window, purging on rows past their privacy expiry —
		// but running the purge first would delete rows that should have been
		// degraded and kept if an operator later shortens the privacy window.
		// Degrading first means a row is always reduced before it is ever removed.
		degraded, err := worker.Repo.DegradeObservationBatch(
			ctx, tenantID, worker.fullFidelityWindow(), worker.ObservationBatchSize,
		)
		if err != nil {
			failures = append(failures, fmt.Errorf("degrade engagement observations for tenant %s: %w", tenantID, err))
			if ctx.Err() != nil {
				return result, errors.Join(failures...)
			}
			previousCursor = tenantID
			result.TenantCount++
			result.NextTenantCursor = tenantID
			continue
		}
		result.Degraded += degraded

		// The Stage-2 schedule is on the same clock as the evidence it schedules
		// against. Reaped BEFORE the purge for the same ordering reason the
		// degrade runs first: this is the cheapest, most conservative tier, and
		// running it under the same tenant transaction budget keeps the sweep's
		// per-tenant cost bounded whichever tier has work to do.
		pruned, err := worker.Repo.PruneStageTwoEvaluationBatch(
			ctx, tenantID, worker.stageTwoRetention(), worker.ObservationBatchSize,
		)
		if err != nil {
			failures = append(failures, fmt.Errorf("prune engagement stage two schedule for tenant %s: %w", tenantID, err))
			if ctx.Err() != nil {
				return result, errors.Join(failures...)
			}
			previousCursor = tenantID
			result.TenantCount++
			result.NextTenantCursor = tenantID
			continue
		}
		result.StageTwoPruned += pruned

		tenantResult, err := worker.Repo.PurgeExpiredObservationBatch(
			ctx, tenantID, worker.ObservationBatchSize,
		)
		if err != nil {
			failures = append(failures, fmt.Errorf("sweep engagement observations for tenant %s: %w", tenantID, err))
			if ctx.Err() != nil {
				return result, errors.Join(failures...)
			}
			previousCursor = tenantID
			result.TenantCount++
			result.NextTenantCursor = tenantID
			continue
		}
		result.TenantCount++
		result.Deleted += tenantResult.Deleted
		if tenantResult.ObjectBackedBlocked {
			result.ObjectBackedBlockedTenants++
		}
		if tenantResult.Deleted == worker.ObservationBatchSize {
			// Retain the preceding cursor so this tenant is revisited next tick
			// rather than skipped with more expired rows still queued.
			result.NextTenantCursor = previousCursor
			return result, errors.Join(failures...)
		}
		previousCursor = tenantID
		result.NextTenantCursor = tenantID
	}
	if len(tenants) < worker.TenantBatchSize {
		// End of keyspace: wrap on the next tick. No durable correctness state
		// lives in this cursor; every deletion is idempotent in PostgreSQL.
		result.NextTenantCursor = ""
	}
	return result, errors.Join(failures...)
}

func (worker *RetentionWorker) listTenantPage(
	ctx context.Context,
	afterTenantID string,
) ([]string, error) {
	tx, err := db.WithTenantResolver(ctx, worker.Repo.Pool)
	if err != nil {
		return nil, fmt.Errorf("open engagement retention tenant resolver: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text
  FROM tenants
 WHERE ($1 = '' OR id::text > $1)
 ORDER BY id
 LIMIT $2`, afterTenantID, worker.TenantBatchSize)
	if err != nil {
		return nil, fmt.Errorf("list engagement retention tenants: %w", err)
	}
	defer rows.Close()
	tenants := make([]string, 0, worker.TenantBatchSize)
	for rows.Next() {
		var tenantID string
		if err := rows.Scan(&tenantID); err != nil {
			return nil, fmt.Errorf("scan engagement retention tenant: %w", err)
		}
		tenants = append(tenants, tenantID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate engagement retention tenants: %w", err)
	}
	return tenants, nil
}

func (worker *RetentionWorker) Run(ctx context.Context, logger *slog.Logger) error {
	if err := worker.validate(); err != nil {
		return err
	}
	if logger == nil {
		logger = slog.Default()
	}
	cursor := ""
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			result, err := worker.SweepOnce(ctx, cursor)
			// Advance BEFORE the error check, matching StageTwoWorker.Run. The
			// sweep now continues past a failing tenant and returns a PARTIAL
			// result alongside the joined errors, so discarding the cursor on
			// error would throw away real progress and re-open the same page on
			// every tick — the failing tenant would block the purge for every
			// tenant after it, which is the starvation this shape exists to avoid.
			cursor = result.NextTenantCursor
			if err != nil {
				if errors.Is(err, context.Canceled) {
					return err
				}
				logger.Warn("engagement observation retention sweep failed", "err", err)
			} else {
				logger.Info("engagement observation retention sweep completed",
					"tenant_count", result.TenantCount,
					"degraded", result.Degraded,
					"deleted", result.Deleted,
					"stage_two_pruned", result.StageTwoPruned,
					"object_backed_blocked_tenants", result.ObjectBackedBlockedTenants)
			}
			timer.Reset(worker.Interval)
		}
	}
}

func (runtime *Runtime) RunRetention(ctx context.Context, logger *slog.Logger) error {
	if runtime == nil || !runtime.enabled {
		return ErrRuntimeDisabled
	}
	if runtime.retentionWorker == nil {
		return ErrRuntimeNotReady
	}
	return runtime.retentionWorker.Run(ctx, logger)
}

// DegradeObservationBatch applies the PRD's SECOND retention tier.
//
// "Raw events at full fidelity for 90 days, then drop http_headers and ip (keep
// ASN) for the remainder."
//
// Degradation rather than deletion is what keeps a classification RE-DERIVABLE.
// Delete the row and an improved classifier can never revisit it; degrade it and
// the machine-source registry — which matches on ASN — can still reach a verdict,
// while the fingerprinting material that made the row privacy-sensitive is gone.
//
// The append-only trigger permits this UPDATE only because it verifies the update
// IS a degradation: the three sensitive columns may move toward NULL and nothing
// else may change. A blanket worker exemption would have let a bug here rewrite an
// identity hash or an event type.
func (r *Repo) DegradeObservationBatch(
	ctx context.Context,
	tenantID string,
	fullFidelityWindow time.Duration,
	batchSize int,
) (int64, error) {
	if batchSize <= 0 {
		return 0, fmt.Errorf("%w: degradation batch size must be positive", ErrInvalidInput)
	}
	if fullFidelityWindow <= 0 {
		return 0, fmt.Errorf("%w: full-fidelity window must be positive", ErrInvalidInput)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// The worker declares itself, exactly as the delete path does. Without the
	// GUC the trigger refuses the update, so a stray UPDATE from application code
	// cannot degrade evidence by accident.
	// All four GUCs the policies require.
	//
	// worker_select needs outbox_worker AND engagement_classifier_worker; the new
	// retention_update policy needs the retention flag. The UPDATE's subquery
	// READS through worker_select, so the read GUCs are needed even though the
	// statement is a write — and without them the subquery returns nothing and the
	// update silently degrades zero rows.
	for _, guc := range []string{
		"app.outbox_worker",
		"app.engagement_classifier_worker",
		"app.engagement_observation_retention_worker",
	} {
		if _, err := tx.Exec(ctx, `SELECT set_config($1, 'true', true)`, guc); err != nil {
			return 0, err
		}
	}

	cutoff := r.now().Add(-fullFidelityWindow)
	tag, err := tx.Exec(ctx, `
UPDATE subscriber_event_observations
   SET ordered_headers = '[]'::jsonb,
       ip_address      = NULL,
       tls_ja4         = NULL,
       ordered_headers_complete = false,
       degraded_at     = clock_timestamp()
 WHERE id IN (
     SELECT id FROM subscriber_event_observations
      WHERE tenant_id = $1::uuid
        AND degraded_at IS NULL
        AND subscriber_event_at < $2
      ORDER BY subscriber_event_at
      LIMIT $3
 )`, tenantID, cutoff, batchSize)
	if err != nil {
		return 0, fmt.Errorf("degrade engagement observations: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// PruneStageTwoEvaluationBatch reaps SETTLED Stage-2 schedule rows.
//
// engagement_stage_two_evaluations gains exactly two rows for every message that
// ever carries an identity and, before migration 1967, had no way to lose one:
// DELETE was revoked and the guard trigger refused a direct delete outright. It
// was the only F01 table that only ever grew, while the evidence it schedules
// against is degraded at 90 days and purged at its privacy expiry by this same
// sweep.
//
// Only terminal rows are eligible. A 'pending' row is an OWED evaluation, and
// deleting one would cancel a message's 60-second look or its conversion-window
// look with no trace at all. The predicate is repeated in the RLS policy and
// again in the trigger, so this method being wrong is not sufficient to lose one.
func (repo *Repo) PruneStageTwoEvaluationBatch(
	ctx context.Context,
	tenantID string,
	retention time.Duration,
	batchSize int,
) (int64, error) {
	if repo == nil || repo.Pool == nil || strings.TrimSpace(tenantID) == "" {
		return 0, fmt.Errorf("%w: stage two retention requires a tenant repository", ErrInvalidInput)
	}
	if retention < minimumStageTwoRetention || retention > maximumStageTwoRetention {
		return 0, fmt.Errorf("%w: stage two schedule retention is outside 91d..10y", ErrInvalidInput)
	}
	if batchSize < 1 || batchSize > 1000 {
		return 0, fmt.Errorf("%w: stage two retention batch size must be 1..1000", ErrInvalidInput)
	}
	tx, err := db.WithTenantWorker(ctx, repo.Pool, tenantID)
	if err != nil {
		return 0, fmt.Errorf("open stage two retention batch: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// The select policy's two GUCs come from WithTenantWorker plus this call; the
	// delete policy needs its own on top. The DELETE's subquery READS through
	// worker_select, so the read scope is required even though the statement is a
	// write — without it the subquery matches nothing and the reap silently
	// reports zero forever.
	if err := bindClassifierScope(ctx, tx); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.engagement_stage_two_retention_worker', 'true', true)`); err != nil {
		return 0, fmt.Errorf("bind stage two retention scope: %w", err)
	}
	cutoff := repo.now().Add(-retention)
	tag, err := tx.Exec(ctx, `
DELETE FROM engagement_stage_two_evaluations
 WHERE (tenant_id, message_identity_hash, stage) IN (
     SELECT tenant_id, message_identity_hash, stage
       FROM engagement_stage_two_evaluations
      WHERE tenant_id = $1::uuid
        AND state <> 'pending'
        AND completed_at IS NOT NULL
        AND completed_at < $2
      ORDER BY completed_at
      LIMIT $3
 )`, tenantID, cutoff, batchSize)
	if err != nil {
		return 0, fmt.Errorf("prune stage two evaluations: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit stage two retention batch: %w", err)
	}
	return tag.RowsAffected(), nil
}
