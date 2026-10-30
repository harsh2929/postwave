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
	"github.com/postwave/postwave/apps/api/internal/audit/agent"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/handlers"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestMountAuditOperationsSurfaceMatchesEveryLegacyRouteAndScope(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newAuditOperationsDeps(actualRouter)
	MountAuditOperationsSurface(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newAuditOperationsDeps(referenceRouter)
	mountLegacyAuditOperationsSurface(referenceDeps)

	actual := subscriberListSegmentRoutes(t, actualRouter)
	reference := subscriberListSegmentRoutes(t, referenceRouter)
	if len(actual) != len(reference) {
		t.Fatalf("migrated route count = %d, legacy route count = %d", len(actual), len(reference))
	}
	// 52 since PATCH /api/v1/audit/access-requests/{id} completed the persisted
	// request-review state machine.
	if len(actual) != 52 {
		t.Fatalf("audit-operations route count = %d, want 52", len(actual))
	}

	scopeSets := []struct {
		name   string
		scopes []apikeys.Scope
	}{
		{name: "none"},
		{name: "audit read", scopes: []apikeys.Scope{apikeys.ScopeAuditRead}},
		{name: "audit pii", scopes: []apikeys.Scope{apikeys.ScopeAuditReadPII}},
		{name: "audit read and pii", scopes: []apikeys.Scope{apikeys.ScopeAuditRead, apikeys.ScopeAuditReadPII}},
		{name: "audit read pii and execute", scopes: []apikeys.Scope{apikeys.ScopeAuditRead, apikeys.ScopeAuditReadPII, apikeys.ScopeAuditExecuteActions}},
		{name: "admin", scopes: []apikeys.Scope{apikeys.ScopeAdmin}},
		{name: "read and retention", scopes: []apikeys.Scope{apikeys.ScopeAuditRead, apikeys.ScopeAuditConfigureRetention}},
		{name: "read and sinks", scopes: []apikeys.Scope{apikeys.ScopeAuditRead, apikeys.ScopeAuditConfigureSinks}},
		{name: "read pii and sinks", scopes: []apikeys.Scope{apikeys.ScopeAuditRead, apikeys.ScopeAuditReadPII, apikeys.ScopeAuditConfigureSinks}},
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

func TestAuditRawEvidenceRoutesRequireReadAndPIIScopes(t *testing.T) {
	t.Parallel()

	router := chi.NewRouter()
	MountAuditOperationsSurface(newAuditOperationsDeps(router))
	routes := subscriberListSegmentRoutes(t, router)
	rawRoutes := []struct {
		method string
		path   string
	}{
		{method: http.MethodGet, path: "/api/v1/audit"},
		{method: http.MethodGet, path: "/api/v1/audit/export"},
		{method: http.MethodGet, path: "/api/v1/audit/export/manifests"},
		{method: http.MethodGet, path: "/api/v1/audit/stats"},
		{method: http.MethodGet, path: "/api/v1/audit/chain/{requestId}"},
		{method: http.MethodGet, path: "/api/v1/audit/stream"},
		{method: http.MethodGet, path: "/api/v1/audit/saved-views"},
		{method: http.MethodGet, path: "/api/v1/audit/{id}/session-replay"},
		{method: http.MethodGet, path: "/api/v1/audit/{id}/anomaly-score"},
		{method: http.MethodGet, path: "/api/v1/audit/anomalies/recent"},
		{method: http.MethodGet, path: "/api/v1/audit/investigations"},
		{method: http.MethodGet, path: "/api/v1/audit/investigations/{id}"},
		{method: http.MethodGet, path: "/api/v1/audit/investigations/{id}/stream"},
		{method: http.MethodGet, path: "/api/v1/audit/ai-session/{session_id}/aivs-bundle"},
		{method: http.MethodGet, path: "/api/v1/audit/retention-activity"},
		{method: http.MethodGet, path: "/api/v1/audit/count"},
		{method: http.MethodGet, path: "/api/v1/audit/export-jobs"},
		{method: http.MethodGet, path: "/api/v1/audit/export-jobs/{id}"},
		{method: http.MethodGet, path: "/api/v1/audit/export-jobs/{id}/download"},
		{method: http.MethodGet, path: "/api/v1/audit/export-schedules"},
		{method: http.MethodGet, path: "/api/v1/audit/events"},
		{method: http.MethodGet, path: "/api/v1/audit/portal/sessions"},
	}
	if len(rawRoutes) != 22 {
		t.Fatalf("raw-evidence read route contract contains %d routes, want 22", len(rawRoutes))
	}

	scopeCases := []struct {
		name   string
		scopes []apikeys.Scope
		want   int
	}{
		{name: "no scopes", want: http.StatusForbidden},
		{name: "read only", scopes: []apikeys.Scope{apikeys.ScopeAuditRead}, want: http.StatusForbidden},
		{name: "pii only", scopes: []apikeys.Scope{apikeys.ScopeAuditReadPII}, want: http.StatusForbidden},
		{name: "read and pii", scopes: []apikeys.Scope{apikeys.ScopeAuditRead, apikeys.ScopeAuditReadPII}, want: 299},
		{name: "admin wildcard", scopes: []apikeys.Scope{apikeys.ScopeAdmin}, want: 299},
	}
	for _, rawRoute := range rawRoutes {
		route := findAuditOperationRoute(t, routes, rawRoute.method, rawRoute.path)
		for _, scopeCase := range scopeCases {
			response := serveRouteMiddleware(route, scopeCase.scopes)
			if response.Code != scopeCase.want {
				t.Errorf(
					"%s %s with %s = %d body=%q, want %d",
					rawRoute.method,
					rawRoute.path,
					scopeCase.name,
					response.Code,
					response.Body.String(),
					scopeCase.want,
				)
			}
		}
	}
}

func TestAuditExecuteMutationsRequireReadPIIAndExecuteScopes(t *testing.T) {
	t.Parallel()

	router := chi.NewRouter()
	MountAuditOperationsSurface(newAuditOperationsDeps(router))
	routes := subscriberListSegmentRoutes(t, router)
	executeRoutes := []struct {
		method string
		path   string
	}{
		{method: http.MethodPost, path: "/api/v1/audit/nlq"},
		{method: http.MethodPost, path: "/api/v1/audit/export-async"},
		{method: http.MethodPost, path: "/api/v1/audit/saved-views"},
		{method: http.MethodPatch, path: "/api/v1/audit/saved-views/{id}"},
		{method: http.MethodDelete, path: "/api/v1/audit/saved-views/{id}"},
		{method: http.MethodPost, path: "/api/v1/audit/{id}/investigate"},
		{method: http.MethodPost, path: "/api/v1/audit/{id}/unmask"},
	}
	if len(executeRoutes) != 7 {
		t.Fatalf("execute-action route contract contains %d routes, want 7", len(executeRoutes))
	}

	scopeCases := []struct {
		name   string
		scopes []apikeys.Scope
		want   int
	}{
		{name: "no scopes", want: http.StatusForbidden},
		{name: "missing read", scopes: []apikeys.Scope{apikeys.ScopeAuditReadPII, apikeys.ScopeAuditExecuteActions}, want: http.StatusForbidden},
		{name: "missing pii", scopes: []apikeys.Scope{apikeys.ScopeAuditRead, apikeys.ScopeAuditExecuteActions}, want: http.StatusForbidden},
		{name: "missing execute", scopes: []apikeys.Scope{apikeys.ScopeAuditRead, apikeys.ScopeAuditReadPII}, want: http.StatusForbidden},
		{name: "all required", scopes: []apikeys.Scope{apikeys.ScopeAuditRead, apikeys.ScopeAuditReadPII, apikeys.ScopeAuditExecuteActions}, want: 299},
		{name: "admin wildcard", scopes: []apikeys.Scope{apikeys.ScopeAdmin}, want: 299},
	}
	for _, executeRoute := range executeRoutes {
		route := findAuditOperationRoute(t, routes, executeRoute.method, executeRoute.path)
		for _, scopeCase := range scopeCases {
			response := serveRouteMiddleware(route, scopeCase.scopes)
			if response.Code != scopeCase.want {
				t.Errorf(
					"%s %s with %s = %d body=%q, want %d",
					executeRoute.method,
					executeRoute.path,
					scopeCase.name,
					response.Code,
					response.Body.String(),
					scopeCase.want,
				)
			}
		}
	}
}

func TestAuditNonEvidenceConfigurationReadsRemainReadScoped(t *testing.T) {
	t.Parallel()

	router := chi.NewRouter()
	MountAuditOperationsSurface(newAuditOperationsDeps(router))
	routes := subscriberListSegmentRoutes(t, router)
	for _, safeRead := range []struct {
		method string
		path   string
	}{
		{method: http.MethodGet, path: "/api/v1/audit/retention"},
		{method: http.MethodGet, path: "/api/v1/audit/redaction-policies"},
		{method: http.MethodGet, path: "/api/v1/audit/nlq/cost-status"},
	} {
		route := findAuditOperationRoute(t, routes, safeRead.method, safeRead.path)
		if response := serveRouteMiddleware(route, []apikeys.Scope{apikeys.ScopeAuditRead}); response.Code != 299 {
			t.Errorf("%s %s with read scope = %d body=%q, want 299", safeRead.method, safeRead.path, response.Code, response.Body.String())
		}
		if response := serveRouteMiddleware(route, []apikeys.Scope{apikeys.ScopeAuditReadPII}); response.Code != http.StatusForbidden {
			t.Errorf("%s %s with pii-only scope = %d, want 403", safeRead.method, safeRead.path, response.Code)
		}
	}
}

func TestAuditExportScheduleAdministrationRequiresReadPIIAndSinkScopes(t *testing.T) {
	t.Parallel()

	router := chi.NewRouter()
	MountAuditOperationsSurface(newAuditOperationsDeps(router))
	routes := subscriberListSegmentRoutes(t, router)
	for _, operation := range []struct {
		method string
		path   string
	}{
		{method: http.MethodPost, path: "/api/v1/audit/export-schedules"},
		{method: http.MethodDelete, path: "/api/v1/audit/export-schedules/{id}"},
	} {
		route := findAuditOperationRoute(t, routes, operation.method, operation.path)
		for name, scopes := range map[string][]apikeys.Scope{
			"read and pii":  {apikeys.ScopeAuditRead, apikeys.ScopeAuditReadPII},
			"read and sink": {apikeys.ScopeAuditRead, apikeys.ScopeAuditConfigureSinks},
			"pii and sink":  {apikeys.ScopeAuditReadPII, apikeys.ScopeAuditConfigureSinks},
		} {
			if response := serveRouteMiddleware(route, scopes); response.Code != http.StatusForbidden {
				t.Errorf("%s %s with %s = %d, want 403", operation.method, operation.path, name, response.Code)
			}
		}
		allRequired := []apikeys.Scope{
			apikeys.ScopeAuditRead,
			apikeys.ScopeAuditReadPII,
			apikeys.ScopeAuditConfigureSinks,
		}
		if response := serveRouteMiddleware(route, allRequired); response.Code != 299 {
			t.Errorf("%s %s with all required scopes = %d body=%q, want 299", operation.method, operation.path, response.Code, response.Body.String())
		}
	}
}

func TestAuditOperationsOwnsTheOnlyCanonicalRolesRoutes(t *testing.T) {
	t.Parallel()

	router := chi.NewRouter()
	MountAuditOperationsSurface(newAuditOperationsDeps(router))
	counts := map[string]int{}
	for _, route := range subscriberListSegmentRoutes(t, router) {
		counts[route.method+" "+route.path]++
	}
	for _, route := range []string{
		"GET /api/v1/roles",
		"PUT /api/v1/roles/{id}/scopes",
	} {
		if counts[route] != 1 {
			t.Fatalf("canonical role route %s mounted %d times, want exactly once", route, counts[route])
		}
	}

	compositionRoot := readAPICompositionRoot(t).all
	for _, forbidden := range []string{"roles.MountRoutes(", "internal/roles", "internal/rbacstore"} {
		if strings.Contains(compositionRoot, forbidden) {
			t.Fatalf("composition root retained incompatible duplicate roles composition %q", forbidden)
		}
	}
}

func TestMountAuditOperationsSurfacePreservesRegistrationOrderAndIdentity(t *testing.T) {
	t.Parallel()

	sourceBytes, err := os.ReadFile("audit_operations.go")
	if err != nil {
		t.Fatalf("read audit_operations.go: %v", err)
	}
	source := string(sourceBytes)
	ordered := []string{
		"audit.List)",
		"audit.Export)",
		"audit.ListExportManifests)",
		"audit.Stats)",
		"audit.Stream)",
		"audit.ListSavedViews)",
		"audit.CreateSavedView)",
		"audit.UpdateSavedView)",
		"audit.DeleteSavedView)",
		"audit.GetRetention)",
		"audit.SetRetention)",
		"audit.QueryNaturalLanguage)",
		"audit.NLQCostStatus)",
		"rbac.MyScopes)",
		"rbac.ListRoles)",
		"rbac.UpdateRoleScopes)",
		"proofs.LatestCheckpoint)",
		"proofs.ConsistencyProof)",
		"proofs.InclusionProof)",
		"audit.SessionReplay)",
		"audit.AnomalyScore)",
		"audit.RecentAnomalies)",
		"investigations.Trigger)",
		"investigations.List)",
		"investigations.Get)",
		"investigations.Approve)",
		"investigations.Reject)",
		"investigations.Stream)",
		"audit.AIVSBundle)",
		"audit.GetRedactionPolicy)",
		"audit.PutRedactionPolicy)",
		"audit.UnmaskPII)",
		"audit.ListRetentionActivity)",
		"audit.SetRetentionOverride)",
		"audit.Count)",
		"audit.ExportAsync)",
		"audit.ListExportJobs)",
		"audit.GetExportJob)",
		"audit.DownloadExportJob)",
		"audit.ListExportSchedules)",
		"audit.CreateExportSchedule)",
		"audit.DeleteExportSchedule)",
		"audit.EventsByIDs)",
		"audit.CreateAccessRequest)",
		"audit.ListAccessRequests)",
		"portal.CreateSession)",
		"portal.ListSessions)",
		"portal.RevokeSession)",
	}
	if len(ordered) != 48 {
		t.Fatalf("registration contract contains %d entries, want 48", len(ordered))
	}
	assertOrderedOccurrences(t, source, ordered)

	for _, marker := range []string{
		"audit := deps.AuditOperations.Handlers",
		"portal := deps.AuditOperations.Portal",
		"AuditRBACHandlers{Pool: deps.Pool, Logger: deps.Log()}",
		"handlers.NewProofHandlers(deps.Pool)",
		"agent.NewInvestigator(deps.Pool)",
		"&agent.Store{Pool: deps.Pool}",
		"Logger:       deps.Log()",
	} {
		if !strings.Contains(source, marker) {
			t.Fatalf("audit dependency identity contract missing %q", marker)
		}
	}
	assertServerMarkersInOrder(t, source, []string{
		"func MountAuditOperationsSurface(",
		"gates := newAuditRouteGates(deps)",
		"mountAuditCoreRoutes(deps.Router, deps.AuditOperations.Handlers, gates)",
		"mountAuditInvestigationRoutes(deps, gates)",
		"mountAuditEvidenceRoutes(deps, gates)",
	})
}

func TestAuditOperationsSurfaceUsesPassedAuthenticatedRouter(t *testing.T) {
	root := chi.NewRouter()
	root.Group(func(authenticated chi.Router) {
		authenticated.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("X-Test-Authenticated-Boundary", "applied")
				next.ServeHTTP(w, r)
			})
		})
		MountAuditOperationsSurface(newAuditOperationsDeps(authenticated))
	})

	request := httptest.NewRequest(http.MethodGet, "/api/v1/audit", http.NoBody)
	request = request.WithContext(middleware.WithAPIKeyAuth(request.Context()))
	response := httptest.NewRecorder()
	root.ServeHTTP(response, request)
	if response.Header().Get("X-Test-Authenticated-Boundary") != "applied" {
		t.Fatal("audit route escaped the passed authenticated router")
	}
	if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "insufficient_scope") {
		t.Fatalf("status = %d body = %s, want scoped 403", response.Code, response.Body.String())
	}
}

