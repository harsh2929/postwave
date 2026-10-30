// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/pushsuppressions"
	"github.com/postwave/postwave/apps/api/internal/sms"
	"github.com/postwave/postwave/apps/api/internal/social_capture"
	"github.com/postwave/postwave/apps/api/internal/sto_content_optimizer"
)

func TestMessagingEngagementRoutesMatchEveryLegacyRouteAndScope(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newMessagingEngagementRouteDeps(actualRouter)
	MountMessagingEngagementRoutes(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newMessagingEngagementRouteDeps(referenceRouter)
	mountLegacyMessagingEngagementRoutes(referenceDeps)

	assertRouteSetsAndScopesMatch(t, actualRouter, referenceRouter, 105, [][]apikeys.Scope{
		nil,
		{apikeys.ScopeReadReports},
		{apikeys.ScopeAdmin},
		{apikeys.ScopeReadCampaigns},
		{apikeys.ScopeWriteCampaigns},
		{apikeys.ScopeReadSubscribers},
		{apikeys.ScopeWriteSubscribers},
		{apikeys.ScopeReadReports, apikeys.ScopeAdmin, apikeys.ScopeReadCampaigns, apikeys.ScopeWriteCampaigns, apikeys.ScopeReadSubscribers, apikeys.ScopeWriteSubscribers},
	})
}

func TestMessagingEngagementSurfacePreservesDependencyIdentity(t *testing.T) {
	t.Parallel()

	deps := newMessagingEngagementRouteDeps(chi.NewRouter())
	surface := MountMessagingEngagementRoutes(deps)
	if surface.SMS != deps.SMS || surface.SocialCapture != deps.SocialCapture ||
		surface.PushSuppressions == nil || surface.PushSuppressions.Pool != deps.Pool || surface.PushSuppressions.Logger != deps.Logger ||
		surface.ContentOptimizer == nil || surface.ContentOptimizer.Pool != deps.Pool ||
		surface.ContentOptimizer.Repo == nil || surface.ContentOptimizer.Repo.Pool != deps.Pool ||
		surface.ContentOptimizer.Logger != deps.Logger {
		t.Fatal("messaging/engagement surface changed SMS, social, pool, repository, or logger identity")
	}
}

func TestMessagingEngagementRoutesRejectStructurallyIncompleteDependencies(t *testing.T) {
	t.Parallel()

	complete := newMessagingEngagementRouteDeps(chi.NewRouter())
	for _, incomplete := range []MessagingEngagementRouteDeps{
		{Pool: complete.Pool, Logger: complete.Logger, SMS: complete.SMS, SocialCapture: complete.SocialCapture},
		{Router: chi.NewRouter(), Logger: complete.Logger, SMS: complete.SMS, SocialCapture: complete.SocialCapture},
		{Router: chi.NewRouter(), Pool: complete.Pool, Logger: complete.Logger, SocialCapture: complete.SocialCapture},
		{Router: chi.NewRouter(), Pool: complete.Pool, Logger: complete.Logger, SMS: complete.SMS},
	} {
		surface := MountMessagingEngagementRoutes(incomplete)
		if surface.SMS != nil || surface.PushSuppressions != nil || surface.ContentOptimizer != nil || surface.SocialCapture != nil {
			t.Fatal("structurally incomplete messaging dependencies returned a partial surface")
		}
		if incomplete.Router != nil && routeCount(t, incomplete.Router) != 0 {
			t.Fatal("structurally incomplete messaging dependencies registered partial routes")
		}
	}
}

func TestMessagingEngagementRouteOrderAndMainOwnership(t *testing.T) {
	t.Parallel()

	sourceBytes, err := os.ReadFile("messaging_engagement_routes.go")
	if err != nil {
		t.Fatalf("read messaging_engagement_routes.go: %v", err)
	}
	assertOrderedOccurrences(t, string(sourceBytes), []string{
		"deps.SMS.MountRoutes(",
		"pushSuppressions.MountRoutes(",
		"contentOptimizer.MountRoutes(",
		"social_capture.MountRoutes(",
		"deps.SMS.MountInboxRoutes(",
		"deps.SMS.MountInboxExtraRoutes(",
	})

	root := readAPICompositionRoot(t)
	mainSource := root.main
	guardAt := strings.Index(mainSource, "r.Use(pushsuppressions.ProtectRoute43Responses)")
	authAt := strings.Index(mainSource, "authenticatedRoutes.apply(r)")
	mountAt := strings.Index(mainSource, "apiserver.MountMessagingEngagementRoutes(")
	if guardAt < 0 || authAt < 0 || mountAt < 0 || guardAt > authAt || authAt > mountAt {
		t.Fatal("Route43 private response guard must wrap authentication and the messaging route mount")
	}
	assertOrderedOccurrences(t, mainSource, []string{
		"apiserver.MountPublicAnalyticsIntegrationRoutes(",
		"mailchimpv3.Mount(",
		"apiserver.MountMessagingEngagementRoutes(",
		"requireOutboundWebhookHTTPS :=",
	})
	for _, forbidden := range []string{
		"smsDeps.MountRoutes(r)",
		"pushsuppressions.Deps{Pool: pool",
		"sto_content_optimizer.Deps{Pool: pool",
		"social_capture.MountRoutes(r, socialCaptureDeps)",
		"smsDeps.MountInboxRoutes(r)",
		"smsDeps.MountInboxExtraRoutes(r)",
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root retained migrated messaging/engagement composition %q", forbidden)
		}
	}
}

func newMessagingEngagementRouteDeps(router chi.Router) MessagingEngagementRouteDeps {
	pool := &db.Pool{}
	return MessagingEngagementRouteDeps{
		Router: router, Pool: pool, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		SMS: &sms.Deps{}, SocialCapture: &social_capture.Deps{Repo: &social_capture.Repo{Pool: pool}},
		PushSuppressionCursorSigningKey: []byte("route43-test-cursor-key-32-bytes!"),
	}
}

func mountLegacyMessagingEngagementRoutes(deps MessagingEngagementRouteDeps) {
	deps.SMS.MountRoutes(deps.Router)
	(&pushsuppressions.Deps{Pool: deps.Pool, Logger: deps.Logger}).MountRoutes(deps.Router)
	(&sto_content_optimizer.Deps{
		Pool: deps.Pool, Repo: &sto_content_optimizer.Repo{Pool: deps.Pool}, Logger: deps.Logger,
	}).MountRoutes(deps.Router)
	social_capture.MountRoutes(deps.Router, deps.SocialCapture)
	deps.SMS.MountInboxRoutes(deps.Router)
	deps.SMS.MountInboxExtraRoutes(deps.Router)
}
