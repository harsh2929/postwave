// SPDX-License-Identifier: AGPL-3.0-only
//
// snapshot_worker.go — daily audience-lifecycle snapshots into the isolated
// verified history ledger (migration 1773, SUB-124).
//
// The subscriber-level analogue of segments/snapshot_worker.go. Walks
// every tenant and upserts one row per (tenant, UTC day) carrying the
// total / added / verified-withdrawal counts the audience growth report reads.
//
// RLS shape (worker pattern):
//   - tenant enumeration runs cross-tenant under db.WithWorkerScope
//     (tenants worker_select policy, migration 1708);
//   - the per-tenant snapshot re-enters db.WithTenant (in
//     Repo.snapshotGrowthForTenant) so the subscribers read and the
//     history upsert stay behind tenant RLS.
//
// The tick is hourly but idempotent per day: the upsert refreshes today's
// row each tick, so a tenant that adds subscribers mid-day sees the count
// climb, and the steady-state cost is one cheap aggregate per tenant per
// hour.

package subscribers

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// GrowthSnapshotWorker writes daily verified-exact-ledger-v2 history rows.
type GrowthSnapshotWorker struct {
	Pool   *db.Pool
	Repo   *Repo
	Logger *slog.Logger
	// Interval defaults to 1 hour.
	Interval time.Duration
}

// Run drives the worker until ctx is canceled.
func (w *GrowthSnapshotWorker) Run(ctx context.Context) error {
	if w == nil || w.Pool == nil || w.Repo == nil {
		return errors.New("subscribers growth snapshot worker: nil deps")
	}
	interval := w.Interval
	if interval <= 0 {
		interval = time.Hour
	}
	if w.Logger != nil {
		w.Logger.Info("subscribers growth snapshot worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if err := w.tick(ctx); err != nil && !errors.Is(err, context.Canceled) && w.Logger != nil {
			w.Logger.Warn("subscribers growth snapshot tick failed", "err", err.Error())
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

// tick enumerates tenants (worker scope) and snapshots each tenant's
// audience for today. Each tenant failure is isolated.
func (w *GrowthSnapshotWorker) tick(ctx context.Context) error {
	tenants, err := w.listTenants(ctx)
	if err != nil {
		return err
	}
	for _, tenantID := range tenants {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := w.Repo.snapshotGrowthForTenant(ctx, tenantID); err != nil && w.Logger != nil {
			w.Logger.Warn("subscribers growth snapshot: tenant failed",
				"tenant_id", tenantID, "err", err.Error())
		}
	}
	return nil
}

func (w *GrowthSnapshotWorker) listTenants(ctx context.Context) ([]string, error) {
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
