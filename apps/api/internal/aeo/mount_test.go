// SPDX-License-Identifier: AGPL-3.0-only

package aeo

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// aeoContractRoute is one row of the AEO Sensor route contract. `admin`
// mirrors what MountRoutes enforces: reads sit behind read:reports (any
// dashboard role), everything else behind admin (owner/admin role).
type aeoContractRoute struct {
	method string
	path   string
	admin  bool
}

// aeoContractRoutes is the exact surface advertised in
// packages/openapi/openapi.yaml and the routeauth manifest. A route added
// to MountRoutes without a row here fails TestMountRoutesDeclaresExactContract,
// and a row here without a mount fails it the other way.
var aeoContractRoutes = []aeoContractRoute{
	{http.MethodGet, "/api/v1/aeo/settings", false},
	{http.MethodPut, "/api/v1/aeo/settings", true},
	{http.MethodGet, "/api/v1/aeo/summary", false},
	{http.MethodGet, "/api/v1/aeo/rollups", false},
	{http.MethodGet, "/api/v1/aeo/prompts", false},
	{http.MethodPost, "/api/v1/aeo/prompts", true},
	{http.MethodPost, "/api/v1/aeo/prompts/{id}/toggle", true},
	{http.MethodDelete, "/api/v1/aeo/prompts/{id}", true},
	{http.MethodGet, "/api/v1/aeo/probes", false},
	{http.MethodGet, "/api/v1/aeo/competitors", false},
	{http.MethodPut, "/api/v1/aeo/competitors", true},
	{http.MethodDelete, "/api/v1/aeo/competitors/{key}", true},
	{http.MethodPost, "/api/v1/aeo/run-now", true},
}

// requestPath turns a chi pattern into a concrete request path.
func (r aeoContractRoute) requestPath() string {
	return strings.NewReplacer("{id}", "prompt-1", "{key}", "acme").Replace(r.path)
}

func newAEORouter(runner *Runner) chi.Router {
	router := chi.NewRouter()
	MountRoutes(router, &Deps{
		Repo:   &Repo{},
		Runner: runner,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	return router
}

// Requests deliberately carry NO tenant. Every handler checks the tenant
// before touching the repo, so "reached the handler" is observable as
// 401 no_tenant without a database, exactly as internal/predictive tests it.
func aeoAPIKeyRequest(t *testing.T, router chi.Router, route aeoContractRoute, scopes ...apikeys.Scope) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(route.method, route.requestPath(), nil)
	ctx := middleware.WithAPIKeyAuth(req.Context())
	ctx = apikeys.WithScopes(ctx, scopes)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req.WithContext(ctx))
	return rec
}

func aeoSessionRequest(t *testing.T, router chi.Router, route aeoContractRoute, role string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(route.method, route.requestPath(), nil)
	ctx := middleware.WithUser(req.Context(), &middleware.User{
		ID:       "user-1",
		TenantID: "tenant-1",
		Role:     role,
	})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req.WithContext(ctx))
	return rec
}

func assertStatusAndCode(t *testing.T, rec *httptest.ResponseRecorder, status int, code string, context string) {
	t.Helper()
	if rec.Code != status || !strings.Contains(rec.Body.String(), code) {
		t.Fatalf("%s: want %d %s, got status=%d body=%q", context, status, code, rec.Code, rec.Body.String())
	}
}

