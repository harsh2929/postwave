// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/api_usage_dashboard"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/developer_marketplace"
	"github.com/postwave/postwave/apps/api/internal/integrations"
	"github.com/postwave/postwave/apps/api/internal/onboarding_progress"
	"github.com/postwave/postwave/apps/api/internal/reply_analytics"
	"github.com/postwave/postwave/apps/api/internal/resend_unopened"
	"github.com/postwave/postwave/apps/api/internal/subject_analyzer"
	"github.com/postwave/postwave/apps/api/internal/subscriber_notes"
	"github.com/postwave/postwave/apps/api/internal/uploads"
)

func TestPlatformCatalogRoutesMatchEveryLegacyRouteAndScope(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newPlatformCatalogRouteDeps(actualRouter)
	MountPlatformCatalogRoutes(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newPlatformCatalogRouteDeps(referenceRouter)
	mountLegacyPlatformCatalogRoutes(referenceDeps)

	assertRouteSetsAndScopesMatch(t, actualRouter, referenceRouter, 52, [][]apikeys.Scope{
		nil,
		{apikeys.ScopeReadReports},
		{apikeys.ScopeAdmin},
		{apikeys.ScopeReadReports, apikeys.ScopeAdmin},
	})
}

func TestSubscriberCampaignInsightRoutesMatchEveryLegacyRouteAndScope(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newSubscriberCampaignInsightRouteDeps(actualRouter)
	MountSubscriberCampaignInsightRoutes(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newSubscriberCampaignInsightRouteDeps(referenceRouter)
	mountLegacySubscriberCampaignInsightRoutes(referenceDeps)

	// 20 since onboarding_progress gained GET + PUT /api/v1/onboarding/steps —
	// the durable per-user onboarding DECISIONS that used to live in per-device
	// localStorage. Both mounts carry them; only this literal was stale.
	assertRouteSetsAndScopesMatch(t, actualRouter, referenceRouter, 20, [][]apikeys.Scope{
		nil,
		{apikeys.ScopeReadReports},
		{apikeys.ScopeAdmin},
		{apikeys.ScopeReadReports, apikeys.ScopeAdmin},
	})
}

func TestPlatformAndInsightSurfacesPreserveDependencyIdentity(t *testing.T) {
	t.Parallel()

	platformDeps := newPlatformCatalogRouteDeps(chi.NewRouter())
	platform := MountPlatformCatalogRoutes(platformDeps)
	if platform.APIUsage == nil || platform.APIUsage.Pool != platformDeps.Pool || platform.APIUsage.Logger != nil ||
		platform.Marketplace == nil || platform.Marketplace.Repo == nil || platform.Marketplace.Repo.Pool != platformDeps.Pool ||
		platform.Marketplace.ReviewSecret != platformDeps.ReviewSecret || platform.Marketplace.Logger != platformDeps.Logger ||
		platform.Integrations == nil || platform.Integrations.Pool != platformDeps.Pool || platform.Integrations.Logger != platformDeps.Logger {
		t.Fatal("platform catalog surface changed pool, logger, or review-secret identity")
	}

	insightDeps := newSubscriberCampaignInsightRouteDeps(chi.NewRouter())
	insights := MountSubscriberCampaignInsightRoutes(insightDeps)
	if insights.Notes == nil || insights.Notes.Pool != insightDeps.Pool || insights.Notes.Logger != insightDeps.Logger || insights.Notes.Store != insightDeps.Store ||
		insights.Resend == nil || insights.Resend.Pool != insightDeps.Pool || insights.Resend.Logger != nil ||
		insights.Replies == nil || insights.Replies.Pool != insightDeps.Pool || insights.Replies.Logger != nil ||
		insights.Onboarding == nil || insights.Onboarding.Pool != insightDeps.Pool || insights.Onboarding.Logger != nil ||
		insights.Subjects == nil || insights.Subjects.Pool != insightDeps.Pool || insights.Subjects.Logger != nil {
		t.Fatal("subscriber/campaign insight surface changed pool, logger, or object-store identity")
	}
}

func TestPlatformAndInsightRoutesRejectStructurallyIncompleteDependencies(t *testing.T) {
	t.Parallel()

	platform := newPlatformCatalogRouteDeps(chi.NewRouter())
	for _, incomplete := range []PlatformCatalogRouteDeps{
		{Pool: platform.Pool, Logger: platform.Logger, ReviewSecret: platform.ReviewSecret},
		{Router: chi.NewRouter(), Logger: platform.Logger, ReviewSecret: platform.ReviewSecret},
	} {
		surface := MountPlatformCatalogRoutes(incomplete)
		if surface.APIUsage != nil || surface.Marketplace != nil || surface.Integrations != nil {
			t.Fatal("structurally incomplete platform dependencies returned a partial surface")
		}
		if incomplete.Router != nil && routeCount(t, incomplete.Router) != 0 {
			t.Fatal("structurally incomplete platform dependencies registered partial routes")
		}
	}

	insight := newSubscriberCampaignInsightRouteDeps(chi.NewRouter())
	for _, incomplete := range []SubscriberCampaignInsightRouteDeps{
		{Pool: insight.Pool, Logger: insight.Logger, Store: insight.Store},
		{Router: chi.NewRouter(), Logger: insight.Logger, Store: insight.Store},
	} {
		surface := MountSubscriberCampaignInsightRoutes(incomplete)
		if surface.Notes != nil || surface.Resend != nil || surface.Replies != nil || surface.Onboarding != nil || surface.Subjects != nil {
			t.Fatal("structurally incomplete insight dependencies returned a partial surface")
		}
		if incomplete.Router != nil && routeCount(t, incomplete.Router) != 0 {
			t.Fatal("structurally incomplete insight dependencies registered partial routes")
		}
	}
}

func TestPlatformAndInsightRouteOrderAndMainOwnership(t *testing.T) {
	t.Parallel()

	sourceBytes, err := os.ReadFile("platform_insights_routes.go")
	if err != nil {
		t.Fatalf("read platform_insights_routes.go: %v", err)
	}
	assertOrderedOccurrences(t, string(sourceBytes), []string{
		"api_usage_dashboard.MountRoutes(",
		"developer_marketplace.MountRoutes(",
		"integrations.MountRoutes(",
		"func MountSubscriberCampaignInsightRoutes",
		"subscriber_notes.MountRoutes(",
		"resend_unopened.MountRoutes(",
		"MountSendWindowRoutes(",
		"reply_analytics.MountRoutes(",
		"onboarding_progress.MountRoutes(",
		"subject_analyzer.MountRoutes(",
	})

	root := readAPICompositionRoot(t)
	mainSource := root.main
	assertOrderedOccurrences(t, mainSource, []string{
		"listHealthHistoryWorker.Run(outboxCtx)",
		"apiserver.MountPlatformCatalogRoutes(",
		"apiserver.MountSupportIntegrationsSurface(",
		"apiworkers.StartDeliverabilityHub(",
		"apiserver.MountSubscriberCampaignInsightRoutes(",
		"tenantGovernance :=",
	})
	for _, forbidden := range []string{
		"api_usage_dashboard.MountRoutes(r,",
		"developer_marketplace.MountRoutes(r,",
		"integrations.MountRoutes(r,",
		"subscriber_notes.MountRoutes(r,",
		"resend_unopened.MountRoutes(r,",
		"apiserver.MountSendWindowRoutes(apiserver.Deps{Router: r, Pool: pool})",
		"reply_analytics.MountRoutes(r,",
		"onboarding_progress.MountRoutes(r,",
		"subject_analyzer.MountRoutes(r,",
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root retained migrated platform/insight composition %q", forbidden)
		}
	}
}

func newPlatformCatalogRouteDeps(router chi.Router) PlatformCatalogRouteDeps {
	return PlatformCatalogRouteDeps{
		Router: router, Pool: &db.Pool{}, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), ReviewSecret: "review-secret",
	}
}

