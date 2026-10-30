// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/analytics"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/assets"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/engagementclassification"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/reporting"
)

func TestAnalyticsReportingRoutesMatchEveryLegacyRouteScopeAndCacheBoundary(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newAnalyticsReportingRouteDeps(actualRouter)
	MountAnalyticsReportingRoutes(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newAnalyticsReportingRouteDeps(referenceRouter)
	mountLegacyAnalyticsReportingRoutes(referenceDeps)

	// 30, not 28. Two routes joined this surface and neither changes the scope
	// set — both are read:reports, which the expected groups below already carry:
	//   +1 the engagement-classification summary/reach read surface (PRD F01)
	//   +1 the reclassification delta (PRD F12), which makes the supersedes_id
	//      lineage readable instead of merely recorded
	//   +1 its digest-addressed export, for the question asked after the number
	//      moves: a dashboard figure cannot be attached to a dispute, a file can
	// The count is asserted rather than derived because the point is to NOTICE
	// when a route joins an authenticated analytics surface, not to accept
	// whatever is mounted.
	assertRouteSetsAndScopesMatch(t, actualRouter, referenceRouter, 31, [][]apikeys.Scope{
		nil,
		{apikeys.ScopeReadReports},
		{apikeys.ScopeAdmin},
		{apikeys.ScopeReadSubscribers},
		{apikeys.ScopeReadReports, apikeys.ScopeAdmin, apikeys.ScopeReadSubscribers},
	})

	routes := subscriberListSegmentRoutes(t, actualRouter)
	// Served WITH the scope the route requires. Passing nil denied the request,
	// and the assertion then read the header off a REFUSAL — which is a
	// different response with different caching rules. A denial is `no-store`
	// by design: caching a 403 and replaying it to someone who IS allowed is
	// how a permission change fails to take effect.
	read := routeByMethodAndPath(t, routes, http.MethodGet, "/api/v1/analytics/cohorts")
	allowed := serveRouteMiddleware(read, []apikeys.Scope{apikeys.ScopeReadReports})
	// Revalidated on every reuse: a freshness window here served the
	// dashboard's pre-write figures after its own writes.
	if got := allowed.Header().Get("Cache-Control"); got != "private, max-age=0, must-revalidate" {
		t.Fatalf("analytics HeavyRead Cache-Control = %q (status %d)", got, allowed.Code)
	}
	// And the refusal must NOT carry the cacheable directive.
	if got := serveRouteMiddleware(read, nil).Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("a denied analytics read is cacheable: %q", got)
	}
	mutation := routeByMethodAndPath(t, routes, http.MethodPost, "/api/v1/reporting/preview")
	if got := serveRouteMiddleware(mutation, []apikeys.Scope{apikeys.ScopeReadReports}).Header().Get("Cache-Control"); got != "" {
		t.Fatalf("reporting mutation inherited a cache directive: %q", got)
	}
}

