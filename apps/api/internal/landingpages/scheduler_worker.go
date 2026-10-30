// SPDX-License-Identifier: AGPL-3.0-only
//
// scheduler_worker.go — LAND-038 scheduled publish / auto-unpublish.
//
// A single periodic due-scan flips landing pages whose schedule has come due:
//   - a draft with publish_at <= now  → published (publish_at cleared)
//   - a published page with unpublish_at <= now → draft (unpublish_at cleared)
//
// The scan runs cross-tenant under app.outbox_worker='true' (db.WithWorkerScope)
// via the permissive RLS policies added in migration 1810 — no per-tenant loop.
// Clearing the timestamp on transition makes the scan idempotent: a page is only
// acted on once per schedule, and a crash mid-tick simply re-scans next interval.
// Safe to run in every API replica (the UPDATEs are self-guarding on state).

package landingpages

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// SchedulerWorker flips scheduled landing pages at their due time.
type SchedulerWorker struct {
	Pool     *db.Pool
	Logger   *slog.Logger
	Interval time.Duration
}

// Run blocks until ctx is canceled, ticking the due-scan on Interval.
func (w *SchedulerWorker) Run(ctx context.Context) error {
	if w == nil || w.Pool == nil {
		return errors.New("landingpages scheduler: missing pool")
	}
	interval := w.Interval
	if interval <= 0 {
		interval = 60 * time.Second
	}
	if w.Logger != nil {
		w.Logger.Info("landingpages scheduler starting", "interval", interval.String())
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if err := w.tick(ctx); err != nil && !errors.Is(err, context.Canceled) && w.Logger != nil {
			// Bounded operator-safe diagnostic — raw DB errors may carry data.
			w.Logger.Warn("landingpages scheduler tick failed", "code", "tick_failed")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// tick performs the two idempotent due-scans in one worker-scoped tx.
func (w *SchedulerWorker) tick(ctx context.Context) error {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `
UPDATE landing_pages
   SET status = 'published',
       publish_at = NULL,
       updated_at = now()
 WHERE status = 'draft'
   AND publish_at IS NOT NULL
   AND publish_at <= now()`); err != nil {
		return err
	}

	if _, err := tx.Exec(ctx, `
UPDATE landing_pages
   SET status = 'draft',
       unpublish_at = NULL,
       updated_at = now()
 WHERE status = 'published'
   AND unpublish_at IS NOT NULL
   AND unpublish_at <= now()`); err != nil {
		return err
	}

	return tx.Commit(ctx)
}
