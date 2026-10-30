// SPDX-License-Identifier: AGPL-3.0-only
//
// Package audit owns the audit-log-retention sweeper. The retention
// window is per-tenant (settings.PrivacyRepo.AuditLogRetentionDays);
// older rows are batched out the back of the table on a slow ticker
// so the deletes never compete with writes for table locks.
//
// Why a goroutine and not a cron job: we already have several
// long-running goroutines in main.go (sandboxFlusher, statusPoller,
// approval sweeper) and the audit-trim duty cycle is "once a day"
// — well below any threshold that would justify a cron framework.
// Adding a fourth goroutine costs nothing.
//
// Lock posture: each tenant's deletes happen in their own short-lived
// tenant-scoped tx (db.WithTenant). Inside the tx we issue
//
//	DELETE FROM audit_log
//	 WHERE ctid IN (
//	   SELECT ctid FROM audit_log
//	    WHERE tenant_id = $1
//	      AND created_at < now() - $2 * INTERVAL '1 day'
//	    LIMIT $3
//	 )
//
// — `LIMIT` directly on a DELETE isn't legal in Postgres, so we go
// through `ctid` in the subquery to bound the per-batch row count
// regardless of how stale the table is. This caps the row-locks
// taken per batch at BatchSize so a tenant with millions of stale
// rows can't starve other writers.
package audit

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// PurgeAction is the canonical action name on the per-batch retention
// purge event emitted at the end of each trimBatch tx. Carved out
// from the trim query so purge events themselves are never purged.
const PurgeAction = "audit.retention.purge"

// PrivacyReader is the narrow surface settings.PrivacyDeps already
// implements. Defined locally so tests can stub a constant retention
// window without spinning up the privacy package.
type PrivacyReader interface {
	AuditLogRetentionDays(ctx context.Context, tenantID string) (int, error)
}

// Defaults the trimmer falls back to when its fields are zero-valued.
const (
	DefaultInterval  = 24 * time.Hour
	DefaultBatchSize = 1000
	// MinRetentionDays mirrors settings.auditLogMin so a corrupt
	// retention row can't make the trimmer wipe the table on tick 1.
	MinRetentionDays = 7
)

// Trimmer is the audit-log-retention sweeper. Construct with a Pool +
// Privacy reader and call Run from a goroutine; Run returns when ctx
// is cancelled.
type Trimmer struct {
	Pool    *pgxpool.Pool
	Privacy PrivacyReader

	// Interval is the gap between sweeps. Defaults to DefaultInterval.
	Interval time.Duration

	// BatchSize bounds the per-tenant per-iteration delete count.
	// Defaults to DefaultBatchSize. The tenant's stale rows are
	// drained in repeated BatchSize-sized DELETEs until either the
	// tenant is clean or the iteration's tx errors. Bounding this
	// keeps lock contention with concurrent audit_log writers low.
	BatchSize int

	// Logger is optional; nil-safe (defaults to slog.Default()).
	Logger *slog.Logger

	// MaxBatchesPerTenant caps how many batches we issue per tenant
	// per iteration so a misconfigured retention=0 (defensively
	// guarded but still possible if MinRetentionDays is bypassed)
	// can't melt the DB in one tick. Defaults to 64 (=64,000 rows
	// per tenant per tick at the default batch size).
	MaxBatchesPerTenant int
}

// auditTrimRowsDeletedTotal counts rows trimmed per tenant. We use a
// metric vector keyed on tenant id (over the tenant_id label) because
// per-tenant retention diagnostics matter when a customer asks "did my
// row really get deleted?"
//
// Cardinality note: # tenants is bounded; if the platform grows past a
// few thousand we'll switch to histogram-of-deletes-per-iteration.
var auditTrimRowsDeletedTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "audit_log_trim_rows_deleted_total",
		Help: "Rows deleted from audit_log by the retention trimmer, partitioned by tenant.",
	},
	[]string{"tenant"},
)

// auditTrimIterationsTotal counts trimmer ticks (success + error).
var auditTrimIterationsTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "audit_log_trim_iterations_total",
		Help: "Trimmer ticks, partitioned by outcome.",
	},
	[]string{"outcome"},
)

func (t *Trimmer) interval() time.Duration {
	if t == nil || t.Interval <= 0 {
		return DefaultInterval
	}
	return t.Interval
}

func (t *Trimmer) batchSize() int {
	if t == nil || t.BatchSize <= 0 {
		return DefaultBatchSize
	}
	return t.BatchSize
}

func (t *Trimmer) maxBatches() int {
	if t == nil || t.MaxBatchesPerTenant <= 0 {
		return 64
	}
	return t.MaxBatchesPerTenant
}

func (t *Trimmer) logger() *slog.Logger {
	if t != nil && t.Logger != nil {
		return t.Logger
	}
	return slog.Default()
}

