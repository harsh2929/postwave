// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/content_optimizer"
	"github.com/postwave/postwave/apps/api/internal/content_remix"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/form_variants"
	"github.com/postwave/postwave/apps/api/internal/forms"
	"github.com/postwave/postwave/apps/api/internal/frequency"
	"github.com/postwave/postwave/apps/api/internal/handlers"
	"github.com/postwave/postwave/apps/api/internal/intelligent_retry"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/nql"
	"github.com/postwave/postwave/apps/api/internal/observability"
	"github.com/postwave/postwave/apps/api/internal/search"
	"github.com/postwave/postwave/apps/api/internal/trigger_delay"
)

func TestSendingDiscoveryRoutesMatchEveryLegacyRouteAndScope(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newSendingDiscoveryRouteDeps(actualRouter)
	MountSendingDiscoveryRoutes(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newSendingDiscoveryRouteDeps(referenceRouter)
	mountLegacySendingDiscoveryRoutes(referenceDeps)

	assertRouteSetsAndScopesMatch(t, actualRouter, referenceRouter, 29, [][]apikeys.Scope{
		nil,
		{apikeys.ScopeReadReports},
		{apikeys.ScopeAdmin},
		{apikeys.ScopeReadSubscribers},
		{apikeys.ScopeReadCampaigns},
		{apikeys.ScopeWriteCampaigns},
		{apikeys.ScopeReadReports, apikeys.ScopeAdmin, apikeys.ScopeReadSubscribers, apikeys.ScopeReadCampaigns, apikeys.ScopeWriteCampaigns},
	})
}

func TestFormAdminRoutesMatchExpectedRouteAndScopeContract(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newFormAdminRouteDeps(actualRouter)
	MountFormAdminRoutes(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newFormAdminRouteDeps(referenceRouter)
	mountExpectedFormAdminRoutes(referenceDeps)

	assertRouteSetsAndScopesMatch(t, actualRouter, referenceRouter, 16, [][]apikeys.Scope{
		nil,
		{apikeys.ScopeReadSubscribers},
		{apikeys.ScopeReadCampaigns},
		{apikeys.ScopeWriteCampaigns},
		{apikeys.ScopeReadReports},
		{apikeys.ScopeAdmin},
		{apikeys.ScopeReadSubscribers, apikeys.ScopeReadCampaigns, apikeys.ScopeWriteCampaigns, apikeys.ScopeReadReports},
		{apikeys.ScopeReadSubscribers, apikeys.ScopeReadCampaigns, apikeys.ScopeWriteCampaigns, apikeys.ScopeReadReports, apikeys.ScopeAdmin},
	})
}

func TestFormCoreRoutesEnforceLeastPrivilegeScopeMatrix(t *testing.T) {
	t.Parallel()

	router := chi.NewRouter()
	MountFormAdminRoutes(newFormAdminRouteDeps(router))
	routes := subscriberListSegmentRoutes(t, router)
	singleScopeCases := []struct {
		name  string
		scope apikeys.Scope
	}{
		{name: "read subscribers", scope: apikeys.ScopeReadSubscribers},
		{name: "read campaigns", scope: apikeys.ScopeReadCampaigns},
		{name: "write campaigns", scope: apikeys.ScopeWriteCampaigns},
		{name: "read reports", scope: apikeys.ScopeReadReports},
		{name: "admin", scope: apikeys.ScopeAdmin},
	}
	expectations := []struct {
		method  string
		path    string
		allowed map[apikeys.Scope]bool
	}{
		{method: http.MethodGet, path: "/api/v1/forms", allowed: scopeAllowlist(apikeys.ScopeReadCampaigns, apikeys.ScopeAdmin)},
		{method: http.MethodGet, path: "/api/v1/forms/{id}", allowed: scopeAllowlist(apikeys.ScopeReadCampaigns, apikeys.ScopeAdmin)},
		{method: http.MethodPatch, path: "/api/v1/forms/{id}", allowed: scopeAllowlist(apikeys.ScopeWriteCampaigns, apikeys.ScopeAdmin)},
		{method: http.MethodDelete, path: "/api/v1/forms/{id}", allowed: scopeAllowlist(apikeys.ScopeAdmin)},
		{method: http.MethodGet, path: "/api/v1/forms/{id}/submissions", allowed: scopeAllowlist(apikeys.ScopeAdmin)},
		{method: http.MethodGet, path: "/api/v1/forms/{id}/submissions.csv", allowed: scopeAllowlist(apikeys.ScopeAdmin)},
		{method: http.MethodDelete, path: "/api/v1/forms/{id}/submissions/{submissionId}", allowed: scopeAllowlist(apikeys.ScopeAdmin)},
		{method: http.MethodPost, path: "/api/v1/forms/{id}/submissions/{submissionId}/resend-confirmation", allowed: scopeAllowlist(apikeys.ScopeAdmin)},
		{method: http.MethodGet, path: "/api/v1/forms/{id}/analytics", allowed: scopeAllowlist(apikeys.ScopeReadReports, apikeys.ScopeAdmin)},
	}

	for _, expectation := range expectations {
		route := findFormRoute(t, routes, expectation.method, expectation.path)
		if got := serveRouteMiddleware(route, nil).Code; got != http.StatusForbidden {
			t.Errorf("%s %s without scopes = %d, want %d", expectation.method, expectation.path, got, http.StatusForbidden)
		}
		for _, scopeCase := range singleScopeCases {
			got := serveRouteMiddleware(route, []apikeys.Scope{scopeCase.scope}).Code
			want := http.StatusForbidden
			if expectation.allowed[scopeCase.scope] {
				want = 299
			}
			if got != want {
				t.Errorf("%s %s with %s = %d, want %d", expectation.method, expectation.path, scopeCase.name, got, want)
			}
		}
	}

	allNonAdminReadsAndWrites := []apikeys.Scope{
		apikeys.ScopeReadSubscribers,
		apikeys.ScopeReadCampaigns,
		apikeys.ScopeWriteCampaigns,
		apikeys.ScopeReadReports,
	}
	for _, path := range []string{
		"/api/v1/forms/{id}/submissions",
		"/api/v1/forms/{id}/submissions.csv",
	} {
		route := findFormRoute(t, routes, http.MethodGet, path)
		if got := serveRouteMiddleware(route, allNonAdminReadsAndWrites).Code; got != http.StatusForbidden {
			t.Errorf("GET %s with every non-admin data scope = %d, want fail-closed %d", path, got, http.StatusForbidden)
		}
	}
}

func TestFormCoreRoutesMatchDesktopRoleTiers(t *testing.T) {
	t.Parallel()

	router := chi.NewRouter()
	MountFormAdminRoutes(newFormAdminRouteDeps(router))
	routes := subscriberListSegmentRoutes(t, router)
	expectations := []struct {
		method string
		path   string
		roles  map[string]bool
	}{
		{method: http.MethodGet, path: "/api/v1/forms", roles: roleAllowlist("viewer", "member", "editor", "admin", "owner")},
		{method: http.MethodGet, path: "/api/v1/forms/{id}", roles: roleAllowlist("viewer", "member", "editor", "admin", "owner")},
		{method: http.MethodPatch, path: "/api/v1/forms/{id}", roles: roleAllowlist("editor", "admin", "owner")},
		{method: http.MethodDelete, path: "/api/v1/forms/{id}", roles: roleAllowlist("admin", "owner")},
		{method: http.MethodGet, path: "/api/v1/forms/{id}/submissions", roles: roleAllowlist("admin", "owner")},
		{method: http.MethodGet, path: "/api/v1/forms/{id}/submissions.csv", roles: roleAllowlist("admin", "owner")},
		{method: http.MethodDelete, path: "/api/v1/forms/{id}/submissions/{submissionId}", roles: roleAllowlist("admin", "owner")},
		{method: http.MethodPost, path: "/api/v1/forms/{id}/submissions/{submissionId}/resend-confirmation", roles: roleAllowlist("admin", "owner")},
		{method: http.MethodGet, path: "/api/v1/forms/{id}/analytics", roles: roleAllowlist("viewer", "member", "editor", "admin", "owner")},
	}

	for _, expectation := range expectations {
		route := findFormRoute(t, routes, expectation.method, expectation.path)
		for _, role := range []string{"viewer", "member", "editor", "admin", "owner"} {
			got := serveFormRouteMiddlewareAsRole(route, role).Code
			want := http.StatusForbidden
			if expectation.roles[role] {
				want = 299
			}
			if got != want {
				t.Errorf("%s %s with %s session = %d, want %d", expectation.method, expectation.path, role, got, want)
			}
		}
	}
}

func TestSendingAndFormSurfacesPreserveDependencyIdentity(t *testing.T) {
	t.Parallel()

	sendingDeps := newSendingDiscoveryRouteDeps(chi.NewRouter())
	sendingSurface := MountSendingDiscoveryRoutes(sendingDeps)
	if sendingSurface.Sending != sendingDeps.Sending || sendingSurface.IntelligentRetry == nil ||
		sendingSurface.IntelligentRetry.Queue != sendingDeps.IntelligentRetry ||
		sendingSurface.IntelligentRetry.Logger != sendingDeps.Logger || sendingSurface.TriggerDelay == nil ||
		sendingSurface.TriggerDelay.Repo != sendingDeps.TriggerDelay || sendingSurface.NQL == nil ||
		sendingSurface.NQL.Pool != sendingDeps.Pool || sendingSurface.AnalyticsNQL == nil ||
		sendingSurface.AnalyticsNQL.Pool != sendingDeps.Pool || sendingSurface.AnalyticsNQL.Logger != sendingDeps.Logger ||
		sendingSurface.AnalyticsNQL.Tracker != sendingDeps.Audit.NLQTracker {
		t.Fatal("sending/discovery surface changed handler, queue, repository, pool, logger, or NLQ tracker identity")
	}

	withoutProvision := newSendingDiscoveryRouteDeps(chi.NewRouter())
	withoutProvision.EnableDirectProvision = false
	MountSendingDiscoveryRoutes(withoutProvision)
	if routes := subscriberListSegmentRoutes(t, withoutProvision.Router); len(routes) != 28 || hasRoute(routes, "/api/v1/sending/provision") {
		t.Fatalf("disabled direct provision registered an unexpected route: count=%d", len(routes))
	}

	formDeps := newFormAdminRouteDeps(chi.NewRouter())
	formSurface := MountFormAdminRoutes(formDeps)
	if formSurface.Embed == nil || formSurface.Embed.Deps != formDeps.Forms ||
		formSurface.Embed.PublicBaseURL != formDeps.PublicBaseURL || formSurface.Embed.FormsPublicHost != formDeps.FormsPublicHost ||
		formSurface.Variants == nil || formSurface.Variants.Repo == nil || formSurface.Variants.Repo.Pool != formDeps.Pool {
		t.Fatal("form surface changed handler, URL, or pool identity")
	}
}

func TestSendingAndFormRoutesRejectStructurallyIncompleteDependencies(t *testing.T) {
	t.Parallel()

	sending := newSendingDiscoveryRouteDeps(chi.NewRouter())
	for _, incomplete := range []SendingDiscoveryRouteDeps{
		{Pool: sending.Pool, Sending: sending.Sending, IntelligentRetry: sending.IntelligentRetry, TriggerDelay: sending.TriggerDelay, Audit: sending.Audit},
		{Router: chi.NewRouter(), Sending: sending.Sending, IntelligentRetry: sending.IntelligentRetry, TriggerDelay: sending.TriggerDelay, Audit: sending.Audit},
		{Router: chi.NewRouter(), Pool: sending.Pool, IntelligentRetry: sending.IntelligentRetry, TriggerDelay: sending.TriggerDelay, Audit: sending.Audit},
		{Router: chi.NewRouter(), Pool: sending.Pool, Sending: sending.Sending, TriggerDelay: sending.TriggerDelay, Audit: sending.Audit},
		{Router: chi.NewRouter(), Pool: sending.Pool, Sending: sending.Sending, IntelligentRetry: sending.IntelligentRetry, Audit: sending.Audit},
		{Router: chi.NewRouter(), Pool: sending.Pool, Sending: sending.Sending, IntelligentRetry: sending.IntelligentRetry, TriggerDelay: sending.TriggerDelay},
	} {
		surface := MountSendingDiscoveryRoutes(incomplete)
		if surface.Sending != nil || surface.IntelligentRetry != nil || surface.TriggerDelay != nil || surface.NQL != nil || surface.AnalyticsNQL != nil {
			t.Fatal("structurally incomplete sending dependencies returned a partial surface")
		}
		if incomplete.Router != nil && routeCount(t, incomplete.Router) != 0 {
			t.Fatal("structurally incomplete sending dependencies registered partial routes")
		}
	}

	formsDeps := newFormAdminRouteDeps(chi.NewRouter())
	for _, incomplete := range []FormAdminRouteDeps{
		{Pool: formsDeps.Pool, Forms: formsDeps.Forms},
		{Router: chi.NewRouter(), Forms: formsDeps.Forms},
		{Router: chi.NewRouter(), Pool: formsDeps.Pool},
		{Router: chi.NewRouter(), Pool: formsDeps.Pool, Forms: &forms.Deps{}},
	} {
		surface := MountFormAdminRoutes(incomplete)
		if surface.Embed != nil || surface.Variants != nil {
			t.Fatal("structurally incomplete form dependencies returned a partial surface")
		}
		if incomplete.Router != nil && routeCount(t, incomplete.Router) != 0 {
			t.Fatal("structurally incomplete form dependencies registered partial routes")
		}
	}
}

func TestSendingAndFormRouteOrderAndMainOwnership(t *testing.T) {
	t.Parallel()

	sourceBytes, err := os.ReadFile("sending_forms_routes.go")
	if err != nil {
		t.Fatalf("read sending_forms_routes.go: %v", err)
	}
	assertOrderedOccurrences(t, string(sourceBytes), []string{
		`Post("/api/v1/sending/provision"`,
		`Get("/api/v1/sending/state"`,
		`Post("/api/v1/sending/controls/resume"`,
		"frequency.MountRoutes(",
		"intelligent_retry.MountRoutes(",
		"trigger_delay.MountRoutes(",
		"content_optimizer.MountRoutes(",
		"content_remix.MountRoutes(",
		"search.MountRoutes(",
		"nql.MountRoutes(",
		"nql.MountAnalyticsRoutes(",
		"func MountFormAdminRoutes",
		"embed.MountAdminRoutes(",
		`Get("/api/v1/forms"`,
		`Get("/api/v1/forms/{id}/analytics"`,
		"variants.MountRoutes(",
	})

	root := readAPICompositionRoot(t)
	mainSource := root.main
	assertOrderedOccurrences(t, mainSource, []string{
		"apiserver.MountAdminIPRoutes(",
		"apiserver.MountSendingDiscoveryRoutes(",
		"apiserver.MountFormAdminRoutes(",
		"segmentsDeps :=",
	})
	formCreateGate := `r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).Post("/api/v1/forms", observability.RecordSurfaceFunc("forms", "create", formsDeps.Create))`
	if !strings.Contains(mainSource, formCreateGate) {
		t.Fatalf("main.go form creation is not aligned with the campaign-authoring scope")
	}
	for _, forbidden := range []string{
		"embedDeps :=",
		"frequency.MountRoutes(r,",
		"intelligent_retry.MountRoutes(r,",
		"nql.MountAnalyticsRoutes(r,",
		`observability.RecordSurfaceFunc("forms", "submissions_csv"`,
		`r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/forms",`,
		"form_variants.Deps{",
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root retained migrated sending/form composition %q", forbidden)
		}
	}
}

func assertRouteSetsAndScopesMatch(t *testing.T, actualRouter, referenceRouter chi.Router, wantCount int, scopeSets [][]apikeys.Scope) {
	t.Helper()
	actual := subscriberListSegmentRoutes(t, actualRouter)
	reference := subscriberListSegmentRoutes(t, referenceRouter)
	if len(actual) != len(reference) || len(actual) != wantCount {
		t.Fatalf("migrated/reference route counts = %d/%d, want %d", len(actual), len(reference), wantCount)
	}
	for index := range reference {
		got, want := actual[index], reference[index]
		if got.method != want.method || got.path != want.path || len(got.middlewares) != len(want.middlewares) {
			t.Fatalf("route[%d] = %s %s (%d middleware), want %s %s (%d)", index, got.method, got.path, len(got.middlewares), want.method, want.path, len(want.middlewares))
		}
		for _, scopes := range scopeSets {
			gotResponse := serveRouteMiddleware(got, scopes)
			wantResponse := serveRouteMiddleware(want, scopes)
			if gotResponse.Code != wantResponse.Code || gotResponse.Body.String() != wantResponse.Body.String() {
				t.Errorf("%s %s scopes %v = (%d,%q), want (%d,%q)", got.method, got.path, scopes, gotResponse.Code, gotResponse.Body.String(), wantResponse.Code, wantResponse.Body.String())
			}
		}
	}
}

func hasRoute(routes []subscriberListSegmentRoute, path string) bool {
	for _, route := range routes {
		if route.path == path {
			return true
		}
	}
	return false
}

func findFormRoute(t *testing.T, routes []subscriberListSegmentRoute, method, path string) subscriberListSegmentRoute {
	t.Helper()
	for _, route := range routes {
		if route.method == method && route.path == path {
			return route
		}
	}
	t.Fatalf("route %s %s was not mounted", method, path)
	return subscriberListSegmentRoute{}
}

func scopeAllowlist(scopes ...apikeys.Scope) map[apikeys.Scope]bool {
	allowed := make(map[apikeys.Scope]bool, len(scopes))
	for _, scope := range scopes {
		allowed[scope] = true
	}
	return allowed
}

func roleAllowlist(roles ...string) map[string]bool {
	allowed := make(map[string]bool, len(roles))
	for _, role := range roles {
		allowed[role] = true
	}
	return allowed
}

func serveFormRouteMiddlewareAsRole(route subscriberListSegmentRoute, role string) *httptest.ResponseRecorder {
	terminal := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(299)
		_, _ = w.Write([]byte("role-passed"))
	})
	var handler http.Handler = terminal
	for index := len(route.middlewares) - 1; index >= 0; index-- {
		handler = route.middlewares[index](handler)
	}
	request := httptest.NewRequest(route.method, materializeRoutePath(route.path), http.NoBody)
	ctx := middleware.WithUser(request.Context(), &middleware.User{
		ID: "user-1", TenantID: "tenant-1", Role: role,
	})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request.WithContext(ctx))
	return response
}

