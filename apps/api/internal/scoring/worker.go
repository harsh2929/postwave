// SPDX-License-Identifier: AGPL-3.0-only
//
// worker.go — periodic recompute of subscribers.engagement_score
// across all tenants.

package scoring

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Worker is the background recomputer.
type Worker struct {
	Pool     *db.Pool
	Logger   *slog.Logger
	Interval time.Duration
}

// Run blocks until ctx is canceled.
func (w *Worker) Run(ctx context.Context) error {
	if w == nil || w.Pool == nil {
		return errors.New("scoring worker: missing pool")
	}
	interval := w.Interval
	if interval <= 0 {
		interval = 15 * time.Minute
	}
	if w.Logger != nil {
		w.Logger.Info("scoring worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("scoring tick failed", "err", err.Error())
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

// tick walks every tenant that has any subscriber_events in the
// last 90 days + recomputes their scores. Single-flight per tenant.
func (w *Worker) tick(ctx context.Context) error {
	// A SECURITY DEFINER function owned by a purpose-built NOLOGIN role returns
	// candidate tenant UUIDs only. The runtime role never receives cross-tenant
	// row visibility or subscriber identity columns (migration 1763).
	rows, err := w.Pool.Query(ctx,
		`SELECT tenant_id::text FROM scoring_discovery_tenants($1)`,
		scoringWindowDays)
	if err != nil {
		return err
	}
	tenants := []string{}
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			rows.Close()
			return err
		}
		tenants = append(tenants, t)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, tenantID := range tenants {
		if _, err := RecomputeTenant(ctx, w.Pool, tenantID); err != nil &&
			w.Logger != nil {
			w.Logger.Warn("scoring recompute failed",
				"tenant", tenantID, "err", err.Error())
		}
	}
	return nil
}
