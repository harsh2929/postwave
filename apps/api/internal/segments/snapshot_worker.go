// SPDX-License-Identifier: AGPL-3.0-only
//
// snapshot_worker.go — daily segment-size snapshots into
// segment_size_history (migration 0392, feat/full-surface-wiring
// task 4).
//
// Implements the persisted history read by size_history.go: walks every
// tenant, compiles each segment's query_ast via the canonical evaluator,
// COUNTs the membership, and upserts one row per (segment, day). The /growth and
// /size-history endpoints read the resulting series.
//
// RLS shape (worker pattern per audience_destinations):
//   - tenant enumeration runs cross-tenant under db.WithWorkerScope
//     (tenants worker_select policy, migration 1708);
//   - everything per-tenant (segment listing, counting, history
//     upsert) re-enters db.WithTenant, so subscriber reads and
//     history writes stay behind tenant RLS — segment_size_history
//     deliberately has NO worker gate.
//
// The tick is hourly but idempotent per day: a NOT EXISTS guard skips
// segments that already have today's row, so the steady-state cost is
// one cheap scan per tenant per hour and each segment is counted once
// per UTC day (catching up automatically after downtime).

package segments

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// snapshotMaxSegmentsPerTenantPerTick bounds one tenant's work per
// tick so a tenant with thousands of segments drains gradually.
const snapshotMaxSegmentsPerTenantPerTick = 200

// SnapshotWorker writes the daily segment_size_history rows.
type SnapshotWorker struct {
	Pool   *db.Pool
	Repo   *Repo
	Logger *slog.Logger
	// Interval defaults to 1 hour.
	Interval time.Duration
}

// Run drives the worker until ctx is canceled.
func (w *SnapshotWorker) Run(ctx context.Context) error {
	if w == nil || w.Pool == nil || w.Repo == nil {
		return errors.New("segments snapshot worker: nil deps")
	}
	interval := w.Interval
	if interval <= 0 {
		interval = time.Hour
	}
	if w.Logger != nil {
		w.Logger.Info("segments snapshot worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if err := w.tick(ctx); err != nil && !errors.Is(err, context.Canceled) && w.Logger != nil {
			w.Logger.Warn("segments snapshot tick failed", "err", err.Error())
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

// tick enumerates tenants (worker scope) and snapshots each tenant's
// un-snapshotted segments for today.
func (w *SnapshotWorker) tick(ctx context.Context) error {
	tenants, err := w.listTenants(ctx)
	if err != nil {
		return err
	}
	for _, tenantID := range tenants {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := w.snapshotTenant(ctx, tenantID); err != nil && w.Logger != nil {
			w.Logger.Warn("segments snapshot: tenant failed",
				"tenant_id", tenantID, "err", err.Error())
		}
	}
	return nil
}

func (w *SnapshotWorker) listTenants(ctx context.Context) ([]string, error) {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `SELECT id::text FROM tenants ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// snapshotTenant counts + upserts every segment of the tenant that
// has no row for today yet. Each segment failure is isolated (a
// malformed AST must not starve the rest of the tenant).
func (w *SnapshotWorker) snapshotTenant(ctx context.Context, tenantID string) error {
	tx, err := db.WithTenant(ctx, w.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT s.id::text, s.query_ast, s.include_archived, s.updated_at
  FROM segments s
 WHERE s.tenant_id = $1::uuid
   AND NOT EXISTS (
       SELECT 1 FROM segment_size_history h
        WHERE h.tenant_id = s.tenant_id
          AND h.segment_id = s.id
          AND h.snapshot_date = CURRENT_DATE)
 ORDER BY s.created_at ASC
 LIMIT $2`, tenantID, snapshotMaxSegmentsPerTenantPerTick)
	if err != nil {
		return err
	}
	todo := []snapshotDefinition{}
	for rows.Next() {
		var p snapshotDefinition
		if err := rows.Scan(&p.ID, &p.QueryAST, &p.IncludeArchived, &p.UpdatedAt); err != nil {
			rows.Close()
			return err
		}
		todo = append(todo, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	_ = tx.Rollback(ctx) // read-only scan

	for _, p := range todo {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := w.snapshotOne(ctx, tenantID, p); err != nil && w.Logger != nil {
			w.Logger.Warn("segments snapshot: segment failed",
				"tenant_id", tenantID, "segment_id", p.ID, "err", err.Error())
		}
	}
	return nil
}

// snapshotDefinition is the definition a snapshot counts: the stored AST, the
// archive scope saved with it, and the updated_at that identifies that
// version.
type snapshotDefinition struct {
	ID              string
	QueryAST        []byte
	IncludeArchived bool
	UpdatedAt       time.Time
}

// snapshotOne counts one segment under its own archive scope, the scope
// Recompute and the list view use, and upserts today's row. It also refreshes
// last_count / last_evaluated_at so the list stays fresh for free. Both writes
// are skipped when the segment was redefined after it was read: a count of the
// old definition must not be recorded as today's size of the new one, and the
// next tick counts the new one.
func (w *SnapshotWorker) snapshotOne(ctx context.Context, tenantID string, def snapshotDefinition) error {
	predicate, err := CompilePopulation(ctx, def.QueryAST, tenantID, w.Repo, DefinitionPopulation(def.IncludeArchived))
	if err != nil {
		return err
	}
	n, err := w.Repo.Count(ctx, tenantID, predicate.SQL, predicate.Args)
	if err != nil {
		return err
	}
	tx, err := db.WithTenant(ctx, w.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	recorded, err := recordEvaluationInTx(ctx, tx, tenantID, def.ID, def.UpdatedAt, n)
	if err != nil {
		return err
	}
	if recorded == nil {
		return nil
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO segment_size_history (tenant_id, segment_id, snapshot_date, evaluated_at, count)
VALUES ($1::uuid, $2::uuid, CURRENT_DATE, $4, $3)
ON CONFLICT (tenant_id, segment_id, snapshot_date)
DO UPDATE SET evaluated_at = EXCLUDED.evaluated_at, count = EXCLUDED.count`,
		tenantID, def.ID, n, *recorded); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