func TestAssetLibraryRoutesMatchEveryLegacyRouteAndScope(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newAssetLibraryRouteDeps(actualRouter)
	MountAssetLibraryRoutes(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newAssetLibraryRouteDeps(referenceRouter)
	mountLegacyAssetLibraryRoutes(referenceDeps)

	assertRouteSetsAndScopesMatch(t, actualRouter, referenceRouter, 17, [][]apikeys.Scope{
		nil,
		{apikeys.ScopeReadCampaigns},
		{apikeys.ScopeWriteCampaigns},
		{apikeys.ScopeReadCampaigns, apikeys.ScopeWriteCampaigns},
	})
}

func TestAnalyticsAndAssetSurfacesPreserveDependencyIdentity(t *testing.T) {
	t.Parallel()

	analyticsDeps := newAnalyticsReportingRouteDeps(chi.NewRouter())
	analyticsSurface := MountAnalyticsReportingRoutes(analyticsDeps)
	if analyticsSurface.Analytics == nil || analyticsSurface.Analytics.Service == nil ||
		analyticsSurface.Analytics.Service.Pool != analyticsDeps.Pool || analyticsSurface.Analytics.Logger != analyticsDeps.Logger ||
		analyticsSurface.Analytics.HumanEngagementEnabled != analyticsDeps.HumanEngagementEnabled ||
		analyticsSurface.EngagementClassification == nil ||
		analyticsSurface.EngagementClassification.Store == nil ||
		analyticsSurface.EngagementClassification.Logger != analyticsDeps.Logger ||
		analyticsSurface.Reporting == nil || analyticsSurface.Reporting.Repo == nil ||
		analyticsSurface.Reporting.Repo.Pool != analyticsDeps.Pool || analyticsSurface.Reporting.Logger != analyticsDeps.Logger {
		t.Fatal("analytics/reporting surface changed pool, logger, flag, service, or repository identity")
	}
	engagementRepo, ok := analyticsSurface.EngagementClassification.Store.(*engagementclassification.Repo)
	if !ok || engagementRepo.Pool != analyticsDeps.Pool {
		t.Fatal("engagement-classification surface changed repository type or pool identity")
	}

	assetDeps := newAssetLibraryRouteDeps(chi.NewRouter())
	assetSurface := MountAssetLibraryRoutes(assetDeps)
	if assetSurface == nil || assetSurface.Repo == nil || assetSurface.Repo.Pool != assetDeps.Pool ||
		assetSurface.Storage != assetDeps.Storage || assetSurface.Logger != assetDeps.Logger {
		t.Fatal("asset surface changed pool, storage, logger, or repository identity")
	}
}

func TestAnalyticsAndAssetRoutesRejectStructurallyIncompleteDependencies(t *testing.T) {
	t.Parallel()

	analyticsDeps := newAnalyticsReportingRouteDeps(chi.NewRouter())
	for _, incomplete := range []AnalyticsReportingRouteDeps{
		{Pool: analyticsDeps.Pool, Logger: analyticsDeps.Logger, HumanEngagementEnabled: true},
		{Router: chi.NewRouter(), Logger: analyticsDeps.Logger, HumanEngagementEnabled: true},
	} {
		surface := MountAnalyticsReportingRoutes(incomplete)
		if surface.Analytics != nil || surface.EngagementClassification != nil || surface.Reporting != nil {
			t.Fatal("structurally incomplete analytics dependencies returned a partial surface")
		}
		if incomplete.Router != nil && routeCount(t, incomplete.Router) != 0 {
			t.Fatal("structurally incomplete analytics dependencies registered partial routes")
		}
	}

	assetDeps := newAssetLibraryRouteDeps(chi.NewRouter())
	for _, incomplete := range []AssetLibraryRouteDeps{
		{Pool: assetDeps.Pool, Storage: assetDeps.Storage, Logger: assetDeps.Logger},
		{Router: chi.NewRouter(), Storage: assetDeps.Storage, Logger: assetDeps.Logger},
	} {
		if surface := MountAssetLibraryRoutes(incomplete); surface != nil {
			t.Fatal("structurally incomplete asset dependencies returned a surface")
		}
		if incomplete.Router != nil && routeCount(t, incomplete.Router) != 0 {
			t.Fatal("structurally incomplete asset dependencies registered partial routes")
		}
	}
}

func TestAnalyticsAndAssetRouteOrderAndMainOwnership(t *testing.T) {
	t.Parallel()

	sourceBytes, err := os.ReadFile("analytics_asset_routes.go")
	if err != nil {
		t.Fatalf("read analytics_asset_routes.go: %v", err)
	}
	assertOrderedOccurrences(t, string(sourceBytes), []string{
		"router.Use(httpcache.WithPolicy(httpcache.HeavyRead()))",
		"surface.Analytics.MountRoutes(",
		"surface.EngagementClassification.MountRoutes(",
		"reporting.MountRoutes(",
		"assetRoutes.MountRoutes(",
		"assetRoutes.MountFolderRoutes(",
		"assetRoutes.MountBulkRoutes(",
	})

	root := readAPICompositionRoot(t)
	mainSource := root.main
	assertOrderedOccurrences(t, mainSource, []string{
		"apiserver.MountAnalyticsReportingRoutes(",
		"assetsDeps := apiserver.MountAssetLibraryRoutes(",
		"assetsRefresher := &assets.Refresher{",
		"digestSender := &analytics.DigestSender{",
	})
	for _, forbidden := range []string{
		"analytics.NewExtendedWithLogger(pool, logger)",
		"engagementclassification.HandlerDeps{Store:",
		"reporting.MountRoutes(r,",
		"assets.Deps{Repo: &assets.Repo{Pool: pool}",
		"assetsDeps.MountRoutes(r)",
		"assetsDeps.MountFolderRoutes(r)",
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root retained migrated analytics/asset composition %q", forbidden)
		}
	}
}

func newAnalyticsReportingRouteDeps(router chi.Router) AnalyticsReportingRouteDeps {
	return AnalyticsReportingRouteDeps{
		Router: router, Pool: &db.Pool{}, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), HumanEngagementEnabled: true,
	}
}

func newAssetLibraryRouteDeps(router chi.Router) AssetLibraryRouteDeps {
	return AssetLibraryRouteDeps{
		Router: router, Pool: &db.Pool{}, Storage: &assets.FSStorage{Root: "test-assets"},
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

func mountLegacyAnalyticsReportingRoutes(deps AnalyticsReportingRouteDeps) {
	deps.Router.Group(func(router chi.Router) {
		router.Use(httpcache.WithPolicy(httpcache.HeavyRead()))
		analyticsRoutes := analytics.NewExtendedWithLogger(deps.Pool, deps.Logger)
		analyticsRoutes.HumanEngagementEnabled = deps.HumanEngagementEnabled
		analyticsRoutes.MountRoutes(router)
		(&engagementclassification.HandlerDeps{
			Store:  &engagementclassification.Repo{Pool: deps.Pool},
			Logger: deps.Logger,
		}).MountRoutes(router)
		reporting.MountRoutes(router, &reporting.Deps{Repo: &reporting.Repo{Pool: deps.Pool}, Logger: deps.Logger})
	})
}

func mountLegacyAssetLibraryRoutes(deps AssetLibraryRouteDeps) {
	assetRoutes := &assets.Deps{Repo: &assets.Repo{Pool: deps.Pool}, Storage: deps.Storage, Logger: deps.Logger}
	assetRoutes.MountRoutes(deps.Router)
	assetRoutes.MountFolderRoutes(deps.Router)
	assetRoutes.MountBulkRoutes(deps.Router)
}

func routeByMethodAndPath(t *testing.T, routes []subscriberListSegmentRoute, method, path string) subscriberListSegmentRoute {
	t.Helper()
	for _, route := range routes {
		if route.method == method && route.path == path {
			return route
		}
	}
	t.Fatalf("route %s %s not found", method, path)
	return subscriberListSegmentRoute{}
}
