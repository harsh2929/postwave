// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/abtests"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/campaigntemplates"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/send_time_opt"
	"github.com/postwave/postwave/apps/api/internal/send_window"
	"github.com/postwave/postwave/apps/api/internal/sending"
	"github.com/postwave/postwave/apps/api/internal/sending_identity"
)

func TestMountCampaignSendingSurfaceMatchesEveryLegacyRouteAndScope(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newCampaignSendingDeps(actualRouter)
	MountCampaignSendingSurface(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newCampaignSendingDeps(referenceRouter)
	mountLegacyCampaignSendingSurface(referenceDeps)

	actual := subscriberListSegmentRoutes(t, actualRouter)
	reference := subscriberListSegmentRoutes(t, referenceRouter)
	if len(actual) != len(reference) {
		t.Fatalf("migrated route count = %d, legacy route count = %d", len(actual), len(reference))
	}
	// 117 + the three campaign editing-lease routes (GET/POST/DELETE
	// /api/v1/campaigns/{id}/edit-lease) + the three immutable content-revision
	// routes, plus the dedicated Fact Contract authoring route:
	//
	//   GET  /api/v1/campaigns/{id}/content-revisions
	//   GET  /api/v1/campaigns/{id}/content-revisions/{revisionID}
	//   POST /api/v1/campaigns/{id}/content-revisions
	//   PUT  /api/v1/campaigns/{id}/fact-contract
	//
	// Both surfaces moved together, so the equality check above never wavered —
	// which is exactly why the literal is here. It is not decoration: that check
	// passes just as happily when BOTH surfaces lose the same routes, so without
	// a number this test would keep reporting green while the surface shrank.
	// The review GET/POST pair and linked-block impact read bring this to 127.
	if len(actual) != 127 {
		t.Fatalf("campaign/sending route count = %d, want 127", len(actual))
	}

	scopeSets := []struct {
		name   string
		scopes []apikeys.Scope
	}{
		{name: "none"},
		{name: "read campaigns", scopes: []apikeys.Scope{apikeys.ScopeReadCampaigns}},
		{name: "write campaigns", scopes: []apikeys.Scope{apikeys.ScopeWriteCampaigns}},
		{name: "read reports", scopes: []apikeys.Scope{apikeys.ScopeReadReports}},
		{name: "send transactional", scopes: []apikeys.Scope{apikeys.ScopeSendTransactional}},
		{name: "admin", scopes: []apikeys.Scope{apikeys.ScopeAdmin}},
		{name: "write and send", scopes: []apikeys.Scope{
			apikeys.ScopeWriteCampaigns,
			apikeys.ScopeSendTransactional,
		}},
		{name: "all relevant", scopes: []apikeys.Scope{
			apikeys.ScopeReadCampaigns,
			apikeys.ScopeWriteCampaigns,
			apikeys.ScopeReadReports,
			apikeys.ScopeSendTransactional,
			apikeys.ScopeAdmin,
		}},
	}

	for index := range reference {
		want := reference[index]
		got := actual[index]
		if got.method != want.method || got.path != want.path {
			t.Fatalf("route[%d] = %s %s, want %s %s", index, got.method, got.path, want.method, want.path)
		}
		if len(got.middlewares) != len(want.middlewares) {
			t.Fatalf("%s %s middleware count = %d, want %d", got.method, got.path, len(got.middlewares), len(want.middlewares))
		}
		for _, scopeSet := range scopeSets {
			gotResponse := serveRouteMiddleware(got, scopeSet.scopes)
			wantResponse := serveRouteMiddleware(want, scopeSet.scopes)
			if gotResponse.Code != wantResponse.Code || gotResponse.Body.String() != wantResponse.Body.String() {
				t.Errorf(
					"%s %s with %s scopes = (%d, %q), want (%d, %q)",
					got.method,
					got.path,
					scopeSet.name,
					gotResponse.Code,
					gotResponse.Body.String(),
					wantResponse.Code,
					wantResponse.Body.String(),
				)
			}
		}
	}
}

func TestMountCampaignTemplateRoutesAdminScopesReferenceReview(t *testing.T) {
	router := chi.NewRouter()
	MountCampaignTemplateRoutes(Deps{
		Router:            router,
		CampaignTemplates: &campaigntemplates.Deps{},
	})
	review := routeByMethodAndPath(
		t,
		subscriberListSegmentRoutes(t, router),
		http.MethodPost,
		"/api/v1/campaign-templates/{id}/review-decisions",
	)

	for _, scopes := range [][]apikeys.Scope{
		nil,
		{apikeys.ScopeReadCampaigns},
		{apikeys.ScopeWriteCampaigns},
	} {
		response := serveRouteMiddleware(review, scopes)
		if response.Code != http.StatusForbidden {
			t.Errorf("scopes=%v status=%d, want 403", scopes, response.Code)
		}
	}
	response := serveRouteMiddleware(review, []apikeys.Scope{apikeys.ScopeAdmin})
	if response.Code != 299 || response.Body.String() != "scope-passed" {
		t.Fatalf("admin status=%d body=%q, want middleware pass",
			response.Code, response.Body.String())
	}
}

func TestMountSendTimeOptimizationRoutesRegistersWriteScopedSchedulePreview(t *testing.T) {
	router := chi.NewRouter()
	MountSendTimeOptimizationRoutes(Deps{
		Router:               router,
		SendTimeOptimization: &send_time_opt.Deps{},
	})
	preview := routeByMethodAndPath(
		t,
		subscriberListSegmentRoutes(t, router),
		http.MethodPost,
		"/api/v1/campaigns/{id}/schedule-by-best-time/preview",
	)

	for _, scopes := range [][]apikeys.Scope{
		nil,
		{apikeys.ScopeReadCampaigns},
		{apikeys.ScopeReadReports},
	} {
		response := serveRouteMiddleware(preview, scopes)
		if response.Code != http.StatusForbidden {
			t.Errorf("scopes=%v status=%d, want 403", scopes, response.Code)
		}
	}
	response := serveRouteMiddleware(preview, []apikeys.Scope{apikeys.ScopeWriteCampaigns})
	if response.Code != 299 || response.Body.String() != "scope-passed" {
		t.Fatalf(
			"write:campaigns status=%d body=%q, want middleware pass",
			response.Code,
			response.Body.String(),
		)
	}
}

func TestMountCampaignSendingSurfacePreservesRegistrationOrder(t *testing.T) {
	t.Parallel()

	sourceBytes, err := os.ReadFile("campaign_sending.go")
	if err != nil {
		t.Fatalf("read campaign_sending.go: %v", err)
	}
	source := string(sourceBytes)

	assertServerMarkersInOrder(t, source, []string{
		"func MountCampaignTemplateRoutes(",
		"Get(\"/api/v1/campaign-templates\",",
		"Get(\"/api/v1/campaign-templates/search\",",
		"Get(\"/api/v1/campaign-templates/{id}\",",
		"Get(\"/api/v1/campaign-templates/{id}/revisions\",",
		"Get(\"/api/v1/campaign-templates/{id}/revisions/{version}\",",
		"Get(\"/api/v1/campaign-templates/{id}/review-events\",",
		"Get(\"/api/v1/campaign-templates/block-impact/{blockId}\",",
		"Get(\"/api/v1/campaign-templates/stats\",",
		"Get(\"/api/v1/campaign-templates/goals\",",
		"Get(\"/api/v1/campaign-template-designs\",",
		"Get(\"/api/v1/campaign-template-designs/{id}\",",
		"Get(\"/api/v1/campaign-template-designs/{id}/revisions\",",
		"Post(\"/api/v1/campaign-template-designs\",",
		"Post(\"/api/v1/campaign-template-designs/{id}/refine\",",
		"Post(\"/api/v1/campaign-template-designs/{id}/retry\",",
		"Post(\"/api/v1/campaign-template-designs/{id}/save\",",
		"Post(\"/api/v1/campaign-template-designs/{id}/create-campaign\",",
		"Post(\"/api/v1/campaign-template-designs/{id}/archive\",",
		"Post(\"/api/v1/campaign-templates/generate\",",
		"Post(\"/api/v1/campaign-templates/import\",",
		"Post(\"/api/v1/campaign-templates\",",
		"Patch(\"/api/v1/campaign-templates/{id}\",",
		"Patch(\"/api/v1/campaign-templates/{id}/archive\",",
		"Patch(\"/api/v1/campaign-templates/{id}/restore\",",
		"Delete(\"/api/v1/campaign-templates/{id}\",",
		"Post(\"/api/v1/campaign-templates/{id}/review-decisions\",",
		"Post(\"/api/v1/campaign-templates/{id}/clone\",",
		"Post(\"/api/v1/campaign-templates/{id}/adapt\",",
		"Post(\"/api/v1/campaign-templates/{id}/create-campaign\",",
		"Post(\"/api/v1/campaigns/from-template\",",
		"Post(\"/api/v1/campaign-templates/{id}/use\",",
		"Post(\"/api/v1/campaign-templates/{id}/favorite\",",
		"Post(\"/api/v1/campaign-templates/{id}/unfavorite\",",
	})
	assertServerMarkersInOrder(t, source, []string{
		"func MountSendTimeOptimizationRoutes(",
		"deps.SendTimeOptimization.MountRoutes(deps.Router)",
		"deps.SendTimeOptimization.MountPatternRoutes(deps.Router)",
		"deps.SendTimeOptimization.MountSchedulePreviewRoute(deps.Router)",
	})
	assertServerMarkersInOrder(t, source, []string{
		"func MountCampaignMutationRoutes(",
		"campaigns.MountWrite(deps.Router, deps.Campaigns)",
		"campaigns.MountFolders(deps.Router, deps.Campaigns)",
		"campaigns.MountFeedback(deps.Router, deps.Campaigns)",
		"campaigns.MountChecklist(deps.Router, deps.Campaigns)",
		"campaigns.MountPSTO(deps.Router, deps.Campaigns)",
		"campaigns.MountPreviewAs(deps.Router, deps.Campaigns)",
		"campaigns.MountGoalResults(deps.Router, deps.Campaigns)",
		"campaigns.MountAudienceCount(deps.Router, deps.CampaignAudienceCount)",
		"campaigns.MountOrgTags(deps.Router, deps.Campaigns)",
		"campaigns.MountAudienceFreeze(deps.Router, deps.Campaigns)",
		"campaigns.MountSendPreview(deps.Router, deps.Campaigns, deps.CampaignSendPreview)",
	})
	assertServerMarkersInOrder(t, source, []string{
		"func MountCampaignSendRoutes(",
		"apikeys.RequireAllScopes(",
		"apikeys.ScopeWriteCampaigns,",
		"apikeys.ScopeSendTransactional,",
		"campaigns.MountSend(scopedRouter, deps.Campaigns, deps.CampaignSend)",
	})
	assertServerMarkersInOrder(t, source, []string{
		"func MountCampaignSendingSurface(",
		"MountCampaignReadRoutes(deps)",
		"MountCampaignTemplateRoutes(deps)",
		"MountCampaignABTestRoutes(deps)",
		"MountCampaignSendDomainRoutes(deps)",
		"MountSendTimeOptimizationRoutes(deps)",
		"MountSendingIdentityRoutes(deps)",
		"MountCampaignTemplateRegionRoutes(deps)",
		"MountSendWindowRoutes(deps)",
		"MountCampaignMutationRoutes(deps)",
		"MountCampaignComposeRoutes(deps)",
		"MountDedicatedIPRoutes(deps)",
		"MountCampaignABCreateRoutes(deps)",
		"MountCampaignSendRoutes(deps)",
		"MountCampaignQueueRoutes(deps)",
	})

	registrationMarkers := []string{
		"campaigns.MountRead(",
		"/api/v1/campaign-templates\"",
		"/api/v1/campaign-templates/search",
		"/api/v1/campaign-templates/{id}\"",
		"/api/v1/campaign-templates/{id}/revisions",
		"/api/v1/campaign-templates/{id}/revisions/{version}",
		"/api/v1/campaign-templates/{id}/review-events",
		"/api/v1/campaign-templates/block-impact/{blockId}",
		"/api/v1/campaign-templates/stats",
		"/api/v1/campaign-templates/goals",
		"/api/v1/campaign-template-designs\", deps.CampaignTemplates.ListDesignDrafts",
		"/api/v1/campaign-template-designs/{id}\"",
		"/api/v1/campaign-template-designs/{id}/revisions",
		"/api/v1/campaign-template-designs\", deps.CampaignTemplates.CreateDesignDraft",
		"/api/v1/campaign-template-designs/{id}/refine",
		"/api/v1/campaign-template-designs/{id}/retry",
		"/api/v1/campaign-template-designs/{id}/save",
		"/api/v1/campaign-template-designs/{id}/create-campaign",
		"/api/v1/campaign-template-designs/{id}/archive",
		"/api/v1/campaign-templates/generate",
		"/api/v1/campaign-templates/from-generated-design",
		"/api/v1/campaign-templates/import",
		"/api/v1/campaign-templates\", deps.CampaignTemplates.Create",
		"/api/v1/campaign-templates/{id}\", deps.CampaignTemplates.Update",
		"/api/v1/campaign-templates/{id}/review-events\", deps.CampaignTemplates.AddReviewEvent",
		"/api/v1/campaign-templates/{id}/archive",
		"/api/v1/campaign-templates/{id}/restore",
		"/api/v1/campaign-templates/{id}\", deps.CampaignTemplates.Delete",
		"/api/v1/campaign-templates/{id}/review-decisions",
		"/api/v1/campaign-templates/{id}/clone",
		"/api/v1/campaign-templates/{id}/adapt",
		"/api/v1/campaign-templates/{id}/create-campaign",
		"/api/v1/campaigns/from-template",
		"/api/v1/campaign-templates/{id}/use",
		"/api/v1/campaign-templates/{id}/favorite",
		"/api/v1/campaign-templates/{id}/unfavorite",
		"deps.CampaignABTests.MountRoutes(",
		"campaigns.MountSendDomain(",
		"campaigns.MountSchedule(",
		"deps.SendTimeOptimization.MountRoutes(",
		"deps.SendTimeOptimization.MountPatternRoutes(",
		"deps.SendTimeOptimization.MountSchedulePreviewRoute(",
		"sending_identity.MountRoutes(",
		"/api/v1/campaign-templates/{id}/regions",
		"send_window.MountRoutes(",
		"campaigns.MountWrite(",
		"campaigns.MountFolders(",
		"campaigns.MountFeedback(",
		"campaigns.MountChecklist(",
		"campaigns.MountPSTO(",
		"campaigns.MountPreviewAs(",
		"campaigns.MountGoalResults(",
		"campaigns.MountAudienceCount(",
		"campaigns.MountOrgTags(",
		"campaigns.MountAudienceFreeze(",
		"campaigns.MountSendPreview(",
		"campaigns.MountCompose(",
		"sending.MountDedicatedIPRoutes(",
		"/api/v1/campaigns/ab-test",
		"campaigns.MountSend(",
		"campaigns.MountQueue(",
	}
	if len(registrationMarkers) != 61 {
		t.Fatalf("registration contract contains %d entries, want 61", len(registrationMarkers))
	}
	for _, marker := range registrationMarkers {
		if !strings.Contains(source, marker) {
			t.Fatalf("campaign_sending.go is missing registration marker %q", marker)
		}
	}
}

func TestMountCampaignSendingSurfacePreservesDependencyIdentity(t *testing.T) {
	t.Parallel()

	sourceBytes, err := os.ReadFile("campaign_sending.go")
	if err != nil {
		t.Fatalf("read campaign_sending.go: %v", err)
	}
	source := string(sourceBytes)
	for _, marker := range []string{
		"campaigns.MountRead(deps.Router, deps.Campaigns)",
		"deps.CampaignABTests.MountRoutes(deps.Router)",
		"deps.SendTimeOptimization.MountRoutes(deps.Router)",
		"deps.SendTimeOptimization.MountPatternRoutes(deps.Router)",
		"deps.SendTimeOptimization.MountSchedulePreviewRoute(deps.Router)",
		"Pool:     deps.Pool,",
		"Resolver: sending_identity.DefaultResolver(),",
		"send_window.Deps{Pool: deps.Pool}",
		"campaigns.MountAudienceCount(deps.Router, deps.CampaignAudienceCount)",
		"campaigns.MountSendPreview(deps.Router, deps.Campaigns, deps.CampaignSendPreview)",
		"Repo: &sending.DedicatedIPRepo{Pool: deps.Pool}",
		"campaigns.MountSend(scopedRouter, deps.Campaigns, deps.CampaignSend)",
		"campaigns.MountQueue(deps.Router, deps.Campaigns)",
	} {
		if !strings.Contains(source, marker) {
			t.Fatalf("dependency identity contract missing %q", marker)
		}
	}
	if got := strings.Count(source, "deps.CampaignTemplates."); got != 55 {
		t.Fatalf("shared campaign-template dependency uses = %d, want 55", got)
	}
}

func TestMountCampaignSendingSurfaceUsesPassedAuthenticatedRouter(t *testing.T) {
	root := chi.NewRouter()
	root.Group(func(authenticated chi.Router) {
		authenticated.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("X-Test-Authenticated-Boundary", "applied")
				next.ServeHTTP(w, r)
			})
		})
		MountCampaignSendingSurface(newCampaignSendingDeps(authenticated))
	})

	request := httptest.NewRequest(http.MethodGet, "/api/v1/campaigns", http.NoBody)
	request = request.WithContext(middleware.WithAPIKeyAuth(request.Context()))
	response := httptest.NewRecorder()
	root.ServeHTTP(response, request)
	if response.Header().Get("X-Test-Authenticated-Boundary") != "applied" {
		t.Fatal("campaign route escaped the passed authenticated router middleware")
	}
	if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "insufficient_scope") {
		t.Fatalf("status = %d body = %s, want scoped 403", response.Code, response.Body.String())
	}
}

