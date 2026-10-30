// SPDX-License-Identifier: AGPL-3.0-only
//
// Fake (no-DB) tests for workspace_members.go — the validation and
// authorization guards that must fire BEFORE the handler touches Pool. A nil
// Pool is the assertion mechanism: if any of these regress to run past the
// guard they pin, db.WithTenant(ctx, nil, ...) nil-panics and the test fails
// loudly instead of silently passing.
//
// DB round-trip coverage (real users rows, RLS isolation, the last-owner
// invariant) lives in workspace_members_db_test.go, guarded by DATABASE_URL.
package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/routeauth"
)

const fakeMemberID = "33333333-3333-4333-8333-333333333333"

func decodeErrorCode(t *testing.T, body []byte) string {
	t.Helper()
	var env struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("decode error envelope: %v (body %s)", err, string(body))
	}
	return env.Error.Code
}

func TestListMembers_NoTenant_401(t *testing.T) {
	h := &WorkspaceMembersHandlers{Pool: nil}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/workspace/members", nil)
	rw := httptest.NewRecorder()

	h.ListMembers(rw, req)

	if rw.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (nil Pool must never be dereferenced without a tenant)", rw.Code)
	}
}

func TestUpdateMember_NoTenant_401(t *testing.T) {
	h := &WorkspaceMembersHandlers{Pool: nil}
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/workspace/members/"+fakeMemberID,
		strings.NewReader(`{"role":"editor"}`))
	req = withChiURLParam(req, "id", fakeMemberID)
	rw := httptest.NewRecorder()

	h.UpdateMember(rw, req)

	if rw.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rw.Code)
	}
}

// TestListMembers_RejectsMalformedQueryParams pins every query-param guard.
// Each must return a specific typed code — the audit's recurring finding is a
// 500 with a bare message, so a generic failure here is the bug.
func TestListMembers_RejectsMalformedQueryParams(t *testing.T) {
	cases := []struct {
		query    string
		wantCode string
	}{
		{"?status=banana", "invalid_status"},
		{"?include_deleted=ture", "invalid_include_deleted"},
		{"?limit=0", "invalid_limit"},
		{"?limit=99999", "invalid_limit"},
		{"?limit=abc", "invalid_limit"},
		{"?offset=-1", "invalid_offset"},
	}
	for _, c := range cases {
		h := &WorkspaceMembersHandlers{Pool: nil}
		req := httptest.NewRequest(http.MethodGet, "/api/v1/workspace/members"+c.query, nil)
		req = withFakeTenant(req)
		rw := httptest.NewRecorder()

		h.ListMembers(rw, req)

		if rw.Code != http.StatusBadRequest {
			t.Errorf("%s status = %d, want 400 (body %s)", c.query, rw.Code, rw.Body.String())
			continue
		}
		if got := decodeErrorCode(t, rw.Body.Bytes()); got != c.wantCode {
			t.Errorf("%s error.code = %q, want %q", c.query, got, c.wantCode)
		}
	}
}

func TestUpdateMember_RejectsNonUUIDID(t *testing.T) {
	h := &WorkspaceMembersHandlers{Pool: nil}
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/workspace/members/not-a-uuid",
		strings.NewReader(`{"role":"editor"}`))
	req = withChiURLParam(req, "id", "not-a-uuid")
	req = withFakeTenant(req)
	rw := httptest.NewRecorder()

	h.UpdateMember(rw, req)

	if rw.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %s)", rw.Code, rw.Body.String())
	}
	if got := decodeErrorCode(t, rw.Body.Bytes()); got != "invalid_id" {
		t.Fatalf("error.code = %q, want invalid_id", got)
	}
}

// TestUpdateMember_RejectsInvalidBodies covers the four body-shape guards.
// The 'deleted' case matters most: routing hard deletion through a role PATCH
// would bypass internal/accountdeletion's grace period and erasure ledger.
func TestUpdateMember_RejectsInvalidBodies(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"empty patch", `{}`},
		{"unknown role", `{"role":"superuser"}`},
		{"blank role", `{"role":"  "}`},
		{"deleted status is not assignable here", `{"status":"deleted"}`},
		{"unknown status", `{"status":"paused"}`},
	}
	for _, c := range cases {
		h := &WorkspaceMembersHandlers{Pool: nil}
		req := httptest.NewRequest(http.MethodPatch, "/api/v1/workspace/members/"+fakeMemberID,
			strings.NewReader(c.body))
		req = withChiURLParam(req, "id", fakeMemberID)
		req = withFakeTenant(req)
		rw := httptest.NewRecorder()

		h.UpdateMember(rw, req)

		if rw.Code != http.StatusBadRequest && rw.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s: status = %d, want a 4xx validation error (body %s)", c.name, rw.Code, rw.Body.String())
			continue
		}
		if got := decodeErrorCode(t, rw.Body.Bytes()); got != "validation_failed" {
			t.Errorf("%s: error.code = %q, want validation_failed", c.name, got)
		}
	}
}