func newSubscriberCampaignInsightRouteDeps(router chi.Router) SubscriberCampaignInsightRouteDeps {
	return SubscriberCampaignInsightRouteDeps{
		Router: router, Pool: &db.Pool{}, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Store: uploads.NewMemoryStore(),
	}
}

func mountLegacyPlatformCatalogRoutes(deps PlatformCatalogRouteDeps) {
	api_usage_dashboard.MountRoutes(deps.Router, &api_usage_dashboard.Deps{Pool: deps.Pool})
	developer_marketplace.MountRoutes(deps.Router, &developer_marketplace.Deps{
		Repo: &developer_marketplace.Repo{Pool: deps.Pool}, ReviewSecret: deps.ReviewSecret, Logger: deps.Logger,
	})
	integrations.MountRoutes(deps.Router, &integrations.Deps{Pool: deps.Pool, Logger: deps.Logger})
}

func mountLegacySubscriberCampaignInsightRoutes(deps SubscriberCampaignInsightRouteDeps) {
	subscriber_notes.MountRoutes(deps.Router, &subscriber_notes.Deps{Pool: deps.Pool, Logger: deps.Logger, Store: deps.Store})
	resend_unopened.MountRoutes(deps.Router, &resend_unopened.Deps{Pool: deps.Pool})
	MountSendWindowRoutes(Deps{Router: deps.Router, Pool: deps.Pool})
	reply_analytics.MountRoutes(deps.Router, &reply_analytics.Deps{Pool: deps.Pool})
	onboarding_progress.MountRoutes(deps.Router, &onboarding_progress.Deps{Pool: deps.Pool})
	subject_analyzer.MountRoutes(deps.Router, &subject_analyzer.Deps{Pool: deps.Pool})
}