// Run blocks until ctx is cancelled, calling trimOnce on each tick.
// First run fires immediately so a fresh boot starts trimming without
// waiting an interval.
func (t *Trimmer) Run(ctx context.Context) {
	if t == nil || t.Pool == nil {
		// No-op trimmer; the program is responsible for not starting it
		// when the pool is unconfigured. Belt-and-suspenders so a
		// `go (&audit.Trimmer{}).Run(ctx)` doesn't panic.
		return
	}
	logger := t.logger()
	logger.Info("audit trim: starting",
		"interval", t.interval(),
		"batch_size", t.batchSize(),
		"max_batches_per_tenant", t.maxBatches(),
	)
	// Fire once immediately, then on the ticker.
	if err := t.trimOnce(ctx); err != nil && !errors.Is(err, context.Canceled) {
		auditTrimIterationsTotal.WithLabelValues("error").Inc()
		logger.Error("audit trim: first iteration failed", "err", err.Error())
	} else if err == nil {
		auditTrimIterationsTotal.WithLabelValues("ok").Inc()
	}
	ticker := time.NewTicker(t.interval())
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			logger.Info("audit trim: context cancelled, exiting")
			return
		case <-ticker.C:
			if err := t.trimOnce(ctx); err != nil && !errors.Is(err, context.Canceled) {
				auditTrimIterationsTotal.WithLabelValues("error").Inc()
				logger.Error("audit trim: iteration failed", "err", err.Error())
				continue
			}
			auditTrimIterationsTotal.WithLabelValues("ok").Inc()
		}
	}
}

// trimOnce sweeps every tenant with audit_log rows, trimming each
// tenant's stale window in BatchSize-sized batches. Returns the first
// fatal error encountered; per-tenant errors are logged and don't fail
// the iteration so one slow tenant can't block all others.
func (t *Trimmer) trimOnce(ctx context.Context) error {
	tenants, err := t.listTenants(ctx)
	if err != nil {
		return fmt.Errorf("audit trim: list tenants: %w", err)
	}
	logger := t.logger()
	for _, tid := range tenants {
		if err := ctx.Err(); err != nil {
			return err
		}
		days, derr := t.retentionDays(ctx, tid)
		if derr != nil {
			logger.Warn("audit trim: retention lookup failed; skipping tenant",
				"tenant_id", tid, "err", derr.Error())
			continue
		}
		if days < MinRetentionDays {
			// Belt-and-suspenders: the privacy table validates the
			// patch input but a row written before the validator
			// landed could still smuggle a too-short window.
			days = MinRetentionDays
		}
		deleted, terr := t.trimTenant(ctx, tid, days)
		if terr != nil {
			logger.Warn("audit trim: tenant sweep failed",
				"tenant_id", tid, "err", terr.Error())
			continue
		}
		if deleted > 0 {
			auditTrimRowsDeletedTotal.WithLabelValues(tid).Add(float64(deleted))
			logger.Info("audit trim: tenant swept",
				"tenant_id", tid, "deleted", deleted, "retention_days", days)
		}
	}
	return nil
}

// trimTenant deletes stale audit_log rows for one tenant in batched
// tenant-scoped txs. Loops until either zero rows came back or
// MaxBatchesPerTenant tx's have run.
func (t *Trimmer) trimTenant(ctx context.Context, tenantID string, days int) (int64, error) {
	var totalDeleted int64
	for i := 0; i < t.maxBatches(); i++ {
		if err := ctx.Err(); err != nil {
			return totalDeleted, err
		}
		n, err := t.trimBatch(ctx, tenantID, days)
		if err != nil {
			return totalDeleted, err
		}
		totalDeleted += n
		if n == 0 {
			break
		}
	}
	return totalDeleted, nil
}

