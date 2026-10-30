// SPDX-License-Identifier: AGPL-3.0-only
//
// rbac_test.go — the EFFECTIVE authorization floor of the omnichannel read
// routes, measured rather than read off a manifest.
//
// The mobile omnichannel surface (AUTOMATION#33) had to decide a
// `minimumRole` for its route, and this package is one of the two places that
// answer is enforced. The other is `routeauth.Middleware`, which evaluates
// `internal/routeauth/manifest.json` independently; the effective floor is the
// STRICTER of the two and either can bind, so the mount-site guard has to be
// exercised on its own terms.
//
// What these tests pin:
//
//   - the three READS are mounted behind a single `RequireScope(read:campaigns)`,
//     which is inside the `readOnlyScopes` allowlist, so `requireAdminRoleForScopes`
//     is false and the session-role branch never runs — a VIEWER session clears
//     all three;
//   - the two WRITES do trigger the role branch and refuse a viewer session,
//     so "read-scoped" is a claim about the reads specifically and not about
//     the package.
//
// Both halves matter to the client: the first says the mobile route may be
// `viewer`, the second says it must stay read-only.

package omnichannel

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const rbacTenantID = "00000000-0000-0000-0000-000000000001"

var omniReadRoutes = []struct{ method, path string }{
	{http.MethodGet, "/api/v1/omnichannel/catalog"},
	{http.MethodGet, "/api/v1/omnichannel/campaigns"},
	{http.MethodGet, "/api/v1/omnichannel/campaigns/omni-1"},
}

var omniWriteRoutes = []struct{ method, path string }{
	{http.MethodPost, "/api/v1/omnichannel/campaigns"},
	{http.MethodPost, "/api/v1/omnichannel/validate"},
}

func rbacRouter() chi.Router {
	r := chi.NewRouter()
	MountRoutes(r, &Deps{})
	return r
}

// sessionRequest is the DASHBOARD path: a cookie session with a workspace
// role and no API-key scope claims. `IsAPIKeyAuth` is false, so RequireScope
// falls through to `requireAdminRoleForScopes` + `sessionRoleAllowsScopes`.
func sessionRequest(r *http.Request, role string) *http.Request {
	ctx := middleware.WithTenant(r.Context(), &middleware.Tenant{
		ID:   rbacTenantID,
		Slug: "acme",
		Name: "Acme",
	})
	ctx = middleware.WithUser(ctx, &middleware.User{
		ID:       "user-1",
		TenantID: rbacTenantID,
		Email:    "someone@example.test",
		Role:     role,
	})
	return r.WithContext(ctx)
}

func TestOmnichannelReads_AdmitAViewerSession(t *testing.T) {
	router := rbacRouter()
	for _, rt := range omniReadRoutes {
		t.Run(rt.method+" "+rt.path, func(t *testing.T) {
			req := httptest.NewRequest(rt.method, rt.path, nil)
			rec := httptest.NewRecorder()
			// A nil Repo panics inside the handler for the two DB-backed reads;
			// that is PAST the middleware, which is the only thing under test.
			defer func() { _ = recover() }()
			router.ServeHTTP(rec, sessionRequest(req, "viewer"))
			if rec.Code == http.StatusForbidden {
				t.Fatalf(
					"viewer session was refused at %s (%d) — the mobile route's "+
						"minimumRole must be raised: %s",
					rt.path, rec.Code, rec.Body.String(),
				)
			}
		})
	}
}

// The catalog handler touches no database at all (`writeJSON(w, 200, Catalog())`),
// so it is the one read that can be driven all the way to a 200 with an empty
// Deps — proving the viewer really reaches the handler rather than merely
// getting past one middleware.
func TestOmnichannelCatalog_ServesAViewerSessionEndToEnd(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/omnichannel/catalog", nil)
	rec := httptest.NewRecorder()
	rbacRouter().ServeHTTP(rec, sessionRequest(req, "viewer"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"runtime_status":"unavailable"`) {
		t.Fatalf("catalog did not report a contained runtime: %s", rec.Body.String())
	}
}

func TestOmnichannelReads_AdmitAReadCampaignsKey(t *testing.T) {
	router := rbacRouter()
	for _, rt := range omniReadRoutes {
		t.Run(rt.method+" "+rt.path, func(t *testing.T) {
			req := httptest.NewRequest(rt.method, rt.path, nil)
			rec := httptest.NewRecorder()
			ctx := middleware.WithAPIKeyAuth(req.Context())
			ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeReadCampaigns})
			ctx = middleware.WithTenant(ctx, &middleware.Tenant{
				ID: rbacTenantID, Slug: "acme", Name: "Acme",
			})
			defer func() { _ = recover() }()
			router.ServeHTTP(rec, req.WithContext(ctx))
			if rec.Code == http.StatusForbidden {
				t.Fatalf("read:campaigns refused at %s: %s", rt.path, rec.Body.String())
			}
		})
	}
}

func TestOmnichannelReads_RefuseAKeyWithoutCampaignRead(t *testing.T) {
	router := rbacRouter()
	for _, rt := range omniReadRoutes {
		t.Run(rt.method+" "+rt.path, func(t *testing.T) {
			req := httptest.NewRequest(rt.method, rt.path, nil)
			rec := httptest.NewRecorder()
			ctx := middleware.WithAPIKeyAuth(req.Context())
			ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeReadSubscribers})
			ctx = middleware.WithTenant(ctx, &middleware.Tenant{
				ID: rbacTenantID, Slug: "acme", Name: "Acme",
			})
			router.ServeHTTP(rec, req.WithContext(ctx))
			if rec.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want 403 at %s; body=%s",
					rec.Code, rt.path, rec.Body.String())
			}
		})
	}
}

// The reads being viewer-open must NOT be read as "the package is viewer-open".
func TestOmnichannelWrites_RefuseAViewerSession(t *testing.T) {
	router := rbacRouter()
	for _, rt := range omniWriteRoutes {
		t.Run(rt.method+" "+rt.path, func(t *testing.T) {
			req := httptest.NewRequest(rt.method, rt.path, strings.NewReader(`{}`))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, sessionRequest(req, "viewer"))
			if rec.Code != http.StatusForbidden {
				t.Fatalf("viewer session reached %s — got %d, want 403: %s",
					rt.path, rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), "insufficient_role") {
				t.Fatalf("expected insufficient_role envelope, got %s", rec.Body.String())
			}
		})
	}
}
