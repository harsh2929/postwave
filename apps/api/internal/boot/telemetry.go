// SPDX-License-Identifier: AGPL-3.0-only

package boot

import (
	"log/slog"

	"github.com/postwave/postwave/apps/api/internal/telemetry"
)

// TelemetryDependencies owns the tracker and its flush lifecycle. The API
// composition root consumes Tracker and defers Close at the same point where
// the tracker was initialized, preserving shutdown ordering.
type TelemetryDependencies struct {
	Tracker telemetry.Tracker
	logger  *slog.Logger
}

type telemetryTrackerFactory func(*slog.Logger) (telemetry.Tracker, error)

type telemetryStartupDependencies struct {
	logger     *slog.Logger
	newTracker telemetryTrackerFactory
}

// InitializeTelemetry selects the opt-in PostHog tracker from the environment.
// Invalid configuration degrades to a non-nil noop tracker so request handlers
// can emit telemetry without branching or taking the gateway down.
func InitializeTelemetry(logger *slog.Logger) TelemetryDependencies {
	return initializeTelemetry(telemetryStartupDependencies{
		logger:     logger,
		newTracker: telemetry.NewFromEnv,
	})
}

func initializeTelemetry(dependencies telemetryStartupDependencies) TelemetryDependencies {
	tracker, err := dependencies.newTracker(dependencies.logger)
	if err != nil {
		dependencies.logger.Warn("telemetry init failed; falling back to noop", "err", err.Error())
		tracker = telemetry.Noop()
	}
	if tracker.Enabled() {
		dependencies.logger.Info("telemetry: posthog enabled")
	} else {
		dependencies.logger.Info("telemetry: dormant (POSTHOG_API_KEY unset)")
	}
	return TelemetryDependencies{Tracker: tracker, logger: dependencies.logger}
}

// Close flushes the tracker and preserves the gateway's best-effort shutdown
// contract: a telemetry flush error is logged but never masks server shutdown.
func (dependencies TelemetryDependencies) Close() {
	if err := dependencies.Tracker.Close(); err != nil {
		dependencies.logger.Warn("telemetry close failed", "err", err.Error())
	}
}
