// SPDX-License-Identifier: AGPL-3.0-only
//
// DB-backed regression for G-48 custom-role create/delete
// (audit_rbac_crud.go). Runs against a real, migrated Postgres —
// skips without DATABASE_URL, mirroring
// audit_export_worker_db_test.go / apikeycalls/repo_db_test.go.
//
// Covers the real round-trip the handler tests can't: an actual
// roles INSERT + roles_permissions grant + roles DELETE, and — the
// point of RLS on this table — that a second tenant's transaction
// can neither see nor delete the first tenant's role.
package handlers

import (
	"context"
	"crypto/rand"
	"encoding/hex"
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

func roleCRUDTestPool(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed audit-rbac-crud test")
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

func randHex(t *testing.T, n int) string {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand.Read: %v", err)
	}
	return hex.EncodeToString(b)
}

// seedRoleCRUDTenant creates a tenant row using the same self-referential
// GUC trick as internal/apikeycalls/repo_db_test.go — SET the
// app.tenant_id GUC to the id we're about to insert so the tenants-table
// RLS policy's own WITH CHECK is satisfied by the row being created. The
// returned cleanup removes roles / roles_permissions / the tenant.
func seedRoleCRUDTenant(t *testing.T, pool *db.Pool) string {
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
		id, "role-crud-test-"+randHex(t, 4), "role-crud test"); err != nil {
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
		_, _ = c.Exec(cctx, `DELETE FROM roles_permissions WHERE role_id IN (SELECT id FROM roles WHERE tenant_id = $1::uuid)`, id)
		_, _ = c.Exec(cctx, `DELETE FROM roles WHERE tenant_id = $1::uuid`, id)
		_, _ = c.Exec(cctx, `DELETE FROM tenants WHERE id = $1::uuid`, id)
	})
	return id
}

func newRoleCRUDRequest(t *testing.T, method, path, body, tenantID string) *http.Request {
	t.Helper()
	var req *http.Request
	if body != "" {
		req = httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	} else {
		req = httptest.NewRequest(method, path, nil)
	}
	tenant := &middleware.Tenant{ID: tenantID, Slug: "role-crud-test", Name: "role-crud test"}
	return req.WithContext(middleware.WithTenant(req.Context(), tenant))
}