// trimBatch issues a single bounded DELETE. Returns rows deleted.
//
// Three carve-outs are encoded directly in the WHERE clause so a future
// refactor that touches the query can't silently lose any of them:
//
//  1. legal_hold = false        — held rows are exempt from retention
//     trimming entirely; an operator must clear the hold first.
//  2. action != PurgeAction     — purge events emitted by this worker
//     are themselves never purged so the retention activity timeline
//     is permanent.
//  3. retention_override_days   — when set, the row uses its own
//     window rather than the tenant default. The OR branch keeps the
//     simpler tenant-default path on the indexed common path.
//
// Each batch that actually deletes rows emits a single
// `audit.retention.purge` audit_log row capturing
// {tenant_id, deleted_id_range, deleted_count, retention_days,
//
//	before_root_hash} so the trim history is itself auditable.
func (t *Trimmer) trimBatch(ctx context.Context, tenantID string, days int) (int64, error) {
	tx, err := t.beginTenant(ctx, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// before_root_hash: snapshot the latest signed Merkle root for this
	// tenant *before* the delete. Lets a verifier prove the purge took
	// place after a particular tree state. Best-effort — when no roots
	// exist yet (fresh tenant) we record an empty string.
	beforeRootHash := ""
	var rawRoot []byte
	_ = tx.QueryRow(ctx, `
SELECT root_hash
  FROM audit_merkle_roots
 WHERE tenant_id = $1::uuid
 ORDER BY tree_size DESC
 LIMIT 1`, tenantID).Scan(&rawRoot)
	if len(rawRoot) > 0 {
		beforeRootHash = hex.EncodeToString(rawRoot)
	}

	// LIMIT on DELETE isn't legal in Postgres; route through the
	// physical row id (ctid) in the subquery so the per-batch row
	// count stays bounded. The RETURNING clause gives us the id
	// range for the audit.retention.purge event.
	const q = `
WITH victims AS (
    SELECT ctid, id FROM audit_log
     WHERE tenant_id = $1::uuid
       AND legal_hold = false
       AND action != $4
       AND created_at < now() - (
             COALESCE(retention_override_days, $2::int) || ' days'
           )::interval
     ORDER BY id ASC
     LIMIT $3
)
DELETE FROM audit_log
 WHERE ctid IN (SELECT ctid FROM victims)
RETURNING id`
	rows, err := tx.Query(ctx, q, tenantID, days, t.batchSize(), PurgeAction)
	if err != nil {
		return 0, fmt.Errorf("delete: %w", err)
	}
	var deletedIDs []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, fmt.Errorf("scan deleted id: %w", err)
		}
		deletedIDs = append(deletedIDs, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("delete rows: %w", err)
	}

	deleted := int64(len(deletedIDs))
	if deleted > 0 {
		if err := writePurgeEvent(ctx, tx, tenantID, deletedIDs, days, beforeRootHash); err != nil {
			// Don't fail the trim on audit-emit error — log + continue.
			// The deletion is the load-bearing operation; the audit
			// event is the paper trail.
			t.logger().Warn("audit trim: purge event emit failed",
				"tenant_id", tenantID, "err", err.Error())
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit: %w", err)
	}
	return deleted, nil
}

// writePurgeEvent appends one audit.retention.purge row inside the
// same tx that did the delete. The audit_internal_writer GUC is set
// so the immutability trigger lets the insert through under the
// system actor.
func writePurgeEvent(ctx context.Context, tx pgx.Tx, tenantID string, deletedIDs []int64, retentionDays int, beforeRootHash string) error {
	if len(deletedIDs) == 0 {
		return nil
	}
	first := deletedIDs[0]
	last := deletedIDs[len(deletedIDs)-1]
	idRange := fmt.Sprintf("[%d,%d]", first, last)
	meta := map[string]any{
		"deleted_id_range": idRange,
		"deleted_id_first": first,
		"deleted_id_last":  last,
		"deleted_count":    len(deletedIDs),
		"retention_days":   retentionDays,
		"before_root_hash": beforeRootHash,
	}
	metaJSON, err := json.Marshal(meta)
	if err != nil {
		return fmt.Errorf("marshal meta: %w", err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.audit_internal_writer', 'true', true)`); err != nil {
		return fmt.Errorf("guc set: %w", err)
	}
	_, err = tx.Exec(ctx, `
INSERT INTO audit_log
    (tenant_id, action, metadata, actor_type, actor_label)
VALUES
    ($1::uuid, $2, $3::jsonb, 'system', 'audit-retention-trimmer')`,
		tenantID, PurgeAction, string(metaJSON))
	if err != nil {
		return fmt.Errorf("insert purge event: %w", err)
	}
	return nil
}

// retentionDays consults the privacy reader; returns the package
// default (90 days) when no reader is wired, mirroring
// settings.PrivacyRepo.AuditLogRetentionDays' own no-row fallback.
func (t *Trimmer) retentionDays(ctx context.Context, tenantID string) (int, error) {
	if t.Privacy == nil {
		return 90, nil
	}
	return t.Privacy.AuditLogRetentionDays(ctx, tenantID)
}

// listTenants returns the distinct tenant_ids with at least one
// audit_log row. We use a privileged read (no app.tenant_id GUC) so
// the cross-tenant scan returns rows; the audit_log RLS policy
// permits SELECT for the trimmer role via the
// `app.audit_trim_worker` GUC. If the GUC isn't recognised on this
// schema we fall back to a plain SELECT — when RLS denies it we get
// zero rows and the trimmer is a no-op (which is acceptable;
// retention is best-effort and an alert on rows-deleted-zero will
// catch a misconfigured policy faster than failing here).
func (t *Trimmer) listTenants(ctx context.Context) ([]string, error) {
	tx, err := t.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Best-effort GUC bind so the audit_log RLS policy permits the
	// cross-tenant scan. We don't fail if the GUC isn't recognised.
	_, _ = tx.Exec(ctx, `SELECT set_config('app.audit_trim_worker', 'true', true)`)
	rows, err := tx.Query(ctx, `SELECT DISTINCT tenant_id::text FROM audit_log`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]string, 0, 16)
	for rows.Next() {
		var tid string
		if err := rows.Scan(&tid); err != nil {
			return nil, err
		}
		out = append(out, tid)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func (t *Trimmer) beginTenant(ctx context.Context, tenantID string) (pgx.Tx, error) {
	if tenantID == "" {
		return nil, errors.New("audit trim: tenantID required")
	}
	tx, err := t.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	// Same belt-and-suspenders GUC for the audit_log policy in case
	// it requires an explicit "i'm the trimmer" signal.
	_, _ = tx.Exec(ctx, `SELECT set_config('app.audit_trim_worker', 'true', true)`)
	return tx, nil
}