func TestMountRoutesDeclaresExactContract(t *testing.T) {
	router := newAEORouter(nil)
	mounted := map[string]bool{}
	err := chi.Walk(router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		mounted[method+" "+route] = true
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	expected := map[string]bool{}
	for _, r := range aeoContractRoutes {
		expected[r.method+" "+r.path] = true
	}
	var missing, extra []string
	for key := range expected {
		if !mounted[key] {
			missing = append(missing, key)
		}
	}
	for key := range mounted {
		if !expected[key] {
			extra = append(extra, key)
		}
	}
	sort.Strings(missing)
	sort.Strings(extra)
	if len(missing) > 0 || len(extra) > 0 {
		t.Fatalf("mounted surface drifted from contract\n  missing: %v\n  extra:   %v", missing, extra)
	}
	if len(mounted) != 13 {
		t.Fatalf("expected 13 AEO routes, got %d", len(mounted))
	}
}

func TestAEORoutesAPIKeyScopesMatchContract(t *testing.T) {
	router := newAEORouter(nil)
	for _, route := range aeoContractRoutes {
		name := route.method + " " + route.path
		t.Run(name, func(t *testing.T) {
			// A key with no scopes never reaches a handler.
			assertStatusAndCode(t, aeoAPIKeyRequest(t, router, route),
				http.StatusForbidden, "insufficient_scope", "no scopes")
			// An unrelated scope never reaches a handler.
			assertStatusAndCode(t, aeoAPIKeyRequest(t, router, route, apikeys.ScopeReadSubscribers),
				http.StatusForbidden, "insufficient_scope", "read:subscribers")
			// admin is a wildcard and reaches every handler.
			assertStatusAndCode(t, aeoAPIKeyRequest(t, router, route, apikeys.ScopeAdmin),
				http.StatusUnauthorized, "no_tenant", "admin scope")

			rec := aeoAPIKeyRequest(t, router, route, apikeys.ScopeReadReports)
			if route.admin {
				assertStatusAndCode(t, rec, http.StatusForbidden, "insufficient_scope", "read:reports on admin route")
			} else {
				assertStatusAndCode(t, rec, http.StatusUnauthorized, "no_tenant", "read:reports on read route")
			}
		})
	}
}

func TestAEORoutesSessionRolesMatchContract(t *testing.T) {
	router := newAEORouter(nil)
	for _, route := range aeoContractRoutes {
		name := route.method + " " + route.path
		t.Run(name, func(t *testing.T) {
			// Owners and admins reach every handler.
			for _, role := range []string{"admin", "owner"} {
				assertStatusAndCode(t, aeoSessionRequest(t, router, route, role),
					http.StatusUnauthorized, "no_tenant", role+" session")
			}
			// Viewers and editors reach reads only; the admin scope is not an
			// editor-tier content scope, so mutations and run-now are denied.
			for _, role := range []string{"viewer", "editor"} {
				rec := aeoSessionRequest(t, router, route, role)
				if route.admin {
					assertStatusAndCode(t, rec, http.StatusForbidden, "insufficient_role", role+" session on admin route")
				} else {
					assertStatusAndCode(t, rec, http.StatusUnauthorized, "no_tenant", role+" session on read route")
				}
			}
		})
	}
}

func TestAEORoutesRejectAnonymousPrincipal(t *testing.T) {
	router := newAEORouter(nil)
	for _, route := range aeoContractRoutes {
		req := httptest.NewRequest(route.method, route.requestPath(), nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		assertStatusAndCode(t, rec, http.StatusUnauthorized, "missing_principal", route.method+" "+route.path)
	}
}

func TestRunNowWithoutRunnerIsServiceUnavailable(t *testing.T) {
	router := newAEORouter(nil)
	route := aeoContractRoute{http.MethodPost, "/api/v1/aeo/run-now", true}
	req := httptest.NewRequest(route.method, route.requestPath(), nil)
	ctx := middleware.WithAPIKeyAuth(req.Context())
	ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeAdmin})
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: "00000000-0000-0000-0000-000000000001"})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req.WithContext(ctx))
	// httperror.Write rewrites every >=500 envelope to the generic
	// internal_error body, so the handler's runner_unavailable hint reaches the
	// client only as the 503 status, never as the code string.
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("nil runner: want 503, got status=%d body=%q", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "no_tenant") {
		t.Fatalf("nil runner: tenant context was not honoured: body=%q", rec.Body.String())
	}
}