func TestCampaignQueueAndSendAliasRequireBothDispatchScopes(t *testing.T) {
	t.Parallel()

	for _, mount := range []struct {
		name string
		path string
		fn   func(Deps)
	}{
		{name: "queue", path: "/api/v1/campaigns/c1/queue", fn: MountCampaignQueueRoutes},
		{name: "send alias", path: "/api/v1/campaigns/c1/send", fn: MountCampaignSendRoutes},
	} {
		t.Run(mount.name, func(t *testing.T) {
			t.Parallel()
			router := chi.NewRouter()
			deps := Deps{Router: router, Campaigns: &campaigns.Deps{}, CampaignSend: &campaigns.SendDeps{}}
			mount.fn(deps)

			for _, scopes := range [][]apikeys.Scope{
				{apikeys.ScopeWriteCampaigns},
				{apikeys.ScopeSendTransactional},
			} {
				rec := serveCampaignDispatchAlias(router, mount.path, scopes)
				if rec.Code != http.StatusForbidden {
					t.Errorf("scopes=%v status=%d, want 403; body=%s", scopes, rec.Code, rec.Body.String())
				}
			}

			rec := serveCampaignDispatchAlias(router, mount.path, []apikeys.Scope{
				apikeys.ScopeWriteCampaigns,
				apikeys.ScopeSendTransactional,
			})
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("full scopes status=%d, want handler-level 401; body=%s", rec.Code, rec.Body.String())
			}
		})
	}
}

