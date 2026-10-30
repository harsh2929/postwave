// SPDX-License-Identifier: AGPL-3.0-only

package workers

import (
	"context"
	"errors"
	"log/slog"

	"github.com/postwave/postwave/apps/api/internal/analytics_integrations"
	"github.com/postwave/postwave/apps/api/internal/safego"
	"github.com/postwave/postwave/apps/api/internal/server"
)

type analyticsIntegrationBackfill struct {
	name       string
	provider   string
	backfiller analytics_integrations.AnalyticsBackfiller
}

type analyticsIntegrationBackfillLaunch struct {
	name   string
	worker *analytics_integrations.AnalyticsBackfillWorker
}

func analyticsIntegrationBackfills(surface server.AnalyticsIntegrationsSurface) []analyticsIntegrationBackfill {
	if surface.Dependencies == nil {
		return nil
	}
	deps := surface.Dependencies
	return []analyticsIntegrationBackfill{
		{name: "posthog", provider: analytics_integrations.ProviderPostHog, backfiller: deps.PostHogBackfiller},
		{name: "triple whale", provider: analytics_integrations.ProviderTripleWhale, backfiller: deps.TripleWhaleBackfiller},
		{name: "mixpanel", provider: analytics_integrations.ProviderMixpanel, backfiller: deps.MixpanelBackfiller},
		{name: "amplitude", provider: analytics_integrations.ProviderAmplitude, backfiller: deps.AmplitudeBackfiller},
	}
}

func analyticsIntegrationBackfillWorkers(logger *slog.Logger, surface server.AnalyticsIntegrationsSurface) []analyticsIntegrationBackfillLaunch {
	if surface.Repository == nil || surface.Dependencies == nil {
		return nil
	}
	specs := analyticsIntegrationBackfills(surface)
	launches := make([]analyticsIntegrationBackfillLaunch, 0, len(specs))
	for _, spec := range specs {
		launches = append(launches, analyticsIntegrationBackfillLaunch{
			name: spec.name,
			worker: &analytics_integrations.AnalyticsBackfillWorker{
				Provider: spec.provider, Deps: surface.Dependencies, Store: surface.Repository,
				Backfiller: spec.backfiller, Logger: logger,
			},
		})
	}
	return launches
}

func StartAnalyticsIntegrationBackfills(ctx context.Context, logger *slog.Logger, surface server.AnalyticsIntegrationsSurface) {
	for _, launch := range analyticsIntegrationBackfillWorkers(logger, surface) {
		launch := launch
		safego.Go(logger, launch.name+" analytics backfill worker", func() {
			if err := launch.worker.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
				logger.Warn(launch.name+" analytics backfill worker exited", "err", err.Error())
			}
		})
	}
}
