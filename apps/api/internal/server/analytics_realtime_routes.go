// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/analytics"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/conversions"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/events"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/landingpages"
)

type AnalyticsRealtimeRouteDeps struct {
	Router                 chi.Router
	Pool                   *db.Pool
	Events                 *events.Bus
	EventReplay            *events.LogReplay
	StreamTokenSecret      []byte
	HumanEngagementEnabled bool
}

type AnalyticsRealtimeSurface struct {
	Repo        *analytics.Repo
	Handlers    *analytics.Deps
	Stream      *analytics.StreamDeps
	LandingPage *landingpages.Deps
	EventReplay *events.LogReplay
}

func MountAnalyticsRealtimeAndLandingRoutes(deps AnalyticsRealtimeRouteDeps) AnalyticsRealtimeSurface {
	if deps.Router == nil || deps.Pool == nil || deps.Events == nil || deps.EventReplay == nil {
		return AnalyticsRealtimeSurface{}
	}

	repo := &analytics.Repo{Pool: deps.Pool, HumanEngagementEnabled: deps.HumanEngagementEnabled}
	handlers := &analytics.Deps{Repo: repo}
	heavyRead := httpcache.WithPolicy(httpcache.HeavyRead())
	readReports := apikeys.RequireScope(apikeys.ScopeReadReports)
	deps.Router.With(readReports, heavyRead).Get("/api/v1/campaigns/{id}/report", handlers.CampaignReport)
	deps.Router.With(readReports, heavyRead).Get("/api/v1/campaigns/{id}/timeseries", handlers.CampaignTimeseries)
	deps.Router.With(readReports, heavyRead).Get("/api/v1/campaigns/{id}/anomalies", handlers.CampaignAnomalies)
	deps.Router.With(readReports, heavyRead).Get("/api/v1/dashboard/stats", handlers.DashboardStats)
	deps.Router.With(readReports, heavyRead).Get("/api/v1/dashboard/anomalies", handlers.ListAnomalies)
	deps.Router.With(readReports, heavyRead).Get("/api/v1/dashboard/digest", handlers.GetDigestPrefs)
	deps.Router.With(readReports).Put("/api/v1/dashboard/digest", handlers.PutDigestPrefs)
	deps.Router.With(readReports, heavyRead).Get("/api/v1/dashboard/layout", handlers.GetLayout)
	deps.Router.With(readReports).Put("/api/v1/dashboard/layout", handlers.PutLayout)
	deps.Router.With(readReports, heavyRead).Get("/api/v1/dashboard/benchmarks", handlers.GetBenchmarks)
	deps.Router.With(apikeys.ProtectCredentialResponses, readReports).Post("/api/v1/streams/token", apikeys.StreamTokenHandler(deps.StreamTokenSecret, apikeys.StreamTokenTTL))
	deps.Router.With(readReports).Get("/api/v1/dashboard/live", analytics.DashboardLive(deps.Pool))
	deps.Router.With(readReports).Get("/api/v1/events", events.NewHandler(deps.Events))
	deps.Router.With(readReports).Get("/api/v1/events/stream", events.NewHandler(deps.Events))
	deps.Router.With(readReports).Get("/api/v1/events/replay", events.NewReplayHandler(deps.EventReplay).ServeHTTP)
	deps.Router.With(readReports).Post("/api/v1/events/subscriptions", events.SubscribeHandler())
	deps.Router.With(readReports).Post("/api/v1/events/publish", events.PublishHandler(deps.Events))
	deps.Router.With(readReports, heavyRead).Get("/api/v1/voice/sequences/{id}/funnel", handlers.SequenceFunnel)
	stream := &analytics.StreamDeps{Repo: repo, PollInterval: 2 * time.Second}
	deps.Router.With(readReports).Get("/api/v1/campaigns/{id}/events", stream.CampaignEvents)

	landingPage := &landingpages.Deps{Repo: &landingpages.Repo{Pool: deps.Pool}}
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/landing-pages", landingPage.List)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/landing-pages/{id}", landingPage.Get)
	// LAND-022: per-page leads (conversions) view + CSV export.
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/landing-pages/{id}/leads", landingPage.Leads)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/landing-pages/{id}/leads.csv", landingPage.LeadsCSV)
	// LAND-039: version history + restore.
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/landing-pages/{id}/versions", landingPage.Versions)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/landing-pages/{id}/versions/{version}/restore", landingPage.Restore)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/landing-pages", landingPage.Create)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Patch("/api/v1/landing-pages/{id}", landingPage.Update)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Delete("/api/v1/landing-pages/{id}", landingPage.Delete)
	// LAND-037: A/B page variants with traffic split + per-variant metrics.
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/landing-pages/{id}/variants", landingPage.ListVariantsHandler)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/landing-pages/{id}/variants", landingPage.CreateVariantHandler)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Patch("/api/v1/landing-pages/{id}/variants/{variant_id}", landingPage.UpdateVariantHandler)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Delete("/api/v1/landing-pages/{id}/variants/{variant_id}", landingPage.DeleteVariantHandler)

	return AnalyticsRealtimeSurface{
		Repo: repo, Handlers: handlers, Stream: stream, LandingPage: landingPage, EventReplay: deps.EventReplay,
	}
}

// MountConversionSigningKeyRoutes registers v2 signed-ingest key management.
//
// Deliberately NOT part of MountConversionAdminRoutes: that function is
// compared route-for-route against a frozen legacy reference to prove the
// migration was faithful, and adding new functionality inside it would make
// that parity check meaningless rather than make these routes safer.
//
// Until these routes existed the hardened HMAC ingest path could only be used
// by someone able to INSERT into conversion_ingest_secrets by hand.
func MountConversionSigningKeyRoutes(
	router chi.Router,
	pool *db.Pool,
	cipher conversions.EnvelopeCipher,
) {
	conversions.MountIngestSecretRoutes(
		router,
		&conversions.IngestSecretDeps{
			Store: &conversions.IngestSecretStore{Pool: pool, Cipher: cipher},
		},
		apikeys.RequireScope(apikeys.ScopeAdmin),
	)
}

func MountConversionAdminRoutes(router chi.Router, pool *db.Pool) *conversions.Deps {
	if router == nil || pool == nil {
		return nil
	}
	handlers := &conversions.Deps{Repo: &conversions.Repo{Pool: pool}}
	// Raw conversion facts carry subscriber_email plus tenant-defined
	// properties. Treat them like the Product Events raw feed: report access
	// alone may read aggregates, but recipient-linked evidence requires both
	// report and subscriber-read scopes.
	router.With(apikeys.RequireAllScopes(
		apikeys.ScopeReadReports,
		apikeys.ScopeReadSubscribers,
	)).Get("/api/v1/conversions", handlers.AdminList)
	router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/conversions/keys", handlers.AdminListKeys)
	router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/conversions/keys", handlers.AdminCreateKey)
	router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Delete("/api/v1/conversions/keys/{id}", handlers.AdminRevokeKey)
	conversions.Mount(router, handlers)
	conversions.MountRevenueGraph(router, handlers)
	return handlers
}