func serveCampaignDispatchAlias(router http.Handler, path string, scopes []apikeys.Scope) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, http.NoBody)
	ctx := middleware.WithAPIKeyAuth(req.Context())
	ctx = apikeys.WithScopes(ctx, scopes)
	req = req.WithContext(ctx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func TestCampaignSendingMountsRejectMissingStructuralDependencies(t *testing.T) {
	valid := newCampaignSendingDeps(chi.NewRouter())
	tests := []struct {
		name  string
		deps  Deps
		mount func(Deps)
	}{
		{name: "campaign read missing deps", deps: Deps{Router: chi.NewRouter()}, mount: MountCampaignReadRoutes},
		{name: "templates missing deps", deps: Deps{Router: chi.NewRouter()}, mount: MountCampaignTemplateRoutes},
		{name: "ab tests missing deps", deps: Deps{Router: chi.NewRouter()}, mount: MountCampaignABTestRoutes},
		{name: "send time missing deps", deps: Deps{Router: chi.NewRouter()}, mount: MountSendTimeOptimizationRoutes},
		{name: "send domain missing deps", deps: Deps{Router: chi.NewRouter()}, mount: MountCampaignSendDomainRoutes},
		{name: "identity missing pool", deps: Deps{Router: chi.NewRouter()}, mount: MountSendingIdentityRoutes},
		{name: "template region missing deps", deps: Deps{Router: chi.NewRouter()}, mount: MountCampaignTemplateRegionRoutes},
		{name: "send window missing pool", deps: Deps{Router: chi.NewRouter()}, mount: MountSendWindowRoutes},
		{name: "mutation missing campaigns", deps: Deps{Router: chi.NewRouter(), CampaignAudienceCount: valid.CampaignAudienceCount, CampaignSendPreview: valid.CampaignSendPreview}, mount: MountCampaignMutationRoutes},
		{name: "mutation missing audience count", deps: Deps{Router: chi.NewRouter(), Campaigns: valid.Campaigns, CampaignSendPreview: valid.CampaignSendPreview}, mount: MountCampaignMutationRoutes},
		{name: "mutation missing send preview", deps: Deps{Router: chi.NewRouter(), Campaigns: valid.Campaigns, CampaignAudienceCount: valid.CampaignAudienceCount}, mount: MountCampaignMutationRoutes},
		{name: "compose missing deps", deps: Deps{Router: chi.NewRouter()}, mount: MountCampaignComposeRoutes},
		{name: "dedicated ip missing pool", deps: Deps{Router: chi.NewRouter()}, mount: MountDedicatedIPRoutes},
		{name: "ab create missing deps", deps: Deps{Router: chi.NewRouter()}, mount: MountCampaignABCreateRoutes},
		{name: "send missing campaigns", deps: Deps{Router: chi.NewRouter(), CampaignSend: valid.CampaignSend}, mount: MountCampaignSendRoutes},
		{name: "send missing send deps", deps: Deps{Router: chi.NewRouter(), Campaigns: valid.Campaigns}, mount: MountCampaignSendRoutes},
		{name: "queue missing deps", deps: Deps{Router: chi.NewRouter()}, mount: MountCampaignQueueRoutes},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			test.mount(test.deps)
			if test.deps.Router != nil && routeCount(t, test.deps.Router) != 0 {
				t.Fatal("invalid dependencies registered partial routes")
			}
		})
	}

	routerless := valid
	routerless.Router = nil
	for _, helper := range []struct {
		name  string
		mount func(Deps)
	}{
		{name: "campaign read", mount: MountCampaignReadRoutes},
		{name: "templates", mount: MountCampaignTemplateRoutes},
		{name: "ab tests", mount: MountCampaignABTestRoutes},
		{name: "send domain", mount: MountCampaignSendDomainRoutes},
		{name: "send time", mount: MountSendTimeOptimizationRoutes},
		{name: "identity", mount: MountSendingIdentityRoutes},
		{name: "template region", mount: MountCampaignTemplateRegionRoutes},
		{name: "send window", mount: MountSendWindowRoutes},
		{name: "mutation", mount: MountCampaignMutationRoutes},
		{name: "compose", mount: MountCampaignComposeRoutes},
		{name: "dedicated ip", mount: MountDedicatedIPRoutes},
		{name: "ab create", mount: MountCampaignABCreateRoutes},
		{name: "send", mount: MountCampaignSendRoutes},
		{name: "queue", mount: MountCampaignQueueRoutes},
	} {
		t.Run(helper.name+" missing router", func(t *testing.T) {
			helper.mount(routerless)
		})
	}
}

