// SPDX-License-Identifier: AGPL-3.0-only
//
// Fake (no-DB) tests for audit_rbac_crud.go. These exercise the parts of
// CreateRole/DeleteRole that run BEFORE the handler ever touches Pool
// (tenant-context check, body validation, built-in-name rejection), so a
// nil Pool is a safe fake — if any of these assertions regress to run
// past the guard they intend to test, the nil-pointer panic on
// db.WithTenant(ctx, nil, ...) will fail the test loudly rather than
// silently passing.
//
// DB round-trip coverage (real INSERT/DELETE/RLS) lives in
// audit_rbac_crud_db_test.go, guarded by DATABASE_URL.
package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/routeauth"
)

func TestIsBuiltinRoleName(t *testing.T) {
	cases := []struct {
		name string
		want bool
	}{
		{"owner", true},
		{"Owner", true},
		{"ADMIN", true},
		{"editor", true},
		{"Viewer", true},
		{"  admin  ", true}, // trimmed before compare
		{"campaigns-only", false},
		{"", false},
		{"administrator", false}, // must not substring-match "admin"
	}
	for _, c := range cases {
		if got := isBuiltinRoleName(c.name); got != c.want {
			t.Errorf("isBuiltinRoleName(%q) = %v, want %v", c.name, got, c.want)
		}
	}
}

// noTenantContext is a bare context — TenantFromContext returns ok=false,
// so both handlers must 401 before ever dereferencing h.Pool.
func TestCreateRole_NoTenant_401(t *testing.T) {
	h := &AuditRBACHandlers{Pool: nil}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/roles",
		strings.NewReader(`{"name":"campaigns-only"}`))
	req.Header.Set("Content-Type", "application/json")
	rw := httptest.NewRecorder()

	h.CreateRole(rw, req)

	if rw.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (nil Pool must never be dereferenced without a tenant)", rw.Code)
	}
}

func TestDeleteRole_NoTenant_401(t *testing.T) {
	h := &AuditRBACHandlers{Pool: nil}
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/roles/x", nil)
	req = withChiURLParam(req, "id", "11111111-1111-4111-8111-111111111111")
	rw := httptest.NewRecorder()

	h.DeleteRole(rw, req)

	if rw.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rw.Code)
	}
}

// withChiURLParam wires a chi route context carrying a single URL param,
// the way the real router would, without spinning up a full chi.Mux.
// Shared by the fake tests above and the DB-backed tests in
// audit_rbac_crud_db_test.go.
func withChiURLParam(req *http.Request, key, value string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add(key, value)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
}

func withFakeTenant(req *http.Request) *http.Request {
	req.Header.Set("Content-Type", "application/json")
	tenant := &middleware.Tenant{ID: "22222222-2222-4222-8222-222222222222", Slug: "fake-co", Name: "Fake Co"}
	return req.WithContext(middleware.WithTenant(req.Context(), tenant))
}

// TestCreateRole_EmptyName_ValidationError pins the empty-name guard,
// which must fire (400) before any Pool access.
func TestCreateRole_EmptyName_ValidationError(t *testing.T) {
	h := &AuditRBACHandlers{Pool: nil}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/roles",
		strings.NewReader(`{"name":"  ","description":"x"}`))
	req = withFakeTenant(req)
	rw := httptest.NewRecorder()

	h.CreateRole(rw, req)

	if rw.Code != http.StatusBadRequest && rw.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want a 4xx validation error for an empty name", rw.Code)
	}
}

// TestCreateRole_TooLongName_ValidationError pins the length guard.
func TestCreateRole_TooLongName_ValidationError(t *testing.T) {
	h := &AuditRBACHandlers{Pool: nil}
	body, _ := json.Marshal(map[string]string{"name": strings.Repeat("x", roleNameMaxLen+1)})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/roles", strings.NewReader(string(body)))
	req = withFakeTenant(req)
	rw := httptest.NewRecorder()

	h.CreateRole(rw, req)

	if rw.Code != http.StatusBadRequest && rw.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want a 4xx validation error for an over-long name", rw.Code)
	}
}

// TestCreateRole_BuiltinNameCollision_409 pins the case-insensitive
// built-in-name rejection — the handler must reject and return BEFORE
// ever calling db.WithTenant(ctx, h.Pool, ...), which would nil-panic
// against the fake's nil Pool. That the test doesn't panic is itself
// part of the assertion.
func TestCreateRole_BuiltinNameCollision_409(t *testing.T) {
	h := &AuditRBACHandlers{Pool: nil}
	for _, name := range []string{"admin", "Owner", "EDITOR", "viewer"} {
		body, _ := json.Marshal(map[string]string{"name": name})
		req := httptest.NewRequest(http.MethodPost, "/api/v1/roles", strings.NewReader(string(body)))
		req = withFakeTenant(req)
		rw := httptest.NewRecorder()

		h.CreateRole(rw, req)

		if rw.Code != http.StatusConflict {
			t.Errorf("CreateRole(name=%q) status = %d, want 409 (built-in name collision) — got body %s",
				name, rw.Code, rw.Body.String())
		}
	}
}

// TestMountRoleCRUD_RegistersBothRoutes exercises the routing wiring
// itself (no DB access — both handlers 401 immediately on a route with
// no tenant middleware ahead of them), pinning the verb+path contract
// callers (main.go / audit_operations.go) depend on.
func TestMountRoleCRUD_RegistersBothRoutes(t *testing.T) {
	h := &AuditRBACHandlers{Pool: nil}
	r := chi.NewRouter()
	// RequireScope reads apikeys.ScopesFromContext; with no scopes
	// attached it 403s before reaching the handler, which is still
	// sufficient to prove the routes are mounted (a 404 would mean
	// MountRoleCRUD failed to register the route at all).
	MountRoleCRUD(r, h)

	srv := httptest.NewServer(r)
	defer srv.Close()

	postResp, err := http.Post(srv.URL+"/api/v1/roles", "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatalf("POST /api/v1/roles: %v", err)
	}
	_ = postResp.Body.Close()
	if postResp.StatusCode == http.StatusNotFound {
		t.Fatal("POST /api/v1/roles not registered by MountRoleCRUD")
	}

	delReq, _ := http.NewRequest(http.MethodDelete, srv.URL+"/api/v1/roles/some-id", nil)
	delResp, err := http.DefaultClient.Do(delReq)
	if err != nil {
		t.Fatalf("DELETE /api/v1/roles/{id}: %v", err)
	}
	_ = delResp.Body.Close()
	if delResp.StatusCode == http.StatusNotFound {
		t.Fatal("DELETE /api/v1/roles/{id} not registered by MountRoleCRUD")
	}
}

// TestMountRoleCRUD_PassesRouteAuthValidation checks that the POST
// /api/v1/roles and DELETE /api/v1/roles/{id} routes each resolve to an
// exact route-authz manifest policy and sit behind routeauth.Middleware —
// the forward half of the contract ValidateRouterExact enforces at
// production startup. Unlike TestMountRoleCRUD_RegistersBothRoutes (which
// only proves the routes aren't 404), this catches a missing or mismatched
// manifest.json entry at test time rather than at boot.
func TestMountRoleCRUD_PassesRouteAuthValidation(t *testing.T) {
	router := chi.NewRouter()
	router.Group(func(protected chi.Router) {
		protected.Use(routeauth.Middleware)
		MountRoleCRUD(protected, &AuditRBACHandlers{})
	})
	if err := routeauth.ValidateRouter(router); err != nil {
		t.Fatalf("role CRUD routes fail route-authz validation: %v", err)
	}
}
