// SPDX-License-Identifier: AGPL-3.0-only
//
// DB-backed regression for SHELL#14 (workspace_members.go). Runs against a
// real, migrated Postgres as the non-privileged postwave_app role, so the
// users-table RLS policy from migration 0001 is genuinely exercised — the
// cross-tenant assertions below are meaningless otherwise. Skips without
// DATABASE_URL, mirroring audit_rbac_crud_db_test.go.
//
// Covers what the fake tests cannot:
//   - the roster actually reads users and derives effectiveScopes from
//     roles_permissions;
//   - tenant B cannot see or PATCH tenant A's members;
//   - the last-active-owner invariant holds against both a role demotion and
//     a suspension, and releases once a second owner exists;
//   - a successful PATCH writes its audit_log row in the same transaction.
package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func memberTestPool(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed workspace-members test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// seedMemberTenant creates a tenant using the same self-referential GUC trick
// as seedRoleCRUDTenant: SET app.tenant_id to the id being inserted so the
// tenants-table RLS WITH CHECK is satisfied by the row itself.
func seedMemberTenant(t *testing.T, pool *db.Pool) string {
	t.Helper()
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer conn.Release()

	var id string
	if err := conn.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&id); err != nil {
		t.Fatalf("gen uuid: %v", err)
	}
	if _, err := conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, id); err != nil {
		t.Fatalf("set guc: %v", err)
	}
	if _, err := conn.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $3, 'pro')`,
		id, "members-test-"+randHex(t, 4), "members test"); err != nil {
		t.Fatalf("seed tenant (role lacks tenants INSERT; needs a pre-seeded DB): %v", err)
	}

	t.Cleanup(func() {
		cctx := context.Background()
		c, err := pool.Acquire(cctx)
		if err != nil {
			return
		}
		defer c.Release()
		_, _ = c.Exec(cctx, `SELECT set_config('app.tenant_id', $1, false)`, id)
		_, _ = c.Exec(cctx, `DELETE FROM audit_log WHERE tenant_id = $1::uuid`, id)
		_, _ = c.Exec(cctx, `DELETE FROM users WHERE tenant_id = $1::uuid`, id)
		_, _ = c.Exec(cctx, `DELETE FROM roles_permissions WHERE role_id IN (SELECT id FROM roles WHERE tenant_id = $1::uuid)`, id)
		_, _ = c.Exec(cctx, `DELETE FROM roles WHERE tenant_id = $1::uuid`, id)
		_, _ = c.Exec(cctx, `DELETE FROM tenants WHERE id = $1::uuid`, id)
	})
	return id
}

// seedMember inserts one user under the tenant through db.WithTenant so the
// RLS policy applies to the seed exactly as it does in production.
func seedMember(t *testing.T, pool *db.Pool, tenantID, email, role string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO users (tenant_id, email, role)
VALUES ($1::uuid, $2, $3)
RETURNING id::text`, tenantID, email, role).Scan(&id); err != nil {
		t.Fatalf("seed user %s: %v", email, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit user %s: %v", email, err)
	}
	return id
}

// newMemberRequest builds a request carrying tenant context and, when
// actorRole is non-empty, a session user with that durable role.
func newMemberRequest(t *testing.T, method, path, body, tenantID, actorID, actorRole string) *http.Request {
	t.Helper()
	var req *http.Request
	if body != "" {
		req = httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	} else {
		req = httptest.NewRequest(method, path, nil)
	}
	req = req.WithContext(middleware.WithTenant(req.Context(),
		&middleware.Tenant{ID: tenantID, Slug: "members-test", Name: "members test"}))
	if actorRole != "" {
		req = req.WithContext(middleware.WithUser(req.Context(),
			&middleware.User{ID: actorID, TenantID: tenantID, Role: actorRole, Email: "actor@example.test"}))
	}
	return req
}

type memberListResponse struct {
	Members []WorkspaceMember `json:"members"`
	Total   int64             `json:"total"`
	Limit   int               `json:"limit"`
	Offset  int               `json:"offset"`
}

