// SPDX-License-Identifier: AGPL-3.0-only

package workers

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/postwave/postwave/apps/api/internal/safego"
	"github.com/postwave/postwave/apps/api/internal/verification"
)

// verificationCachePurgeInterval is how often expired verdicts are
// swept. Hourly is ample: entries have a 30-day default TTL, so the
// only cost of a late sweep is a slightly larger table.
const verificationCachePurgeInterval = time.Hour

// StartVerificationRunner launches the async bulk-verification worker.
//
// A nil runner (structurally incomplete dependencies, or a deployment
// with no database) is a no-op rather than a panic, matching the other
// Start* helpers.
func StartVerificationRunner(ctx context.Context, logger *slog.Logger, runner *verification.Runner) {
	if runner == nil {
		return
	}
	safego.Go(logger, "verification-job-runner", func() {
		runner.Run(ctx)
	})
}

// StartVerificationCachePurge sweeps expired cached verdicts.
//
// The sweep is deliberately separate from the job runner: a stalled or
// crash-looping job worker must not also stop cache maintenance, or
// the table grows without bound precisely when something is already
// wrong.
func StartVerificationCachePurge(ctx context.Context, logger *slog.Logger, store *verification.Store) {
	if store == nil || store.Pool == nil {
		return
	}
	safego.Go(logger, "verification-cache-purge", func() {
		ticker := time.NewTicker(verificationCachePurgeInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				removed, err := store.PurgeExpired(ctx, 10000)
				if err != nil && !errors.Is(err, context.Canceled) {
					// Database/provider errors can contain addresses or upstream
					// payload fragments. This maintenance path needs only a closed
					// operational class in logs.
					logger.Warn("verification cache purge failed", "error_class", "internal_or_dependency")
					continue
				}
				if removed > 0 {
					logger.Info("verification cache purged", "rows", removed)
				}
			}
		}
	})
}