func TestMountCampaignSendingSurfaceRejectsEveryIncompleteDependencyBag(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Deps)
	}{
		{name: "router", mutate: func(deps *Deps) { deps.Router = nil }},
		{name: "pool", mutate: func(deps *Deps) { deps.Pool = nil }},
		{name: "campaigns", mutate: func(deps *Deps) { deps.Campaigns = nil }},
		{name: "templates", mutate: func(deps *Deps) { deps.CampaignTemplates = nil }},
		{name: "ab tests", mutate: func(deps *Deps) { deps.CampaignABTests = nil }},
		{name: "send time", mutate: func(deps *Deps) { deps.SendTimeOptimization = nil }},
		{name: "audience count", mutate: func(deps *Deps) { deps.CampaignAudienceCount = nil }},
		{name: "send preview", mutate: func(deps *Deps) { deps.CampaignSendPreview = nil }},
		{name: "send", mutate: func(deps *Deps) { deps.CampaignSend = nil }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			deps := newCampaignSendingDeps(chi.NewRouter())
			test.mutate(&deps)
			MountCampaignSendingSurface(deps)
			if deps.Router != nil && routeCount(t, deps.Router) != 0 {
				t.Fatal("incomplete dependency bag registered a partial surface")
			}
		})
	}
}

func TestNewIncludesCompleteCampaignSendingSurface(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newCampaignSendingDeps(actualRouter)
	New(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newCampaignSendingDeps(referenceRouter)
	MountDeliverabilitySurface(referenceDeps)
	mountLegacyCampaignSendingSurface(referenceDeps)

	actual := subscriberListSegmentRoutes(t, actualRouter)
	reference := subscriberListSegmentRoutes(t, referenceRouter)
	if len(actual) != len(reference) {
		t.Fatalf("server.New route count = %d, want %d", len(actual), len(reference))
	}
	for index := range reference {
		if actual[index].method != reference[index].method || actual[index].path != reference[index].path {
			t.Fatalf(
				"server.New route[%d] = %s %s, want %s %s",
				index,
				actual[index].method,
				actual[index].path,
				reference[index].method,
				reference[index].path,
			)
		}
	}
}

func newCampaignSendingDeps(router chi.Router) Deps {
	pool := new(db.Pool)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	campaignDeps := &campaigns.Deps{Repo: &campaigns.Repo{Pool: pool}, Logger: logger}
	return Deps{
		Router:                router,
		Pool:                  pool,
		Logger:                logger,
		Campaigns:             campaignDeps,
		CampaignTemplates:     &campaigntemplates.Deps{Repo: &campaigntemplates.Repo{Pool: pool}},
		CampaignABTests:       &abtests.Deps{Repo: &abtests.Repo{Pool: pool}, WinnerDeps: &abtests.WinnerDeps{}},
		SendTimeOptimization:  &send_time_opt.Deps{Repo: &send_time_opt.Repo{Pool: pool}, Logger: logger},
		CampaignAudienceCount: &campaigns.AudienceCountDeps{Audience: campaignAudienceCounterStub{}, Logger: logger},
		CampaignSendPreview:   &campaigns.SendPreviewDeps{Repo: campaignDeps.Repo},
		CampaignSend:          &campaigns.SendDeps{},
	}
}

func mountLegacyCampaignSendingSurface(deps Deps) {
	campaigns.MountRead(deps.Router, deps.Campaigns)
	read := apikeys.RequireScope(apikeys.ScopeReadCampaigns)
	write := apikeys.RequireScope(apikeys.ScopeWriteCampaigns)
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	deps.Router.With(read).Get("/api/v1/campaign-templates", deps.CampaignTemplates.List)
	deps.Router.With(read).Get("/api/v1/campaign-templates/search", deps.CampaignTemplates.Search)
	deps.Router.With(read).Get("/api/v1/campaign-templates/compare", deps.CampaignTemplates.CompareTemplates)
	deps.Router.With(read).Get("/api/v1/campaign-templates/recent", deps.CampaignTemplates.ListRecentViews)
	deps.Router.With(read).Delete("/api/v1/campaign-templates/recent", deps.CampaignTemplates.ClearRecentViews)
	deps.Router.With(read).Delete("/api/v1/campaign-templates/recent/{id}", deps.CampaignTemplates.ClearRecentViews)
	deps.Router.With(read).Get("/api/v1/campaign-template-collections", deps.CampaignTemplates.ListCollections)
	deps.Router.With(read).Post("/api/v1/campaign-template-collections", deps.CampaignTemplates.CreateCollection)
	deps.Router.With(read).Get("/api/v1/campaign-template-collections/{id}", deps.CampaignTemplates.GetCollection)
	deps.Router.With(read).Patch("/api/v1/campaign-template-collections/{id}", deps.CampaignTemplates.UpdateCollection)
	deps.Router.With(read).Delete("/api/v1/campaign-template-collections/{id}", deps.CampaignTemplates.DeleteCollection)
	deps.Router.With(read).Put("/api/v1/campaign-template-collections/{id}/items", deps.CampaignTemplates.ReplaceCollectionItems)
	deps.Router.With(read).Get("/api/v1/campaign-template-saved-searches", deps.CampaignTemplates.ListSavedSearches)
	deps.Router.With(read).Post("/api/v1/campaign-template-saved-searches", deps.CampaignTemplates.CreateSavedSearch)
	deps.Router.With(read).Get("/api/v1/campaign-template-saved-searches/{id}", deps.CampaignTemplates.GetSavedSearch)
	deps.Router.With(read).Patch("/api/v1/campaign-template-saved-searches/{id}", deps.CampaignTemplates.UpdateSavedSearch)
	deps.Router.With(read).Delete("/api/v1/campaign-template-saved-searches/{id}", deps.CampaignTemplates.DeleteSavedSearch)
	deps.Router.With(read).Get("/api/v1/campaign-template-saved-searches/{id}/results", deps.CampaignTemplates.SavedSearchResults)
	deps.Router.With(read).Get("/api/v1/campaign-templates/{id}", deps.CampaignTemplates.Get)
	deps.Router.With(read).Get("/api/v1/campaign-templates/{id}/revisions", deps.CampaignTemplates.ListRevisions)
	deps.Router.With(read).Get("/api/v1/campaign-templates/{id}/revisions/{version}", deps.CampaignTemplates.GetRevision)
	deps.Router.With(read).Get("/api/v1/campaign-templates/{id}/review-events", deps.CampaignTemplates.ListReviewEvents)
	deps.Router.With(read).Get("/api/v1/campaign-templates/block-impact/{blockId}", deps.CampaignTemplates.BlockImpact)
	deps.Router.With(read).Get("/api/v1/campaign-templates/{id}/flow-usage", deps.CampaignTemplates.FlowUsage)
	deps.Router.With(read).Get("/api/v1/campaign-templates/stats", deps.CampaignTemplates.Stats)
	deps.Router.With(read).Get("/api/v1/campaign-templates/goals", deps.CampaignTemplates.Goals)
	deps.Router.With(read).Get("/api/v1/campaign-template-designs", deps.CampaignTemplates.ListDesignDrafts)
	deps.Router.With(read).Get("/api/v1/campaign-template-designs/{id}", deps.CampaignTemplates.GetDesignDraft)
	deps.Router.With(read).Get("/api/v1/campaign-template-designs/{id}/revisions", deps.CampaignTemplates.ListDesignDraftRevisions)
	deps.Router.With(write).Post("/api/v1/campaign-template-designs", deps.CampaignTemplates.CreateDesignDraft)
	deps.Router.With(write).Post("/api/v1/campaign-template-designs/{id}/refine", deps.CampaignTemplates.RefineDesignDraft)
	deps.Router.With(write).Post("/api/v1/campaign-template-designs/{id}/retry", deps.CampaignTemplates.RetryDesignDraft)
	deps.Router.With(write).Post("/api/v1/campaign-template-designs/{id}/save", deps.CampaignTemplates.SaveDesignDraft)
	deps.Router.With(write).Post("/api/v1/campaign-template-designs/{id}/create-campaign", deps.CampaignTemplates.CreateCampaignFromDesignDraft)
	deps.Router.With(write).Post("/api/v1/campaign-template-designs/{id}/archive", deps.CampaignTemplates.ArchiveDesignDraft)
	deps.Router.With(write).Post("/api/v1/campaign-templates/generate", deps.CampaignTemplates.Generate)
	deps.Router.With(write).Post("/api/v1/campaign-templates/from-generated-design", deps.CampaignTemplates.SaveGeneratedDesign)
	deps.Router.With(write).Post("/api/v1/campaign-templates/import", deps.CampaignTemplates.Import)
	deps.Router.With(write).Post("/api/v1/campaign-templates", deps.CampaignTemplates.Create)
	deps.Router.With(write).Patch("/api/v1/campaign-templates/{id}", deps.CampaignTemplates.Update)
	deps.Router.With(write).Post("/api/v1/campaign-templates/{id}/review-events", deps.CampaignTemplates.AddReviewEvent)
	deps.Router.With(write).Patch("/api/v1/campaign-templates/{id}/archive", deps.CampaignTemplates.Archive)
	deps.Router.With(write).Patch("/api/v1/campaign-templates/{id}/restore", deps.CampaignTemplates.Restore)
	deps.Router.With(write).Delete("/api/v1/campaign-templates/{id}", deps.CampaignTemplates.Delete)
	deps.Router.With(admin).Post("/api/v1/campaign-templates/{id}/review-decisions", deps.CampaignTemplates.ReviewReferenceDecision)
	deps.Router.With(write).Post("/api/v1/campaign-templates/{id}/revisions/{version}/restore", deps.CampaignTemplates.RestoreRevision)
	deps.Router.With(write).Post("/api/v1/campaign-templates/{id}/clone", deps.CampaignTemplates.Clone)
	deps.Router.With(write).Post("/api/v1/campaign-templates/{id}/adapt", deps.CampaignTemplates.Adapt)
	deps.Router.With(write).Post("/api/v1/campaign-templates/{id}/create-campaign", deps.CampaignTemplates.CreateCampaignFromTemplate)
	deps.Router.With(write).Post("/api/v1/campaigns/from-template", deps.CampaignTemplates.CreateCampaignFromTemplate)
	deps.Router.With(write).Post("/api/v1/campaign-templates/{id}/use", deps.CampaignTemplates.RecordUse)
	deps.Router.With(read).Post("/api/v1/campaign-templates/{id}/favorite", deps.CampaignTemplates.Favorite)
	deps.Router.With(read).Post("/api/v1/campaign-templates/{id}/unfavorite", deps.CampaignTemplates.Unfavorite)
	deps.Router.With(read).Post("/api/v1/campaign-templates/{id}/view", deps.CampaignTemplates.RecordRecentView)
	deps.CampaignABTests.MountRoutes(deps.Router)
	campaigns.MountSendDomain(deps.Router, deps.Campaigns)
	campaigns.MountSchedule(deps.Router, deps.Campaigns)
	deps.SendTimeOptimization.MountRoutes(deps.Router)
	deps.SendTimeOptimization.MountPatternRoutes(deps.Router)
	deps.SendTimeOptimization.MountSchedulePreviewRoute(deps.Router)
	sending_identity.MountRoutes(deps.Router, &sending_identity.Deps{
		Pool:     deps.Pool,
		Resolver: sending_identity.DefaultResolver(),
	})
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).
		Get("/api/v1/campaign-templates/{id}/regions", deps.CampaignTemplates.Regions)
	send_window.MountRoutes(deps.Router, &send_window.Deps{Pool: deps.Pool})
	campaigns.MountWrite(deps.Router, deps.Campaigns)
	campaigns.MountFolders(deps.Router, deps.Campaigns)
	campaigns.MountFeedback(deps.Router, deps.Campaigns)
	campaigns.MountChecklist(deps.Router, deps.Campaigns)
	campaigns.MountPSTO(deps.Router, deps.Campaigns)
	campaigns.MountPreviewAs(deps.Router, deps.Campaigns)
	campaigns.MountGoalResults(deps.Router, deps.Campaigns)
	campaigns.MountAudienceCount(deps.Router, deps.CampaignAudienceCount)
	campaigns.MountOrgTags(deps.Router, deps.Campaigns)
	campaigns.MountAudienceFreeze(deps.Router, deps.Campaigns)
	campaigns.MountSendPreview(deps.Router, deps.Campaigns, deps.CampaignSendPreview)
	campaigns.MountCompose(deps.Router, deps.Campaigns)
	sending.MountDedicatedIPRoutes(deps.Router, &sending.DedicatedIPHandlersDeps{
		Repo: &sending.DedicatedIPRepo{Pool: deps.Pool},
	})
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Post("/api/v1/campaigns/ab-test", deps.Campaigns.CreateABTest)
	deps.Router.With(apikeys.RequireAllScopes(
		apikeys.ScopeWriteCampaigns,
		apikeys.ScopeSendTransactional,
	)).Group(func(scopedRouter chi.Router) {
		campaigns.MountSend(scopedRouter, deps.Campaigns, deps.CampaignSend)
	})
	campaigns.MountQueue(deps.Router, deps.Campaigns)
}

type campaignAudienceCounterStub struct{}

func (campaignAudienceCounterStub) CountListAudience(context.Context, string, string) (int64, error) {
	return 0, nil
}

func (campaignAudienceCounterStub) CountSegmentAudience(context.Context, string, string) (int64, error) {
	return 0, nil
}

func assertServerMarkersInOrder(t *testing.T, source string, ordered []string) {
	t.Helper()
	last := -1
	for _, marker := range ordered {
		index := strings.Index(source, marker)
		if index < 0 {
			t.Fatalf("campaign_sending.go is missing marker %q", marker)
		}
		if index <= last {
			t.Fatalf("campaign_sending.go marker %q is out of order", marker)
		}
		last = index
	}
}