func newSendingDiscoveryRouteDeps(router chi.Router) SendingDiscoveryRouteDeps {
	pool := &db.Pool{}
	return SendingDiscoveryRouteDeps{
		Router:                router,
		Pool:                  pool,
		Logger:                slog.New(slog.NewTextHandler(io.Discard, nil)),
		Sending:               &handlers.SendingHandlers{},
		EnableDirectProvision: true,
		IntelligentRetry:      &intelligent_retry.Queue{Pool: pool},
		TriggerDelay:          &trigger_delay.Repo{Pool: pool},
		Audit: &handlers.AuditHandlers{
			Pool: pool, NLQTracker: audit.NewDailyCostTracker(audit.DefaultDailyTokenCap),
		},
	}
}

func newFormAdminRouteDeps(router chi.Router) FormAdminRouteDeps {
	pool := &db.Pool{}
	return FormAdminRouteDeps{
		Router: router, Pool: pool, Forms: &forms.Deps{Repo: &forms.Repo{Pool: pool}},
		PublicBaseURL: "https://api.invalid", FormsPublicHost: "https://forms.invalid",
	}
}

func mountLegacySendingDiscoveryRoutes(deps SendingDiscoveryRouteDeps) {
	if deps.EnableDirectProvision {
		deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/sending/provision", deps.Sending.Provision)
	}
	readReports := apikeys.RequireScope(apikeys.ScopeReadReports)
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	deps.Router.With(readReports).Get("/api/v1/sending/state", deps.Sending.State)
	deps.Router.With(readReports).Get("/api/v1/sending/warmup", deps.Sending.Warmup)
	deps.Router.With(readReports).Get("/api/v1/sending/controls", deps.Sending.ControlsState)
	deps.Router.With(readReports).Get("/api/v1/sending/readiness", deps.Sending.Readiness)
	deps.Router.With(admin).Post("/api/v1/sending/controls/pause", deps.Sending.PauseEmailSending)
	deps.Router.With(admin).Post("/api/v1/sending/controls/resume", deps.Sending.ResumeEmailSending)
	frequency.MountRoutes(deps.Router, &frequency.Deps{Pool: deps.Pool})
	intelligent_retry.MountRoutes(deps.Router, &intelligent_retry.Deps{Queue: deps.IntelligentRetry})
	trigger_delay.MountRoutes(deps.Router, &trigger_delay.Deps{Repo: deps.TriggerDelay})
	content_optimizer.MountRoutes(deps.Router, &content_optimizer.Deps{Repo: &content_optimizer.Repo{Pool: deps.Pool}})
	content_remix.MountRoutes(deps.Router, &content_remix.Deps{Pool: deps.Pool})
	search.MountRoutes(deps.Router, &search.Deps{Repo: &search.Repo{Pool: deps.Pool}, Logger: deps.Logger})
	nql.MountRoutes(deps.Router, &nql.Deps{Pool: deps.Pool})
	nql.MountAnalyticsRoutes(deps.Router, &nql.AnalyticsDeps{
		Pool: deps.Pool, Logger: deps.Logger, LLM: deps.Audit.NLQLLM, Tracker: deps.Audit.NLQTracker,
	})
}