// TestCreateDeleteRole_DBRoundTrip_RLSIsolation is the scenario the
// feature spec asks for: create a tenant, POST a custom role, grant it
// write:campaigns directly against roles_permissions, DELETE the role,
// and assert a second tenant's tx can see none of it.
func TestCreateDeleteRole_DBRoundTrip_RLSIsolation(t *testing.T) {
	pool := roleCRUDTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantA := seedRoleCRUDTenant(t, pool)
	tenantB := seedRoleCRUDTenant(t, pool)

	h := &AuditRBACHandlers{Pool: pool}

	// --- 1. POST /api/v1/roles as tenant A -------------------------------
	createReq := newRoleCRUDRequest(t, http.MethodPost, "/api/v1/roles",
		`{"name":"campaigns-only","description":"can edit campaigns, nothing else"}`,
		tenantA)
	createRW := httptest.NewRecorder()
	h.CreateRole(createRW, createReq)
	if createRW.Code != http.StatusCreated {
		t.Fatalf("CreateRole status = %d, body = %s", createRW.Code, createRW.Body.String())
	}
	var created RoleWithScopes
	if err := json.Unmarshal(createRW.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode create response: %v", err)
	}
	if created.ID == "" {
		t.Fatal("created role has empty id")
	}
	if created.Name != "campaigns-only" {
		t.Errorf("created.Name = %q, want %q", created.Name, "campaigns-only")
	}
	if len(created.AssignedScopes) != 0 {
		t.Errorf("created.AssignedScopes = %v, want empty (no scopes granted yet)", created.AssignedScopes)
	}

	// Re-posting the same name must 409, not silently create a duplicate —
	// pins the UNIQUE(tenant_id, name) constraint mapping.
	dupReq := newRoleCRUDRequest(t, http.MethodPost, "/api/v1/roles",
		`{"name":"campaigns-only"}`, tenantA)
	dupRW := httptest.NewRecorder()
	h.CreateRole(dupRW, dupReq)
	if dupRW.Code != http.StatusConflict {
		t.Errorf("duplicate-name CreateRole status = %d, want 409", dupRW.Code)
	}

	// --- 2. Grant write:campaigns directly via roles_permissions ---------
	grantTx, err := db.WithTenant(ctx, pool, tenantA)
	if err != nil {
		t.Fatalf("WithTenant(A) for grant: %v", err)
	}
	if _, err := grantTx.Exec(ctx,
		`INSERT INTO roles_permissions (role_id, scope) VALUES ($1::uuid, 'write:campaigns')`,
		created.ID,
	); err != nil {
		_ = grantTx.Rollback(ctx)
		t.Fatalf("grant write:campaigns: %v", err)
	}
	if err := grantTx.Commit(ctx); err != nil {
		t.Fatalf("commit grant: %v", err)
	}

	// Verify the grant landed and is visible to tenant A.
	verifyTx, err := db.WithTenant(ctx, pool, tenantA)
	if err != nil {
		t.Fatalf("WithTenant(A) for verify: %v", err)
	}
	var grantedScope string
	if err := verifyTx.QueryRow(ctx,
		`SELECT scope FROM roles_permissions WHERE role_id = $1::uuid`, created.ID,
	).Scan(&grantedScope); err != nil {
		t.Fatalf("read back grant: %v", err)
	}
	_ = verifyTx.Rollback(ctx)
	if grantedScope != "write:campaigns" {
		t.Fatalf("granted scope = %q, want write:campaigns", grantedScope)
	}

	// --- 3. RLS isolation: tenant B cannot see or delete tenant A's role -
	crossListTx, err := db.WithTenant(ctx, pool, tenantB)
	if err != nil {
		t.Fatalf("WithTenant(B): %v", err)
	}
	var crossVisible bool
	if err := crossListTx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM roles WHERE id = $1::uuid)`, created.ID,
	).Scan(&crossVisible); err != nil {
		_ = crossListTx.Rollback(ctx)
		t.Fatalf("cross-tenant visibility check: %v", err)
	}
	_ = crossListTx.Rollback(ctx)
	if crossVisible {
		t.Fatal("tenant B's transaction can see tenant A's role — RLS isolation broken")
	}

	crossDeleteReq := newRoleCRUDRequest(t, http.MethodDelete, "/api/v1/roles/"+created.ID, "", tenantB)
	crossDeleteReq = withChiURLParam(crossDeleteReq, "id", created.ID)
	crossDeleteRW := httptest.NewRecorder()
	h.DeleteRole(crossDeleteRW, crossDeleteReq)
	if crossDeleteRW.Code != http.StatusNotFound {
		t.Fatalf("tenant B DeleteRole(tenant A's role) status = %d, want 404 (RLS should hide the row entirely)", crossDeleteRW.Code)
	}
	// The role must still exist for tenant A after the failed cross-tenant
	// delete attempt.
	stillTx, err := db.WithTenant(ctx, pool, tenantA)
	if err != nil {
		t.Fatalf("WithTenant(A) post-cross-delete: %v", err)
	}
	var stillExists bool
	if err := stillTx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM roles WHERE id = $1::uuid)`, created.ID,
	).Scan(&stillExists); err != nil {
		_ = stillTx.Rollback(ctx)
		t.Fatalf("post-cross-delete existence check: %v", err)
	}
	_ = stillTx.Rollback(ctx)
	if !stillExists {
		t.Fatal("tenant A's role vanished after tenant B's blocked cross-tenant delete attempt")
	}

	// --- 4. Built-in roles cannot be deleted ------------------------------
	// ensureBuiltinAuditRoles is idempotent and already ran inside
	// CreateRole above, so tenant A now has an 'admin' row.
	var adminID string
	adminLookupTx, err := db.WithTenant(ctx, pool, tenantA)
	if err != nil {
		t.Fatalf("WithTenant(A) admin lookup: %v", err)
	}
	if err := adminLookupTx.QueryRow(ctx,
		`SELECT id::text FROM roles WHERE tenant_id = $1::uuid AND lower(name) = 'admin'`, tenantA,
	).Scan(&adminID); err != nil {
		_ = adminLookupTx.Rollback(ctx)
		t.Fatalf("find built-in admin role: %v", err)
	}
	_ = adminLookupTx.Rollback(ctx)

	builtinDeleteReq := newRoleCRUDRequest(t, http.MethodDelete, "/api/v1/roles/"+adminID, "", tenantA)
	builtinDeleteReq = withChiURLParam(builtinDeleteReq, "id", adminID)
	builtinDeleteRW := httptest.NewRecorder()
	h.DeleteRole(builtinDeleteRW, builtinDeleteReq)
	if builtinDeleteRW.Code != http.StatusForbidden {
		t.Fatalf("DeleteRole(built-in admin) status = %d, want 403", builtinDeleteRW.Code)
	}

	// --- 5. Tenant A deletes its own custom role --------------------------
	deleteReq := newRoleCRUDRequest(t, http.MethodDelete, "/api/v1/roles/"+created.ID, "", tenantA)
	deleteReq = withChiURLParam(deleteReq, "id", created.ID)
	deleteRW := httptest.NewRecorder()
	h.DeleteRole(deleteRW, deleteReq)
	if deleteRW.Code != http.StatusOK {
		t.Fatalf("DeleteRole status = %d, body = %s", deleteRW.Code, deleteRW.Body.String())
	}

	// The role row and its roles_permissions grant must both be gone.
	postDeleteTx, err := db.WithTenant(ctx, pool, tenantA)
	if err != nil {
		t.Fatalf("WithTenant(A) post-delete: %v", err)
	}
	var roleGone, grantGone bool
	if err := postDeleteTx.QueryRow(ctx,
		`SELECT NOT EXISTS (SELECT 1 FROM roles WHERE id = $1::uuid)`, created.ID,
	).Scan(&roleGone); err != nil {
		_ = postDeleteTx.Rollback(ctx)
		t.Fatalf("post-delete role check: %v", err)
	}
	if err := postDeleteTx.QueryRow(ctx,
		`SELECT NOT EXISTS (SELECT 1 FROM roles_permissions WHERE role_id = $1::uuid)`, created.ID,
	).Scan(&grantGone); err != nil {
		_ = postDeleteTx.Rollback(ctx)
		t.Fatalf("post-delete grant check: %v", err)
	}
	_ = postDeleteTx.Rollback(ctx)
	if !roleGone {
		t.Error("role row still present after DeleteRole")
	}
	if !grantGone {
		t.Error("roles_permissions row still present after DeleteRole (should cascade / explicit-delete)")
	}

	// Re-deleting the now-gone role must 404, not 200/500.
	redeleteReq := newRoleCRUDRequest(t, http.MethodDelete, "/api/v1/roles/"+created.ID, "", tenantA)
	redeleteReq = withChiURLParam(redeleteReq, "id", created.ID)
	redeleteRW := httptest.NewRecorder()
	h.DeleteRole(redeleteRW, redeleteReq)
	if redeleteRW.Code != http.StatusNotFound {
		t.Errorf("re-DeleteRole status = %d, want 404", redeleteRW.Code)
	}

	// --- 6. audit trail rows landed for both create and delete ------------
	auditTx, err := db.WithTenant(ctx, pool, tenantA)
	if err != nil {
		t.Fatalf("WithTenant(A) audit check: %v", err)
	}
	var createdCount, deletedCount int
	if err := auditTx.QueryRow(ctx,
		`SELECT count(*) FROM audit_log WHERE tenant_id = $1::uuid AND action = 'audit.rbac.role_created' AND resource_id = $2`,
		tenantA, created.ID,
	).Scan(&createdCount); err != nil {
		_ = auditTx.Rollback(ctx)
		t.Fatalf("audit_log role_created check: %v", err)
	}
	if err := auditTx.QueryRow(ctx,
		`SELECT count(*) FROM audit_log WHERE tenant_id = $1::uuid AND action = 'audit.rbac.role_deleted' AND resource_id = $2`,
		tenantA, created.ID,
	).Scan(&deletedCount); err != nil {
		_ = auditTx.Rollback(ctx)
		t.Fatalf("audit_log role_deleted check: %v", err)
	}
	_ = auditTx.Rollback(ctx)
	if createdCount == 0 {
		t.Error("no audit.rbac.role_created row found")
	}
	if deletedCount == 0 {
		t.Error("no audit.rbac.role_deleted row found")
	}
}
