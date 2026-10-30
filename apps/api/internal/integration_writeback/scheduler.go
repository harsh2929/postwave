// SPDX-License-Identifier: AGPL-3.0-only
//
// scheduler.go — background tick that runs due write-back targets, making the
// reverse-ETL CONTINUOUS (Klaviyo-class) rather than manual-only. The due-scan is
// cross-tenant under db.WithWorkerScope (the writeback_targets_worker_select
// policy, migration 1619); each due target then runs under its own tenant RLS via
// RunWriteback. Mirrors audience_destinations.SyncScheduler.
//
// v1 limitation (documented, same as the audience scheduler): no FOR UPDATE SKIP
// LOCKED claim, so multi-replica deployments can double-run a target in the tick
// window before last_run_at is denormalized. Platform writes are idempotent by
// construction (tagsAdd/metafieldsSet/PATCH-by-email/upsert), so a duplicate run
// costs API quota, not correctness.
package integration_writeback

import (
	"context"
	"log/slog"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	schedulerDefaultTick = time.Minute
	schedulerMaxPerTick  = 20
)

// Scheduler runs due write-back targets in the background.
type Scheduler struct {
	Pool   *db.Pool
	Deps   *Deps
	Logger *slog.Logger
	Tick   time.Duration
}

func (s *Scheduler) Run(ctx context.Context) error {
	if s == nil || s.Pool == nil || s.Deps == nil {
		return nil
	}
	tick := s.Tick
	if tick <= 0 {
		tick = schedulerDefaultTick
	}
	if s.Logger != nil {
		s.Logger.Info("integration_writeback scheduler: starting", "tick", tick.String())
	}
	t := time.NewTicker(tick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			s.tick(ctx)
		}
	}
}

type dueTarget struct {
	targetID string
	tenantID string
}

func (s *Scheduler) tick(ctx context.Context) {
	due, err := s.findDue(ctx)
	if err != nil {
		if s.Logger != nil {
			s.Logger.Warn("integration_writeback: scheduler scan failed", "err", err.Error())
		}
		return
	}
	for _, d := range due {
		if ctx.Err() != nil {
			return
		}
		if _, _, err := s.Deps.RunWriteback(ctx, d.tenantID, d.targetID, "scheduled"); err != nil {
			if s.Logger != nil {
				s.Logger.Warn("integration_writeback: scheduled run failed", "target_id", d.targetID, "err", err.Error())
			}
		}
	}
}

// findDue enumerates active targets whose last run is older than their interval.
func (s *Scheduler) findDue(ctx context.Context) ([]dueTarget, error) {
	tx, err := db.WithWorkerScope(ctx, s.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text
  FROM writeback_targets
 WHERE status = 'active'
   AND sync_interval_minutes > 0
   AND (
         last_run_at IS NULL
      OR last_run_at < now() - make_interval(mins => sync_interval_minutes)
   )
 ORDER BY last_run_at ASC NULLS FIRST
 LIMIT $1`, schedulerMaxPerTick)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []dueTarget{}
	for rows.Next() {
		var d dueTarget
		if err := rows.Scan(&d.targetID, &d.tenantID); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}
