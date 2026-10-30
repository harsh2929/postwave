// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/analytics"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/conversions"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/events"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/landingpages"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestAnalyticsRealtimeLandingAndConversionRoutesMatchLegacyScopes(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newAnalyticsRealtimeRouteDeps(actualRouter)
	MountAnalyticsRealtimeAndLandingRoutes(actualDeps)
	MountConversionAdminRoutes(actualRouter, actualDeps.Pool)

	referenceRouter := chi.NewRouter()
	referenceDeps := newAnalyticsRealtimeRouteDeps(referenceRouter)
	mountLegacyAnalyticsRealtimeLandingAndConversionRoutes(referenceDeps)

	actual := subscriberListSegmentRoutes(t, actualRouter)
	reference := subscriberListSegmentRoutes(t, referenceRouter)
	if len(actual) != len(reference) {
		t.Fatalf("migrated route count = %d, legacy route count = %d", len(actual), len(reference))
	}
	// 39 + the two revenue-graph reads (the graph itself and its edge
	// enumeration), which are the read side of the structural conversion edges.
	if len(actual) != 41 {
		t.Fatalf("analytics/realtime/landing/conversion route count = %d, want 41", len(actual))
	}
	for index := range reference {
		got, want := actual[index], reference[index]
		if got.method != want.method || got.path != want.path || len(got.middlewares) != len(want.middlewares) {
			t.Fatalf("route[%d] = %s %s (%d middleware), want %s %s (%d)", index, got.method, got.path, len(got.middlewares), want.method, want.path, len(want.middlewares))
		}
		for _, scopes := range [][]apikeys.Scope{
			nil,
			{apikeys.ScopeReadReports},
			{apikeys.ScopeReadSubscribers},
			{apikeys.ScopeReadReports, apikeys.ScopeReadSubscribers},
			{apikeys.ScopeReadCampaigns},
			{apikeys.ScopeAdmin},
			{apikeys.ScopeReadReports, apikeys.ScopeReadSubscribers, apikeys.ScopeReadCampaigns, apikeys.ScopeAdmin},
		} {
			gotResponse := serveRouteMiddleware(got, scopes)
			wantResponse := serveRouteMiddleware(want, scopes)
			if gotResponse.Code != wantResponse.Code || gotResponse.Body.String() != wantResponse.Body.String() {
				t.Errorf("%s %s scopes %v = (%d,%q), want (%d,%q)", got.method, got.path, scopes, gotResponse.Code, gotResponse.Body.String(), wantResponse.Code, wantResponse.Body.String())
			}
		}
	}
}

func TestConversionRawFeedRequiresReportsAndSubscribersScopes(t *testing.T) {
	t.Parallel()

	router := chi.NewRouter()
	MountConversionAdminRoutes(router, &db.Pool{})

	for _, scopes := range [][]apikeys.Scope{
		{apikeys.ScopeReadReports},
		{apikeys.ScopeReadSubscribers},
	} {
		request := httptest.NewRequest(http.MethodGet, "/api/v1/conversions", nil)
		ctx := middleware.WithAPIKeyAuth(request.Context())
		ctx = apikeys.WithScopes(ctx, scopes)
		response := httptest.NewRecorder()

		router.ServeHTTP(response, request.WithContext(ctx))

		if response.Code != http.StatusForbidden ||
			!strings.Contains(response.Body.String(), "insufficient_scope") {
			t.Fatalf(
				"GET /api/v1/conversions with partial scopes %v: status=%d body=%q, want 403 insufficient_scope",
				scopes,
				response.Code,
				response.Body.String(),
			)
		}
	}

	// With both scopes the request reaches AdminList. Its missing tenant is a
	// deliberate database-free witness that the production route gate passed.
	request := httptest.NewRequest(http.MethodGet, "/api/v1/conversions", nil)
	ctx := middleware.WithAPIKeyAuth(request.Context())
	ctx = apikeys.WithScopes(ctx, []apikeys.Scope{
		apikeys.ScopeReadReports,
		apikeys.ScopeReadSubscribers,
	})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request.WithContext(ctx))
	if response.Code != http.StatusUnauthorized ||
		!strings.Contains(response.Body.String(), "no_tenant") {
		t.Fatalf(
			"GET /api/v1/conversions with both scopes: status=%d body=%q, want handler's 401 no_tenant",
			response.Code,
			response.Body.String(),
		)
	}
}

