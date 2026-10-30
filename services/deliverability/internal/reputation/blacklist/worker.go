// SPDX-License-Identifier: AGPL-3.0-only
//
// worker.go — long-running orchestrator for the blocklist monitor.
//
// Run() composes Monitor.RunOnce() with a ticker, backoff on errors,
// and graceful shutdown via context cancellation. Production wires
// this as a background goroutine in services/deliverability/main.go;
// tests can call RunOnce() directly without booting the worker loop.

package blacklist

import (
	"context"
	"log/slog"
	"time"
)

// Worker is the run-forever wrapper around Monitor.
type Worker struct {
	Monitor *Monitor
	// Interval is the tick cadence (default 5min). Each tick runs one
	// full pass. Combined with MinAge on the monitor, the effective
	// "freshness budget" of any (subject, zone) pair is
	// max(Interval, MinAge).
	Interval time.Duration
	// Backoff is the sleep after a failed pass. Default 1min.
	Backoff time.Duration
	Logger  *slog.Logger
}

// NewWorker constructs a Worker with sensible defaults.
func NewWorker(m *Monitor, logger *slog.Logger) *Worker {
	return &Worker{
		Monitor:  m,
		Interval: 5 * time.Minute,
		Backoff:  time.Minute,
		Logger:   logger,
	}
}

// Run drives the worker until ctx is canceled. Returns ctx.Err()
// when shutdown is graceful.
func (w *Worker) Run(ctx context.Context) error {
	if w == nil || w.Monitor == nil {
		return nil // nothing to do; orchestrator can skip wiring
	}
	interval := w.Interval
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	backoff := w.Backoff
	if backoff <= 0 {
		backoff = time.Minute
	}
	logger := w.Logger
	if logger == nil {
		logger = slog.Default()
	}

	logger.Info("blocklist worker: starting",
		"interval", interval.String(), "zones", len(w.Monitor.Zones))

	// Kick off immediately on boot — operators want a fresh sweep
	// after a restart, not interval-wait minutes of stale data.
	for {
		select {
		case <-ctx.Done():
			logger.Info("blocklist worker: shutting down")
			return ctx.Err()
		default:
		}

		started := time.Now()
		recorded, err := w.Monitor.RunOnce(ctx)
		if err != nil {
			logger.Warn("blocklist worker: run failed",
				"err", err.Error(),
				"backoff", backoff.String())
			if !sleep(ctx, backoff) {
				return ctx.Err()
			}
			continue
		}
		logger.Info("blocklist worker: pass complete",
			"observations", recorded,
			"elapsed", time.Since(started).String())

		// Sleep the remainder of the interval. If the pass took
		// longer than the interval (large fan-out), we tick again
		// immediately — the monitor's MinAge skip-if-recent gate
		// keeps us from re-querying any zone too aggressively.
		remaining := interval - time.Since(started)
		if remaining > 0 {
			if !sleep(ctx, remaining) {
				return ctx.Err()
			}
		}
	}
}

// sleep returns false when ctx is canceled before d elapses.
func sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
