// SPDX-License-Identifier: AGPL-3.0-only

package transactional

import (
	"context"
	"log/slog"
	"time"
)

// Worker dispatches due scheduled transactional emails. It claims due rows
// (status='scheduled', scheduled_at<=now) under worker scope, then re-runs the
// send-core against each persisted payload.
type Worker struct {
	Deps     *Deps
	Interval time.Duration // default 30s
	Batch    int           // default 100
	Logger   *slog.Logger
}

func (w *Worker) interval() time.Duration {
	if w.Interval > 0 {
		return w.Interval
	}
	return 30 * time.Second
}

func (w *Worker) log() *slog.Logger {
	if w.Logger != nil {
		return w.Logger
	}
	return slog.Default()
}

// Run blocks until ctx is cancelled, ticking every Interval.
func (w *Worker) Run(ctx context.Context) {
	if w == nil || w.Deps == nil || w.Deps.Repo == nil {
		return
	}
	w.log().Info("transactional-schedule-worker: starting", "interval", w.interval().String())
	t := time.NewTicker(w.interval())
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			w.tick(ctx)
		}
	}
}

func (w *Worker) tick(ctx context.Context) {
	batch := w.Batch
	if batch <= 0 {
		batch = 100
	}
	due, err := w.Deps.Repo.ClaimDue(ctx, time.Now().UTC(), batch)
	if err != nil {
		w.log().Warn("transactional-schedule-worker: claim failed", "err", err.Error())
		return
	}
	for _, row := range due {
		if ctx.Err() != nil {
			return
		}
		w.Deps.SendStored(ctx, row.TenantID, row.ID, row.Payload)
	}
	// Garbage-collect expired SMTP dedup keys so the table stays small.
	if err := w.Deps.Repo.CleanupSMTPDedup(ctx, SMTPDedupWindowSecs); err != nil {
		w.log().Warn("transactional-schedule-worker: dedup cleanup failed", "err", err.Error())
	}
}