func TestAnalyticsRealtimeAndConversionSurfacesPreserveDependencyIdentity(t *testing.T) {
	t.Parallel()

	deps := newAnalyticsRealtimeRouteDeps(chi.NewRouter())
	surface := MountAnalyticsRealtimeAndLandingRoutes(deps)
	if surface.Repo == nil || surface.Handlers == nil || surface.Stream == nil || surface.LandingPage == nil {
		t.Fatal("complete dependencies returned an incomplete analytics/realtime surface")
	}
	if surface.Repo.Pool != deps.Pool || !surface.Repo.HumanEngagementEnabled ||
		surface.Handlers.Repo != surface.Repo || surface.Stream.Repo != surface.Repo ||
		surface.Stream.PollInterval != 2*time.Second || surface.LandingPage.Repo.Pool != deps.Pool ||
		surface.EventReplay != deps.EventReplay {
		t.Fatal("analytics/realtime surface changed pool, feature flag, repository, interval, or replay identity")
	}
	conversionHandlers := MountConversionAdminRoutes(chi.NewRouter(), deps.Pool)
	if conversionHandlers == nil || conversionHandlers.Repo == nil || conversionHandlers.Repo.Pool != deps.Pool {
		t.Fatal("conversion surface changed pool identity")
	}

	for _, incomplete := range []AnalyticsRealtimeRouteDeps{
		{Pool: deps.Pool, Events: deps.Events, EventReplay: deps.EventReplay},
		{Router: chi.NewRouter(), Events: deps.Events, EventReplay: deps.EventReplay},
		{Router: chi.NewRouter(), Pool: deps.Pool, EventReplay: deps.EventReplay},
		{Router: chi.NewRouter(), Pool: deps.Pool, Events: deps.Events},
	} {
		incompleteSurface := MountAnalyticsRealtimeAndLandingRoutes(incomplete)
		if incompleteSurface.Repo != nil || incompleteSurface.Handlers != nil || incompleteSurface.Stream != nil ||
			incompleteSurface.LandingPage != nil || incompleteSurface.EventReplay != nil {
			t.Fatal("structurally incomplete dependencies returned a partial analytics/realtime surface")
		}
		if incomplete.Router != nil && routeCount(t, incomplete.Router) != 0 {
			t.Fatal("structurally incomplete dependencies registered partial routes")
		}
	}
	conversionRouter := chi.NewRouter()
	if got := MountConversionAdminRoutes(conversionRouter, nil); got != nil || routeCount(t, conversionRouter) != 0 {
		t.Fatal("nil conversion pool returned handlers or registered routes")
	}
	if got := MountConversionAdminRoutes(nil, deps.Pool); got != nil {
		t.Fatal("nil conversion router returned handlers")
	}
}

func TestAnalyticsRealtimeRouteOrderAndMainOwnership(t *testing.T) {
	t.Parallel()

	sourceBytes, err := os.ReadFile("analytics_realtime_routes.go")
	if err != nil {
		t.Fatalf("read analytics_realtime_routes.go: %v", err)
	}
	assertOrderedOccurrences(t, string(sourceBytes), []string{
		`Get("/api/v1/campaigns/{id}/report"`,
		`Get("/api/v1/dashboard/stats"`,
		`Post("/api/v1/streams/token"`,
		`Get("/api/v1/dashboard/live"`,
		`Get("/api/v1/events"`,
		`Get("/api/v1/events/replay"`,
		`Post("/api/v1/events/publish"`,
		`Get("/api/v1/voice/sequences/{id}/funnel"`,
		`Get("/api/v1/campaigns/{id}/events"`,
		`Get("/api/v1/landing-pages"`,
		`Delete("/api/v1/landing-pages/{id}"`,
		"func MountConversionAdminRoutes",
		`Get("/api/v1/conversions"`,
		`Delete("/api/v1/conversions/keys/{id}"`,
		"conversions.Mount(",
		"conversions.MountRevenueGraph(",
	})

	root := readAPICompositionRoot(t)
	mainSource := root.main
	assertOrderedOccurrences(t, mainSource, []string{
		"apiserver.MountCampaignReadRoutes(",
		"apiserver.MountAnalyticsRealtimeAndLandingRoutes(",
		"analyticsRepo := analyticsRealtime.Repo",
		"apiserver.MountCampaignTemplateRoutes(",
		"apiserver.MountConversionAdminRoutes(",
		"apiserver.MountCollaborationIntegrations(",
	})
	for _, forbidden := range []string{
		"analyticsDeps :=",
		"heavyRead :=",
		"streamDeps :=",
		"landingDeps :=",
		"convDeps :=",
		`r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get("/api/v1/events"`,
		`r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/conversions/keys"`,
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root retained migrated analytics/realtime composition %q", forbidden)
		}
	}
}

func newAnalyticsRealtimeRouteDeps(router chi.Router) AnalyticsRealtimeRouteDeps {
	pool := &db.Pool{}
	return AnalyticsRealtimeRouteDeps{
		Router:                 router,
		Pool:                   pool,
		Events:                 events.NewBus(),
		EventReplay:            &events.LogReplay{Pool: pool},
		StreamTokenSecret:      []byte("stream-secret"),
		HumanEngagementEnabled: true,
	}
}

