// SPDX-License-Identifier: AGPL-3.0-only

package workers

import (
	"context"
	"errors"
	"log/slog"

	"github.com/postwave/postwave/apps/api/internal/deliverability_hub"
	"github.com/postwave/postwave/apps/api/internal/safego"
	"github.com/postwave/postwave/apps/api/internal/spam_trap_guard"
)

// StartDeliverabilityHub launches the companion worker with the same
// dependencies used by the mounted HTTP surface. Cancellation remains a normal
// shutdown condition; every other exit is logged with the historical message.
func StartDeliverabilityHub(ctx context.Context, logger *slog.Logger, dependencies *deliverability_hub.Deps) {
	safego.Go(logger, "deliverability-hub-worker", func() {
		if err := (&deliverability_hub.Worker{Deps: dependencies}).Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
			logger.Warn("deliverability hub worker stopped", "err", err.Error())
		}
	})
}

// StartSpamTrapGuard owns the adjacent deliverability-protection worker launch
// while the HTTP mount remains in the current authenticated route group.
func StartSpamTrapGuard(ctx context.Context, logger *slog.Logger, worker *spam_trap_guard.Worker) {
	safego.Go(logger, "spam-trap-guard-worker", func() {
		if err := worker.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
			logger.Warn("spam-trap-guard worker exited", "err", err.Error())
		}
	})
}
