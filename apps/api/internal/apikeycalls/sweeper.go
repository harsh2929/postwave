// SPDX-License-Identifier: AGPL-3.0-only
//
// Retention sweeper for api_key_calls. Runs as a background
// goroutine in main.go; deletes rows older than the configured
// retention window in bounded batches so locks stay short even
// when a backlog has accumulated (e.g. the sweeper was disabled
// for a week).
//
// Default retention: 90 days. Override with
// POSTWAVE_API_KEY_CALLS_RETENTION_DAYS in the API env.

package apikeycalls

import (
	"context"
	"log/slog"
	"os"
	"strconv"
	"time"
)

// DefaultRetentionDays is what the sweeper falls back to when no
// override is set. Aligned with the audit_log retention so the two
// observability surfaces age out together.
const DefaultRetentionDays = 90

// Sweeper trims api_key_calls rows older than the retention window.
// Tick cadence: every hour by default. Each tick runs at most
// SweepBatchSize deletes; multi-batch backlog catches up on
// successive ticks.
type Sweeper struct {
	Repo *Repo
	// RetentionDays is the cutoff age. Zero -> DefaultRetentionDays.
	RetentionDays int
	// Interval is the loop cadence. Zero -> 1 hour.
	Interval time.Duration
	// SweepBatchSize caps deletes per tick. Zero -> 10000.
	SweepBatchSize int
}

// NewSweeperFromEnv constructs a Sweeper, reading the retention
// override from POSTWAVE_API_KEY_CALLS_RETENTION_DAYS. Returns nil
// when retention is explicitly set to 0 (operator wants no GC) so
// main.go can skip launching the goroutine.
func NewSweeperFromEnv(repo *Repo) *Sweeper {
	days := DefaultRetentionDays
	if raw := os.Getenv("POSTWAVE_API_KEY_CALLS_RETENTION_DAYS"); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v >= 0 {
			days = v
		}
	}
	if days <= 0 {
		return nil
	}
	return &Sweeper{Repo: repo, RetentionDays: days}
}

// Run drives the loop until ctx is cancelled. Each tick swallows
// errors after logging them — the sweeper is best-effort.
func (s *Sweeper) Run(ctx context.Context) {
	if s == nil || s.Repo == nil {
		return
	}
	interval := s.Interval
	if interval <= 0 {
		interval = time.Hour
	}
	// One immediate tick at startup so an operator who restarts the
	// API after a long downtime catches up before the first hourly
	// interval elapses.
	s.tick(ctx)
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.tick(ctx)
		}
	}
}

func (s *Sweeper) tick(ctx context.Context) {
	days := s.RetentionDays
	if days <= 0 {
		days = DefaultRetentionDays
	}
	cutoff := time.Now().UTC().AddDate(0, 0, -days)
	tickCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	n, err := s.Repo.PurgeOlderThan(tickCtx, cutoff, s.SweepBatchSize)
	if err != nil {
		slog.Warn("apikeycalls sweep failed", "err", err.Error())
		return
	}
	if n > 0 {
		slog.Info("apikeycalls sweep", "deleted", n, "cutoff_days", days)
	}
}
