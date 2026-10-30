// SPDX-License-Identifier: AGPL-3.0-only
//
// rbac_test.go — verifies admin-rbac-require-scope (P0): the admin
// archive routes refuse a viewer-role API key (no admin scope, no
// write scope) and return 403 insufficient_scope. The same handler
// must accept a key carrying ScopeAdmin.
//
// This is a route-mounting test, not a handler test: it ensures the
// `RequireScope` middleware actually sits in front of every mutating
// archive route. Previously the routes were mounted bare, which let
// any tenant-authenticated viewer publish/unpublish/pin/unpin a
// campaign via direct API call, even though the desktop's
// `useCanWrite` UI guard hid the controls.

package archive

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// adminMutatingRoutes enumerates the (method, path) pairs that MUST
// require ScopeAdmin. Kept as a table so a future route added inside
// MountAdminRoutes can't silently bypass the scope gate without also
// updating this list.
var adminMutatingRoutes = []struct {
	method, path string
}{
	{http.MethodPost, "/api/v1/campaigns/abc/publish-archive"},
	{http.MethodPost, "/api/v1/campaigns/abc/unpublish-archive"},
	{http.MethodPost, "/api/v1/campaigns/abc/archive/pin"},
	{http.MethodPost, "/api/v1/campaigns/abc/archive/unpin"},
	{http.MethodPut, "/api/v1/admin/archive/tenant-settings"},
}

// adminReadRoutes are read-only — they accept read:reports OR admin.
var adminReadRoutes = []struct {
	method, path string
}{
	{http.MethodGet, "/api/v1/archive"},
	{http.MethodGet, "/api/v1/archive/stats"},
	{http.MethodGet, "/api/v1/admin/archive/tenant-settings"},
	// AdminPreview — gap feature `archive-html-preview-admin`. Read
	// access matches AdminList: viewer-role API keys can preview an
	// already-published issue alongside the existing read paths.
	{http.MethodGet, "/api/v1/admin/archive/issues/some-slug/preview"},
}

// mountRouter builds a chi router with the archive admin routes
// mounted and the panic-on-DB-touch handler swapped in for every
// admin handler. We never actually reach the handler in these tests
// — the 403 must fire at the middleware layer — so a no-op handler
// is sufficient. We bypass MountAdminRoutes' real handler wiring by
// using the very same RequireScope chain on stub routes.
func mountRouter() chi.Router {
	r := chi.NewRouter()
	d := &Deps{Repo: nil}
	d.MountAdminRoutes(r)
	return r
}

// viewerCtx attaches an API-key auth context with read-only scopes
// (no admin, no write:*, no read:reports). This is the surface
// described in the audit: a viewer-role API key that should NOT
// reach any mutating archive route.
func viewerCtx(r *http.Request) *http.Request {
	ctx := middleware.WithAPIKeyAuth(r.Context())
	ctx = apikeys.WithScopes(ctx, []apikeys.Scope{
		apikeys.ScopeReadSubscribers,
		apikeys.ScopeReadCampaigns,
	})
	// Tenant context — the handler would 401 without one but
	// RequireScope runs first.
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{
		ID:   "00000000-0000-0000-0000-000000000001",
		Slug: "acme",
		Name: "Acme",
	})
	return r.WithContext(ctx)
}

// adminCtx attaches an API-key auth context with ScopeAdmin.
func adminCtx(r *http.Request) *http.Request {
	ctx := middleware.WithAPIKeyAuth(r.Context())
	ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeAdmin})
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{
		ID:   "00000000-0000-0000-0000-000000000001",
		Slug: "acme",
		Name: "Acme",
	})
	return r.WithContext(ctx)
}

func TestArchiveAdminRoutes_RejectViewerScope(t *testing.T) {
	router := mountRouter()
	for _, rt := range adminMutatingRoutes {
		t.Run(rt.method+" "+rt.path, func(t *testing.T) {
			req := httptest.NewRequest(rt.method, rt.path, strings.NewReader(`{}`))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, viewerCtx(req))
			if rec.Code != http.StatusForbidden {
				t.Fatalf("viewer scope reached %s — got %d, want 403", rt.path, rec.Code)
			}
			if !strings.Contains(rec.Body.String(), "insufficient_scope") {
				t.Fatalf("expected insufficient_scope envelope, got %s", rec.Body.String())
			}
		})
	}
}

func TestArchiveAdminReadRoutes_RejectViewerScope(t *testing.T) {
	router := mountRouter()
	for _, rt := range adminReadRoutes {
		t.Run(rt.method+" "+rt.path, func(t *testing.T) {
			req := httptest.NewRequest(rt.method, rt.path, nil)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, viewerCtx(req))
			if rec.Code != http.StatusForbidden {
				t.Fatalf("viewer scope reached %s — got %d, want 403", rt.path, rec.Code)
			}
			if !strings.Contains(rec.Body.String(), "insufficient_scope") {
				t.Fatalf("expected insufficient_scope envelope, got %s", rec.Body.String())
			}
		})
	}
}

// TestArchiveAdminRoutes_PassAdminScope confirms the gate is
// permissive for ScopeAdmin keys — the request proceeds past the
// middleware. We don't care what the handler returns (likely a 500
// because Repo is nil), only that we get past 403.
func TestArchiveAdminRoutes_PassAdminScope(t *testing.T) {
	router := mountRouter()
	for _, rt := range adminMutatingRoutes {
		t.Run(rt.method+" "+rt.path, func(t *testing.T) {
			req := httptest.NewRequest(rt.method, rt.path, strings.NewReader(`{}`))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			// Recover from any handler-level panic (nil Repo); we
			// only care that we DIDN'T 403 at the middleware.
			defer func() { _ = recover() }()
			router.ServeHTTP(rec, adminCtx(req))
			if rec.Code == http.StatusForbidden {
				t.Fatalf("admin scope got 403 at %s — middleware misconfigured: %s", rt.path, rec.Body.String())
			}
		})
	}
}