func TestAuditOperationsSurfaceRejectsIncompleteDependencyBags(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Deps)
	}{
		{name: "router", mutate: func(deps *Deps) { deps.Router = nil }},
		{name: "pool", mutate: func(deps *Deps) { deps.Pool = nil }},
		{name: "graph", mutate: func(deps *Deps) { deps.AuditOperations = nil }},
		{name: "handlers", mutate: func(deps *Deps) { deps.AuditOperations.Handlers = nil }},
		{name: "portal", mutate: func(deps *Deps) { deps.AuditOperations.Portal = nil }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			deps := newAuditOperationsDeps(chi.NewRouter())
			copy := *deps.AuditOperations
			deps.AuditOperations = &copy
			test.mutate(&deps)
			MountAuditOperationsSurface(deps)
			if deps.Router != nil && routeCount(t, deps.Router) != 0 {
				t.Fatal("incomplete audit graph registered a partial surface")
			}
		})
	}
}

func TestNewIncludesCompleteAuditOperationsSurface(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newAuditOperationsDeps(actualRouter)
	New(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newAuditOperationsDeps(referenceRouter)
	MountDeliverabilitySurface(referenceDeps)
	mountLegacyAuditOperationsSurface(referenceDeps)

	actual := subscriberListSegmentRoutes(t, actualRouter)
	reference := subscriberListSegmentRoutes(t, referenceRouter)
	if len(actual) != len(reference) {
		t.Fatalf("server.New route count = %d, want %d", len(actual), len(reference))
	}
	for index := range reference {
		if actual[index].method != reference[index].method || actual[index].path != reference[index].path {
			t.Fatalf("server.New route[%d] = %s %s, want %s %s", index, actual[index].method, actual[index].path, reference[index].method, reference[index].path)
		}
	}
}

func newAuditOperationsDeps(router chi.Router) Deps {
	pool := new(db.Pool)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return Deps{
		Router: router,
		Pool:   pool,
		Logger: logger,
		AuditOperations: &AuditOperationsDeps{
			Handlers: &handlers.AuditHandlers{Pool: pool, Logger: logger},
			Portal:   &handlers.AuditPortalHandlers{Pool: pool, Logger: logger},
		},
	}
}

func findAuditOperationRoute(
	t *testing.T,
	routes []subscriberListSegmentRoute,
	method string,
	path string,
) subscriberListSegmentRoute {
	t.Helper()
	for _, route := range routes {
		if route.method == method && route.path == path {
			return route
		}
	}
	t.Fatalf("audit operation route %s %s was not registered", method, path)
	return subscriberListSegmentRoute{}
}

func mountLegacyAuditOperationsSurface(deps Deps) {
	audit := deps.AuditOperations.Handlers
	portal := deps.AuditOperations.Portal
	read := apikeys.RequireScope(apikeys.ScopeAuditRead)
	raw := apikeys.RequireAllScopes(apikeys.ScopeAuditRead, apikeys.ScopeAuditReadPII)
	execute := apikeys.RequireAllScopes(
		apikeys.ScopeAuditRead,
		apikeys.ScopeAuditReadPII,
		apikeys.ScopeAuditExecuteActions,
	)
	meta := func(kind middleware.AuditReadKind) func(http.Handler) http.Handler {
		return middleware.AuditMetaMiddleware(deps.Pool, kind)
	}
	deps.Router.With(raw, meta(middleware.AuditReadList)).Get("/api/v1/audit", audit.List)
	deps.Router.With(raw, meta(middleware.AuditReadExport)).Get("/api/v1/audit/export", audit.Export)
	deps.Router.With(raw).Get("/api/v1/audit/export/manifests", audit.ListExportManifests)
	deps.Router.With(raw, meta(middleware.AuditReadStats)).Get("/api/v1/audit/stats", audit.Stats)
	deps.Router.With(raw, meta(middleware.AuditReadList)).
		Get("/api/v1/audit/chain/{requestId}", audit.AuditChain)
	deps.Router.With(raw, meta(middleware.AuditReadStreamOpen)).Get("/api/v1/audit/stream", audit.Stream)
	deps.Router.With(raw, meta(middleware.AuditReadSavedViews)).Get("/api/v1/audit/saved-views", audit.ListSavedViews)
	deps.Router.With(execute).Post("/api/v1/audit/saved-views", audit.CreateSavedView)
	deps.Router.With(execute).Patch("/api/v1/audit/saved-views/{id}", audit.UpdateSavedView)
	deps.Router.With(execute).Delete("/api/v1/audit/saved-views/{id}", audit.DeleteSavedView)
	deps.Router.With(read, meta(middleware.AuditReadRetention)).Get("/api/v1/audit/retention", audit.GetRetention)
	deps.Router.With(apikeys.RequireAllScopes(apikeys.ScopeAuditRead, apikeys.ScopeAuditConfigureRetention)).Put("/api/v1/audit/retention", audit.SetRetention)
	deps.Router.With(execute).Post("/api/v1/audit/nlq", audit.QueryNaturalLanguage)
	deps.Router.With(read).Get("/api/v1/audit/nlq/cost-status", audit.NLQCostStatus)
	rbac := &handlers.AuditRBACHandlers{Pool: deps.Pool, Logger: deps.Log()}
	deps.Router.Get("/api/v1/audit/my-scopes", rbac.MyScopes)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/roles", rbac.ListRoles)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Put("/api/v1/roles/{id}/scopes", rbac.UpdateRoleScopes)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/roles", rbac.CreateRole)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Delete("/api/v1/roles/{id}", rbac.DeleteRole)
	proofs := handlers.NewProofHandlers(deps.Pool)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/audit/checkpoint/latest", proofs.LatestCheckpoint)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/audit/consistency-proof", proofs.ConsistencyProof)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/audit/{id}/inclusion-proof", proofs.InclusionProof)
	deps.Router.With(raw).Get("/api/v1/audit/{id}/session-replay", audit.SessionReplay)
	deps.Router.With(raw).Get("/api/v1/audit/{id}/anomaly-score", audit.AnomalyScore)
	deps.Router.With(raw).Get("/api/v1/audit/anomalies/recent", audit.RecentAnomalies)
	investigations := &handlers.AuditInvestigationHandlers{
		Investigator: agent.NewInvestigator(deps.Pool),
		Store:        &agent.Store{Pool: deps.Pool},
		Logger:       deps.Log(),
	}
	deps.Router.With(execute).Post("/api/v1/audit/{id}/investigate", investigations.Trigger)
	deps.Router.With(raw).Get("/api/v1/audit/investigations", investigations.List)
	deps.Router.With(raw).Get("/api/v1/audit/investigations/{id}", investigations.Get)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/audit/investigations/{id}/approve", investigations.Approve)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/audit/investigations/{id}/reject", investigations.Reject)
	deps.Router.With(raw).Get("/api/v1/audit/investigations/{id}/stream", investigations.Stream)
	deps.Router.With(raw).Get("/api/v1/audit/ai-session/{session_id}/aivs-bundle", audit.AIVSBundle)
	deps.Router.With(read).Get("/api/v1/audit/redaction-policies", audit.GetRedactionPolicy)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Put("/api/v1/audit/redaction-policies", audit.PutRedactionPolicy)
	deps.Router.With(execute).Post("/api/v1/audit/{id}/unmask", audit.UnmaskPII)
	deps.Router.With(raw).Get("/api/v1/audit/retention-activity", audit.ListRetentionActivity)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Patch("/api/v1/audit/{id}/retention-override", audit.SetRetentionOverride)
	deps.Router.With(raw).Get("/api/v1/audit/count", audit.Count)
	deps.Router.With(execute).Post("/api/v1/audit/export-async", audit.ExportAsync)
	deps.Router.With(raw).Get("/api/v1/audit/export-jobs", audit.ListExportJobs)
	deps.Router.With(raw).Get("/api/v1/audit/export-jobs/{id}", audit.GetExportJob)
	deps.Router.With(raw).Get("/api/v1/audit/export-jobs/{id}/download", audit.DownloadExportJob)
	deps.Router.With(raw).Get("/api/v1/audit/export-schedules", audit.ListExportSchedules)
	deps.Router.With(apikeys.RequireAllScopes(apikeys.ScopeAuditRead, apikeys.ScopeAuditReadPII, apikeys.ScopeAuditConfigureSinks)).Post("/api/v1/audit/export-schedules", audit.CreateExportSchedule)
	deps.Router.With(apikeys.RequireAllScopes(apikeys.ScopeAuditRead, apikeys.ScopeAuditReadPII, apikeys.ScopeAuditConfigureSinks)).Delete("/api/v1/audit/export-schedules/{id}", audit.DeleteExportSchedule)
	deps.Router.With(raw, meta(middleware.AuditReadList)).Get("/api/v1/audit/events", audit.EventsByIDs)
	deps.Router.Post("/api/v1/audit/access-requests", audit.CreateAccessRequest)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/audit/access-requests", audit.ListAccessRequests)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Patch("/api/v1/audit/access-requests/{id}", audit.ResolveAccessRequest)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/audit/portal/sessions", portal.CreateSession)
	deps.Router.With(raw).Get("/api/v1/audit/portal/sessions", portal.ListSessions)
	deps.Router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Delete("/api/v1/audit/portal/sessions/{id}", portal.RevokeSession)
}
