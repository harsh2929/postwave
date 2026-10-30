// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"log/slog"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/analytics_integrations"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/flowbuilder"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
	"github.com/postwave/postwave/apps/api/internal/track"
)

type AnalyticsIntegrationsDeps struct {
	Pool               *db.Pool
	Logger             *slog.Logger
	SubscriberProfiles *subscribers.Repo
	Secrets            AnalyticsIntegrationSecretResolver
}

type AnalyticsIntegrationSecretResolver interface {
	analytics_integrations.AnalyticsRuntimeSecretResolver
	analytics_integrations.AnalyticsPullerSecretResolver
}

type AnalyticsIntegrationsSurface struct {
	Repository   *analytics_integrations.Repo
	Dependencies *analytics_integrations.Deps
}

func NewAnalyticsIntegrationsSurface(deps AnalyticsIntegrationsDeps) AnalyticsIntegrationsSurface {
	if deps.Pool == nil || deps.SubscriberProfiles == nil {
		return AnalyticsIntegrationsSurface{}
	}
	repository := &analytics_integrations.Repo{Pool: deps.Pool}
	handlerDeps := &analytics_integrations.Deps{
		Repo:     repository,
		Profiles: analytics_integrations.SubscriberProfileSink{Repo: deps.SubscriberProfiles},
		Events: analytics_integrations.TrackEventSink{Repo: &track.Repo{
			Pool: deps.Pool, FlowRuns: &flowbuilder.Repo{Pool: deps.Pool},
		}},
		Logger:         deps.Logger,
		SegmentSecrets: deps.Secrets,
		PostHogBackfiller: analytics_integrations.PostHogRESTBackfiller{
			Credentials: analytics_integrations.PostHogSecretsCredentialResolver{Secrets: deps.Secrets},
		},
		TripleWhaleBackfiller: analytics_integrations.TripleWhaleRESTBackfiller{
			Credentials: analytics_integrations.TripleWhaleSecretsCredentialResolver{Secrets: deps.Secrets},
		},
		MixpanelBackfiller: analytics_integrations.MixpanelRESTBackfiller{
			Credentials: analytics_integrations.MixpanelSecretsCredentialResolver{Secrets: deps.Secrets},
		},
		AmplitudeBackfiller: analytics_integrations.AmplitudeRESTBackfiller{
			Credentials: analytics_integrations.AmplitudeSecretsCredentialResolver{Secrets: deps.Secrets},
		},
	}
	return AnalyticsIntegrationsSurface{Repository: repository, Dependencies: handlerDeps}
}

func MountAuthenticatedAnalyticsIntegrationRoutes(router chi.Router, surface AnalyticsIntegrationsSurface) {
	if router == nil || surface.Dependencies == nil {
		return
	}
	analytics_integrations.MountRoutes(router, surface.Dependencies)
}

func MountPublicAnalyticsIntegrationRoutes(router chi.Router, surface AnalyticsIntegrationsSurface) {
	if router == nil || surface.Dependencies == nil {
		return
	}
	analytics_integrations.MountPublicRoutes(router, surface.Dependencies)
}
