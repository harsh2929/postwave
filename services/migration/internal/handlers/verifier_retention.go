package handlers

import (
	"context"
	"log/slog"
	"time"

	"github.com/postwave/postwave/services/migration/internal/orchestrator"
)

const verifierRetentionSweepRowsPerTenant = 10000

// StartVerifierRetentionWorker enforces physical deletion of expired raw
// subscriber verifier observations even when a process died between committing
// a terminal job status and running that job's normal cleanup.
func (h *Migration) StartVerifierRetentionWorker(ctx context.Context, interval time.Duration) {
	if h == nil || h.db == nil {
		return
	}
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	run := func() {
		totalDeleted := 0
		passes := 0
		for {
			deleted, err := orchestrator.SweepExpiredSubscriberVerifierObservations(
				ctx, h.db, verifierRetentionSweepRowsPerTenant,
			)
			totalDeleted += deleted
			passes++
			if err != nil {
				slog.Error("migration: subscriber verifier retention sweep failed",
					"err", err, "erased_before_error", totalDeleted, "passes", passes)
			}
			if deleted == 0 || ctx.Err() != nil {
				break
			}
		}
		if totalDeleted > 0 {
			slog.Info("migration: expired subscriber verifier observations erased",
				"count", totalDeleted, "passes", passes)
		}
	}
	go func() {
		run()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				run()
			}
		}
	}()
}
