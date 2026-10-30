// SPDX-License-Identifier: AGPL-3.0-only
//
// retention.go — periodic pruner for inbound_route_matches.
//
// Why an in-process worker (not a pg cron extension):
//
//   - pg_cron isn't installed on every supported Postgres host (RDS
//     requires opt-in; some self-hosted deployments don't have it).
//   - The DELETE is cheap (single index scan on inbound_route_matches_
//     retention_idx) and runs at most hourly, so the in-process
//     overhead is negligible.
//   - Co-locating with the API keeps the retention contract visible
//     next to the writer code; a SQL-only solution would drift if the
//     schema ever changed without anyone noticing.
//
// Concurrency: when multiple API replicas run concurrently the worst
// case is wasted DELETEs (each replica tries to prune; whichever wins
// the row lock commits). No correctness impact. If the worker churn
// becomes a problem we can guard with pg_try_advisory_lock the same
// way the auditsink worker does — not needed at this scale.

package inbound_email

import (
	"context"
	"log/slog"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// RetentionWorker prunes inbound_route_matches rows older than
// RetainFor. Defaults to 30 days. Run() is the goroutine entrypoint.
type RetentionWorker struct {
	Pool      *db.Pool
	RetainFor time.Duration // default 30d
	Interval  time.Duration // default 1h
	Logger    *slog.Logger
}

// Run ticks on the configured interval and prunes. Returns when ctx
// is done; never returns nil-error mid-flight.
func (w *RetentionWorker) Run(ctx context.Context) error {
	if w == nil || w.Pool == nil {
		return nil
	}
	if w.RetainFor <= 0 {
		w.RetainFor = 30 * 24 * time.Hour
	}
	if w.Interval <= 0 {
		w.Interval = time.Hour
	}
	if w.Logger != nil {
		w.Logger.Info("inbound_route_matches retention worker: starting",
			"interval", w.Interval.String(),
			"retain_for", w.RetainFor.String())
	}
	t := time.NewTicker(w.Interval)
	defer t.Stop()
	// Run once on startup so an operator restarting the API at 3am
	// doesn't have to wait until 4am for the first prune.
	w.prune(ctx)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			w.prune(ctx)
		}
	}
}

// prune is one DELETE pass. Worker context (app.outbox_worker=true)
// so RLS doesn't filter by tenant — retention is tenant-agnostic.
func (w *RetentionWorker) prune(ctx context.Context) {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		w.warn("retention worker scope failed", "err", err.Error())
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	cutoff := time.Now().UTC().Add(-w.RetainFor)
	tag, err := tx.Exec(ctx, `
DELETE FROM inbound_route_matches
 WHERE matched_at < $1`, cutoff)
	if err != nil {
		w.warn("retention delete failed", "err", err.Error())
		return
	}
	if err := tx.Commit(ctx); err != nil {
		w.warn("retention commit failed", "err", err.Error())
		return
	}
	if w.Logger != nil && tag.RowsAffected() > 0 {
		w.Logger.Info("inbound_route_matches pruned",
			"rows", tag.RowsAffected(),
			"cutoff", cutoff.Format(time.RFC3339))
	}
}

func (w *RetentionWorker) warn(msg string, kv ...any) {
	if w.Logger != nil {
		w.Logger.Warn(msg, kv...)
	}
}