func decodeMemberList(t *testing.T, rw *httptest.ResponseRecorder) memberListResponse {
	t.Helper()
	if rw.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rw.Code, rw.Body.String())
	}
	var out memberListResponse
	if err := json.Unmarshal(rw.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode list: %v (body %s)", err, rw.Body.String())
	}
	return out
}

// TestListMembers_DBRoundTripAndTenantIsolation is the core of the finding:
// "who is in this workspace and what can they do" must be answerable, and
// must not answer it for somebody else's workspace.
func TestListMembers_DBRoundTripAndTenantIsolation(t *testing.T) {
	pool := memberTestPool(t)
	tenantA := seedMemberTenant(t, pool)
	tenantB := seedMemberTenant(t, pool)

	ownerA := seedMember(t, pool, tenantA, "owner-"+randHex(t, 3)+"@a.test", "owner")
	seedMember(t, pool, tenantA, "editor-"+randHex(t, 3)+"@a.test", "editor")
	seedMember(t, pool, tenantB, "owner-"+randHex(t, 3)+"@b.test", "owner")

	h := &WorkspaceMembersHandlers{Pool: pool}

	rw := httptest.NewRecorder()
	h.ListMembers(rw, newMemberRequest(t, http.MethodGet, "/api/v1/workspace/members", "",
		tenantA, ownerA, "owner"))
	list := decodeMemberList(t, rw)

	if list.Total != 2 {
		t.Fatalf("tenant A total = %d, want 2 (body %s)", list.Total, rw.Body.String())
	}
	if len(list.Members) != 2 {
		t.Fatalf("tenant A members = %d, want 2", len(list.Members))
	}
	// Ordered owner-first, so index 0 is the owner and it is the caller.
	if list.Members[0].Role != "owner" {
		t.Fatalf("first member role = %q, want owner (roster must sort by tier)", list.Members[0].Role)
	}
	if !list.Members[0].IsSelf {
		t.Fatal("the calling owner's row is not flagged isSelf")
	}
	if list.Members[1].IsSelf {
		t.Fatal("a different member's row is flagged isSelf")
	}
	// effectiveScopes is the "what can they do" half of the finding. The
	// owner built-in is seeded with the full audit scope set, so an empty
	// slice here means the derivation is broken.
	if len(list.Members[0].EffectiveScopes) == 0 {
		t.Fatalf("owner effectiveScopes is empty; the roles_permissions join produced nothing")
	}
	for _, m := range list.Members {
		if m.EffectiveScopes == nil {
			t.Fatalf("member %s effectiveScopes is nil, want at least an empty slice", m.Email)
		}
		if strings.HasSuffix(m.Email, "@b.test") {
			t.Fatalf("tenant B member %s leaked into tenant A's roster", m.Email)
		}
	}

	// Tenant B sees only its own single member.
	rwB := httptest.NewRecorder()
	h.ListMembers(rwB, newMemberRequest(t, http.MethodGet, "/api/v1/workspace/members", "",
		tenantB, "", "owner"))
	listB := decodeMemberList(t, rwB)
	if listB.Total != 1 {
		t.Fatalf("tenant B total = %d, want 1", listB.Total)
	}
	if strings.HasSuffix(listB.Members[0].Email, "@a.test") {
		t.Fatalf("tenant A member %s leaked into tenant B's roster", listB.Members[0].Email)
	}
}