func mountExpectedFormAdminRoutes(deps FormAdminRouteDeps) {
	embed := &forms.EmbedDeps{Deps: deps.Forms, PublicBaseURL: deps.PublicBaseURL, FormsPublicHost: deps.FormsPublicHost}
	embed.MountAdminRoutes(deps.Router)
	readCampaigns := apikeys.RequireScope(apikeys.ScopeReadCampaigns)
	writeCampaigns := apikeys.RequireScope(apikeys.ScopeWriteCampaigns)
	readReports := apikeys.RequireScope(apikeys.ScopeReadReports)
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	deps.Router.With(readCampaigns).Get("/api/v1/forms", observability.RecordSurfaceFunc("forms", "list", deps.Forms.List))
	deps.Router.With(readCampaigns).Get("/api/v1/forms/{id}", observability.RecordSurfaceFunc("forms", "get", deps.Forms.Get))
	deps.Router.With(writeCampaigns).Patch("/api/v1/forms/{id}", observability.RecordSurfaceFunc("forms", "update", deps.Forms.Update))
	deps.Router.With(admin).Delete("/api/v1/forms/{id}", observability.RecordSurfaceFunc("forms", "delete", deps.Forms.Delete))
	deps.Router.With(admin).Get("/api/v1/forms/{id}/submissions", observability.RecordSurfaceFunc("forms", "list_submissions", deps.Forms.ListSubmissions))
	deps.Router.With(admin).Get("/api/v1/forms/{id}/submissions.csv", observability.RecordSurfaceFunc("forms", "submissions_csv", deps.Forms.SubmissionsCSV))
	deps.Router.With(admin).Delete("/api/v1/forms/{id}/submissions/{submissionId}", observability.RecordSurfaceFunc("forms", "delete_submission", deps.Forms.DeleteSubmission))
	deps.Router.With(admin).Post("/api/v1/forms/{id}/submissions/{submissionId}/resend-confirmation", observability.RecordSurfaceFunc("forms", "resend_confirmation", deps.Forms.ResendConfirmation))
	deps.Router.With(readReports).Get("/api/v1/forms/{id}/analytics", observability.RecordSurfaceFunc("forms", "analytics", deps.Forms.Analytics))
	(&form_variants.Deps{Repo: &form_variants.Repo{Pool: deps.Pool}}).MountRoutes(deps.Router)
}