func mountLegacyAnalyticsRealtimeLandingAndConversionRoutes(deps AnalyticsRealtimeRouteDeps) {
	analyticsRepo := &analytics.Repo{Pool: deps.Pool, HumanEngagementEnabled: deps.HumanEngagementEnabled}
	analyticsHandlers := &analytics.Deps{Repo: analyticsRepo}
	heavyRead := httpcache.WithPolicy(httpcache.HeavyRead())
	readReports := apikeys.RequireScope(apikeys.ScopeReadReports)
	deps.Router.With(readReports, heavyRead).Get("/api/v1/campaigns/{id}/report", analyticsHandlers.CampaignReport)
	deps.Router.With(readReports, heavyRead).Get("/api/v1/campaigns/{id}/timeseries", analyticsHandlers.CampaignTimeseries)
	deps.Router.With(readReports, heavyRead).Get("/api/v1/campaigns/{id}/anomalies", analyticsHandlers.CampaignAnomalies)
	deps.Router.With(readReports, heavyRead).Get("/api/v1/dashboard/stats", analyticsHandlers.DashboardStats)
	deps.Router.With(readReports, heavyRead).Get("/api/v1/dashboard/anomalies", analyticsHandlers.ListAnomalies)
	deps.Router.With(readReports, heavyRead).Get("/api/v1/dashboard/digest", analyticsHandlers.GetDigestPrefs)
	deps.Router.With(readReports).Put("/api/v1/dashboard/digest", analyticsHandlers.PutDigestPrefs)
	deps.Router.With(readReports, heavyRead).Get("/api/v1/dashboard/layout", analyticsHandlers.GetLayout)
	deps.Router.With(readReports).Put("/api/v1/dashboard/layout", analyticsHandlers.PutLayout)
	deps.Router.With(readReports, heavyRead).Get("/api/v1/dashboard/benchmarks", analyticsHandlers.GetBenchmarks)
	deps.Router.With(apikeys.ProtectCredentialResponses, readReports).Post("/api/v1/streams/token", apikeys.StreamTokenHandler(deps.StreamTokenSecret, apikeys.StreamTokenTTL))
	deps.Router.With(readReports).Get("/api/v1/dashboard/live", analytics.DashboardLive(deps.Pool))
	deps.Router.With(readReports).Get("/api/v1/events", events.NewHandler(deps.Events))
	deps.Router.With(readReports).Get("/api/v1/events/stream", events.NewHandler(deps.Events))
	deps.Router.With(readReports).Get("/api/v1/events/replay", events.NewReplayHandler(deps.EventReplay).ServeHTTP)
	deps.Router.With(readReports).Post("/api/v1/events/subscriptions", events.SubscribeHandler())
	deps.Router.With(readReports).Post("/api/v1/events/publish", events.PublishHandler(deps.Events))
	deps.Router.With(readReports, heavyRead).Get("/api/v1/voice/sequences/{id}/funnel", analyticsHandlers.SequenceFunnel)
	stream := &analytics.StreamDeps{Repo: analyticsRepo, PollInterval: 2 * time.Second}
	deps.Router.With(readReports).Get("/api/v1/campaigns/{id}/events", stream.CampaignEvents)

	landingPage := &landingpages.Deps{Repo: &landingpages.Repo{Pool: deps.Pool}}
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/landing-pages", landingPage.List)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/landing-pages/{id}", landingPage.Get)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/landing-pages/{id}/leads", landingPage.Leads)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/landing-pages/{id}/leads.csv", landingPage.LeadsCSV)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/landing-pages/{id}/versions", landingPage.Versions)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/landing-pages/{id}/versions/{version}/restore", landingPage.Restore)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/landing-pages", landingPage.Create)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Patch("/api/v1/landing-pages/{id}", landingPage.Update)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Delete("/api/v1/landing-pages/{id}", landingPage.Delete)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).Get("/api/v1/landing-pages/{id}/variants", landingPage.ListVariantsHandler)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/landing-pages/{id}/variants", landingPage.CreateVariantHandler)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Patch("/api/v1/landing-pages/{id}/variants/{variant_id}", landingPage.UpdateVariantHandler)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Delete("/api/v1/landing-pages/{id}/variants/{variant_id}", landingPage.DeleteVariantHandler)

	conversionHandlers := &conversions.Deps{Repo: &conversions.Repo{Pool: deps.Pool}}
	deps.Router.With(apikeys.RequireAllScopes(
		apikeys.ScopeReadReports,
		apikeys.ScopeReadSubscribers,
	)).Get("/api/v1/conversions", conversionHandlers.AdminList)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/conversions/keys", conversionHandlers.AdminListKeys)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/conversions/keys", conversionHandlers.AdminCreateKey)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Delete("/api/v1/conversions/keys/{id}", conversionHandlers.AdminRevokeKey)
	conversions.Mount(deps.Router, conversionHandlers)
	conversions.MountRevenueGraph(deps.Router, conversionHandlers)
}