// TestUpdateMember_OnlyOwnerMayGrantOwner is the escalation guard. An
// admin-role session holds ScopeAdmin and passes the mount-site gate, so this
// is the only thing standing between admin and owner being the same tier.
// It must fire before the DB is touched — nil Pool proves it does.
func TestUpdateMember_OnlyOwnerMayGrantOwner(t *testing.T) {
	h := &WorkspaceMembersHandlers{Pool: nil}
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/workspace/members/"+fakeMemberID,
		strings.NewReader(`{"role":"owner"}`))
	req = withChiURLParam(req, "id", fakeMemberID)
	req = withFakeTenant(req)
	req = req.WithContext(middleware.WithUser(req.Context(), &middleware.User{
		ID: "44444444-4444-4444-8444-444444444444", Role: "admin",
	}))
	rw := httptest.NewRecorder()

	h.UpdateMember(rw, req)

	if rw.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (an admin must not be able to grant owner) — body %s",
			rw.Code, rw.Body.String())
	}
	if got := decodeErrorCode(t, rw.Body.Bytes()); got != "owner_role_required" {
		t.Fatalf("error.code = %q, want owner_role_required", got)
	}
}

// TestActorIsOwner_APIKeyIsNeverOwner pins the fail-closed rule that an
// API key, whatever its scopes, is not a person and therefore not an owner.
func TestActorIsOwner_APIKeyIsNeverOwner(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/workspace/members", nil)
	req = req.WithContext(middleware.WithAPIKeyAuth(req.Context()))
	req = req.WithContext(middleware.WithUser(req.Context(), &middleware.User{Role: "owner"}))

	if actorIsOwner(req) {
		t.Fatal("actorIsOwner = true for an API-key request; keys carry scopes, not personhood")
	}
	if got := callerUserID(req); got != "" {
		t.Fatalf("callerUserID = %q on the API-key path, want empty", got)
	}
}

func TestIsAssignableRoleAndStatus(t *testing.T) {
	for _, c := range []struct {
		role string
		want bool
	}{
		{"owner", true}, {"Owner", true}, {"  admin  ", true},
		{"editor", true}, {"VIEWER", true},
		{"superuser", false}, {"", false}, {"own", false},
	} {
		if got := isAssignableRole(c.role); got != c.want {
			t.Errorf("isAssignableRole(%q) = %v, want %v", c.role, got, c.want)
		}
	}
	for _, c := range []struct {
		status string
		want   bool
	}{
		{"active", true}, {"suspended", true}, {"Active", true},
		// 'deleted' is a real column value but never assignable here.
		{"deleted", false}, {"", false}, {"archived", false},
	} {
		if got := isAssignableStatus(c.status); got != c.want {
			t.Errorf("isAssignableStatus(%q) = %v, want %v", c.status, got, c.want)
		}
	}
}

func TestParseBoundedInt(t *testing.T) {
	for _, c := range []struct {
		raw     string
		want    int
		wantErr bool
	}{
		{"", 100, false},
		{"1", 1, false},
		{"500", 500, false},
		{"0", 0, true},
		{"501", 0, true},
		{"-3", 0, true},
		{"ten", 0, true},
	} {
		got, err := parseBoundedInt(c.raw, 100, 1, 500)
		if (err != nil) != c.wantErr {
			t.Errorf("parseBoundedInt(%q) err = %v, wantErr %v", c.raw, err, c.wantErr)
			continue
		}
		if err == nil && got != c.want {
			t.Errorf("parseBoundedInt(%q) = %d, want %d", c.raw, got, c.want)
		}
	}
}

// TestMountWorkspaceMembers_RegistersBothRoutes proves the verb+path contract
// main.go depends on: a 404 here would mean the surface silently does not
// exist, which is the exact failure the finding describes.
func TestMountWorkspaceMembers_RegistersBothRoutes(t *testing.T) {
	r := chi.NewRouter()
	MountWorkspaceMembers(r, &WorkspaceMembersHandlers{Pool: nil})

	srv := httptest.NewServer(r)
	defer srv.Close()

	getResp, err := http.Get(srv.URL + "/api/v1/workspace/members")
	if err != nil {
		t.Fatalf("GET /api/v1/workspace/members: %v", err)
	}
	_ = getResp.Body.Close()
	if getResp.StatusCode == http.StatusNotFound {
		t.Fatal("GET /api/v1/workspace/members not registered by MountWorkspaceMembers")
	}

	patchReq, _ := http.NewRequest(http.MethodPatch,
		srv.URL+"/api/v1/workspace/members/"+fakeMemberID, strings.NewReader(`{}`))
	patchReq.Header.Set("Content-Type", "application/json")
	patchResp, err := http.DefaultClient.Do(patchReq)
	if err != nil {
		t.Fatalf("PATCH /api/v1/workspace/members/{id}: %v", err)
	}
	_ = patchResp.Body.Close()
	if patchResp.StatusCode == http.StatusNotFound {
		t.Fatal("PATCH /api/v1/workspace/members/{id} not registered by MountWorkspaceMembers")
	}
}

// TestMountWorkspaceMembers_PassesRouteAuthValidation is the half of the
// double-enforcement contract that a hand-edited manifest.json can break: a
// route mounted behind RequireScope but missing (or mismatched in)
// manifest.json 403s at runtime in a way that reads like a bug. This catches
// it at test time rather than at boot.
func TestMountWorkspaceMembers_PassesRouteAuthValidation(t *testing.T) {
	router := chi.NewRouter()
	router.Group(func(protected chi.Router) {
		protected.Use(routeauth.Middleware)
		MountWorkspaceMembers(protected, &WorkspaceMembersHandlers{})
	})
	if err := routeauth.ValidateRouter(router); err != nil {
		t.Fatalf("workspace-member routes fail route-authz validation: %v", err)
	}
}