// TestUpdateMember_CrossTenantIsA404 — RLS makes another tenant's member id
// match no rows, and the handler must report that as not-found rather than
// leaking existence or 500ing on the empty scan.
func TestUpdateMember_CrossTenantIsA404(t *testing.T) {
	pool := memberTestPool(t)
	tenantA := seedMemberTenant(t, pool)
	tenantB := seedMemberTenant(t, pool)
	victim := seedMember(t, pool, tenantA, "victim-"+randHex(t, 3)+"@a.test", "editor")
	seedMember(t, pool, tenantB, "owner-"+randHex(t, 3)+"@b.test", "owner")

	h := &WorkspaceMembersHandlers{Pool: pool}
	req := newMemberRequest(t, http.MethodPatch, "/api/v1/workspace/members/"+victim,
		`{"role":"admin"}`, tenantB, "", "owner")
	req = withChiURLParam(req, "id", victim)
	rw := httptest.NewRecorder()

	h.UpdateMember(rw, req)

	if rw.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (body %s)", rw.Code, rw.Body.String())
	}
	if got := decodeErrorCode(t, rw.Body.Bytes()); got != "member_not_found" {
		t.Fatalf("error.code = %q, want member_not_found", got)
	}

	// And the row is genuinely untouched.
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantA)
	if err != nil {
		t.Fatalf("verify tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var role string
	if err := tx.QueryRow(ctx, `SELECT role FROM users WHERE id = $1::uuid`, victim).Scan(&role); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if role != "editor" {
		t.Fatalf("victim role = %q after cross-tenant PATCH, want editor", role)
	}
}

// TestUpdateMember_LastOwnerInvariant is the guard that keeps a workspace
// recoverable. Demoting or suspending the final active owner must 409; once a
// second owner exists both operations must succeed.
func TestUpdateMember_LastOwnerInvariant(t *testing.T) {
	pool := memberTestPool(t)
	tenant := seedMemberTenant(t, pool)
	owner := seedMember(t, pool, tenant, "owner-"+randHex(t, 3)+"@x.test", "owner")
	editor := seedMember(t, pool, tenant, "editor-"+randHex(t, 3)+"@x.test", "editor")

	h := &WorkspaceMembersHandlers{Pool: pool}

	patch := func(target, body string) *httptest.ResponseRecorder {
		req := newMemberRequest(t, http.MethodPatch, "/api/v1/workspace/members/"+target,
			body, tenant, owner, "owner")
		req = withChiURLParam(req, "id", target)
		rw := httptest.NewRecorder()
		h.UpdateMember(rw, req)
		return rw
	}

	for _, body := range []string{`{"role":"admin"}`, `{"status":"suspended"}`} {
		rw := patch(owner, body)
		if rw.Code != http.StatusConflict {
			t.Fatalf("PATCH last owner %s: status = %d, want 409 (body %s)", body, rw.Code, rw.Body.String())
		}
		if got := decodeErrorCode(t, rw.Body.Bytes()); got != "last_owner" {
			t.Fatalf("PATCH last owner %s: error.code = %q, want last_owner", body, got)
		}
	}

	// Promote the editor to owner, then the original owner may step down.
	if rw := patch(editor, `{"role":"owner"}`); rw.Code != http.StatusOK {
		t.Fatalf("promote editor to owner: status = %d (body %s)", rw.Code, rw.Body.String())
	}
	rw := patch(owner, `{"role":"admin"}`)
	if rw.Code != http.StatusOK {
		t.Fatalf("demote former owner: status = %d, want 200 (body %s)", rw.Code, rw.Body.String())
	}
	var out struct {
		Member WorkspaceMember `json:"member"`
	}
	if err := json.Unmarshal(rw.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode patch response: %v", err)
	}
	if out.Member.Role != "admin" {
		t.Fatalf("member role = %q after demotion, want admin", out.Member.Role)
	}
	if out.Member.EffectiveScopes == nil {
		t.Fatal("patched member effectiveScopes is nil, want the admin role's grant set")
	}

	// The mutation must have left an audit trail in the same tx.
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenant)
	if err != nil {
		t.Fatalf("audit verify tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var audits int64
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM audit_log
 WHERE tenant_id = $1::uuid
   AND action = 'workspace.member_updated'
   AND resource_id = $2`, tenant, owner).Scan(&audits); err != nil {
		t.Fatalf("count audit rows: %v", err)
	}
	if audits == 0 {
		t.Fatal("no workspace.member_updated audit row for the demotion")
	}
}

// TestUpdateMember_AdminCannotModifyAnOwner pins invariant 3 against the real
// table: the target's CURRENT role is only known after the DB read, so unlike
// the grant-owner guard this one cannot be tested without Postgres.
func TestUpdateMember_AdminCannotModifyAnOwner(t *testing.T) {
	pool := memberTestPool(t)
	tenant := seedMemberTenant(t, pool)
	owner := seedMember(t, pool, tenant, "owner-"+randHex(t, 3)+"@y.test", "owner")
	admin := seedMember(t, pool, tenant, "admin-"+randHex(t, 3)+"@y.test", "admin")

	h := &WorkspaceMembersHandlers{Pool: pool}
	req := newMemberRequest(t, http.MethodPatch, "/api/v1/workspace/members/"+owner,
		`{"status":"suspended"}`, tenant, admin, "admin")
	req = withChiURLParam(req, "id", owner)
	rw := httptest.NewRecorder()

	h.UpdateMember(rw, req)

	if rw.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (an admin must not suspend an owner) — body %s",
			rw.Code, rw.Body.String())
	}
	if got := decodeErrorCode(t, rw.Body.Bytes()); got != "owner_role_required" {
		t.Fatalf("error.code = %q, want owner_role_required", got)
	}
}

// TestListMembers_HidesSoftDeletedUnlessAsked pins the default-visibility
// choice: the roster answers "who has access now", and include_deleted=true
// is the escape hatch for an access audit reconciling a historical actor id.
func TestListMembers_HidesSoftDeletedUnlessAsked(t *testing.T) {
	pool := memberTestPool(t)
	tenant := seedMemberTenant(t, pool)
	owner := seedMember(t, pool, tenant, "owner-"+randHex(t, 3)+"@z.test", "owner")
	gone := seedMember(t, pool, tenant, "gone-"+randHex(t, 3)+"@z.test", "viewer")

	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenant)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE users SET status = 'deleted' WHERE id = $1::uuid`, gone); err != nil {
		t.Fatalf("soft-delete: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit soft-delete: %v", err)
	}

	h := &WorkspaceMembersHandlers{Pool: pool}

	rw := httptest.NewRecorder()
	h.ListMembers(rw, newMemberRequest(t, http.MethodGet, "/api/v1/workspace/members", "",
		tenant, owner, "owner"))
	if got := decodeMemberList(t, rw).Total; got != 1 {
		t.Fatalf("default total = %d, want 1 (soft-deleted member must be hidden)", got)
	}

	rw = httptest.NewRecorder()
	h.ListMembers(rw, newMemberRequest(t, http.MethodGet,
		"/api/v1/workspace/members?include_deleted=true", "", tenant, owner, "owner"))
	if got := decodeMemberList(t, rw).Total; got != 2 {
		t.Fatalf("include_deleted total = %d, want 2", got)
	}

	// status=deleted must imply include_deleted; otherwise the two filters
	// contradict and the endpoint returns a silently empty list.
	rw = httptest.NewRecorder()
	h.ListMembers(rw, newMemberRequest(t, http.MethodGet,
		"/api/v1/workspace/members?status=deleted", "", tenant, owner, "owner"))
	deletedOnly := decodeMemberList(t, rw)
	if deletedOnly.Total != 1 {
		t.Fatalf("status=deleted total = %d, want 1 (the filter must not fight include_deleted)", deletedOnly.Total)
	}
	if len(deletedOnly.Members) != 1 || deletedOnly.Members[0].ID != gone {
		t.Fatalf("status=deleted returned %+v, want only the soft-deleted member", deletedOnly.Members)
	}

	// And a soft-deleted member cannot be resurrected through this surface —
	// that would bypass the account-deletion flow's grace period.
	req := newMemberRequest(t, http.MethodPatch, "/api/v1/workspace/members/"+gone,
		`{"status":"active"}`, tenant, owner, "owner")
	req = withChiURLParam(req, "id", gone)
	patchRW := httptest.NewRecorder()
	h.UpdateMember(patchRW, req)
	if patchRW.Code != http.StatusConflict {
		t.Fatalf("reactivate deleted member: status = %d, want 409 (body %s)",
			patchRW.Code, patchRW.Body.String())
	}
	if got := decodeErrorCode(t, patchRW.Body.Bytes()); got != "member_deleted" {
		t.Fatalf("reactivate deleted member: error.code = %q, want member_deleted", got)
	}
}
