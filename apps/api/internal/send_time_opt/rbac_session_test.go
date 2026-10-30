// SPDX-License-Identifier: AGPL-3.0-only
//
// rbac_session_test.go — the EFFECTIVE floor of the send-time READS on the
// DASHBOARD (session-cookie) path.
//
// rbac_test.go covers the API-KEY path, where `RequireScope(ScopeReadReports,
// ScopeAdmin)` really does mean "reports OR admin". The session path is a
// different question with a different answer, and it is the one a client has to
// gate on:
//
//	RequireScope calls requireAdminRoleForScopes(required), which returns TRUE
//	as soon as ANY required scope is outside the readOnlyScopes allowlist
//	(apikeys/middleware.go:332-349). ScopeAdmin is outside it. The role branch
//	therefore runs, and sessionRoleAllowsScopes walks EVERY required scope and
//	rejects `admin` for anything below owner/admin (middleware.go:439-458).
//
// So the disjunction that reads as permissive on a key is admin-only on a
// session. That is the shape of finding several agents have misread, and the
// mobile Send Time screen (DELIVERABILITY#34) gates on it, so it is measured
// here rather than inferred.
//
// It is worth stating what this does NOT change: nothing here is loosened. The
// test only records where the existing floor is, and it additionally covers
// `/send-time-opt/best-time-analysis`, which rbac_test.go's `readRoutes` list
// omits.

package send_time_opt

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Every read this package mounts, including the one rbac_test.go's list misses.
var sessionReadRoutes = []struct{ method, path string }{
	{http.MethodGet, "/api/v1/subscribers/00000000-0000-0000-0000-0000000000ab/best-send-time"},
	{http.MethodGet, "/api/v1/send-time-opt"},
	{http.MethodGet, "/api/v1/send-time-opt/best-time-analysis"},
	{http.MethodGet, "/api/v1/subscribers/00000000-0000-0000-0000-0000000000ab/open-pattern"},
	{http.MethodGet, "/api/v1/send-time-opt/heatmap"},
}

// stoSessionRequest is a cookie session with a workspace role and NO API-key
// scope claims — `IsAPIKeyAuth` is false, so RequireScope takes the role branch.
func stoSessionRequest(r *http.Request, role string) *http.Request {
	const tenantID = "00000000-0000-0000-0000-000000000001"
	ctx := middleware.WithTenant(r.Context(), &middleware.Tenant{
		ID:   tenantID,
		Slug: "acme",
		Name: "Acme",
	})
	ctx = middleware.WithUser(ctx, &middleware.User{
		ID:       "user-1",
		TenantID: tenantID,
		Email:    "someone@example.test",
		Role:     role,
	})
	return r.WithContext(ctx)
}

func TestSTOReads_RefuseEverySessionRoleBelowAdmin(t *testing.T) {
	router := mountRouter()
	for _, role := range []string{"viewer", "member", "editor"} {
		for _, rt := range sessionReadRoutes {
			t.Run(role+" "+rt.path, func(t *testing.T) {
				req := httptest.NewRequest(rt.method, rt.path, nil)
				rec := httptest.NewRecorder()
				router.ServeHTTP(rec, stoSessionRequest(req, role))
				if rec.Code != http.StatusForbidden {
					t.Fatalf("%s session got %d at %s, want 403; body=%s",
						role, rec.Code, rt.path, rec.Body.String())
				}
				if !strings.Contains(rec.Body.String(), "insufficient_role") {
					t.Fatalf("expected insufficient_role envelope, got %s",
						rec.Body.String())
				}
			})
		}
	}
}

func TestSTOReads_AdmitOwnerAndAdminSessions(t *testing.T) {
	router := mountRouter()
	for _, role := range []string{"owner", "admin"} {
		for _, rt := range sessionReadRoutes {
			t.Run(role+" "+rt.path, func(t *testing.T) {
				req := httptest.NewRequest(rt.method, rt.path, nil)
				rec := httptest.NewRecorder()
				// Deps carries a nil Repo, so the handler panics once the
				// middleware lets it through. That is past the only thing
				// under test here.
				defer func() { _ = recover() }()
				router.ServeHTTP(rec, stoSessionRequest(req, role))
				if rec.Code == http.StatusForbidden {
					t.Fatalf("%s session was refused at %s: %s",
						role, rt.path, rec.Body.String())
				}
			})
		}
	}
}

// The mobile client treats an API-key principal as unable to clear an admin
// floor, because a key carries no role claim. This pins the server side of that
// asymmetry: an unauthenticated-but-tenanted request with no user at all is
// refused with `missing_principal`, not admitted.
func TestSTOReads_RefuseARequestWithNoPrincipal(t *testing.T) {
	router := mountRouter()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/send-time-opt/best-time-analysis", nil)
	rec := httptest.NewRecorder()
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{
		ID: "00000000-0000-0000-0000-000000000001", Slug: "acme", Name: "Acme",
	})
	router.ServeHTTP(rec, req.WithContext(ctx))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "missing_principal") {
		t.Fatalf("expected missing_principal envelope, got %s", rec.Body.String())
	}
}
