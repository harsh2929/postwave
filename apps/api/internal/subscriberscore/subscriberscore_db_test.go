// SPDX-License-Identifier: AGPL-3.0-only
//
// DB-backed regression for Finding 2 (2026-06 backend audit): the
// churn scorer's listTenants used a bare Pool.Acquire +
// set_config('app.outbox_worker','true', true) OUTSIDE an explicit
// transaction. With is_local=TRUE the GUC is scoped to the current
// transaction, so on a bare pooled conn (each statement its own
// implicit tx) it reset before the follow-up SELECT on tenants —
// which is FORCE RLS behind tenant_worker_select (migration 1708).
// The scan saw zero tenants and the scorer silently scored nothing
// every tick. The fix routes listTenants through db.WithWorkerScope.
//
// Skip without DATABASE_URL (project-wide pg-backed convention,
// mirrors referrals/congrats_sender_db_test.go).
package subscriberscore

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func scorerDB(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed churn-scorer test")
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

// TestListTenantsUsesWorkerScope pins three things:
//
//  1. migration 1708 is applied (tenant_worker_select policy on tenants);
//  2. listTenants — now under db.WithWorkerScope — sees a seeded tenant;
//  3. when running as an RLS-subject role, the same enumeration WITHOUT
//     worker scope sees nothing, proving the scope is load-bearing.
func TestListTenantsUsesWorkerScope(t *testing.T) {
	pool := scorerDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// --- 1. Migration pin -------------------------------------------------
	var hasWorkerPolicy bool
	if err := pool.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'tenants'
       AND policyname = 'tenant_worker_select')`).Scan(&hasWorkerPolicy); err != nil {
		t.Fatalf("inspect pg_policies: %v", err)
	}
	if !hasWorkerPolicy {
		t.Fatal("migration 1708 not applied: tenant_worker_select policy missing — listTenants will silently return zero tenants")
	}

	// --- 2. Seed: one tenant under worker scope ---------------------------
	const tenantID = "00000000-0000-4000-8000-00d0b1c86ef0"
	seedTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("worker scope for seeding: %v", err)
	}
	var tenantExists bool
	if err := seedTx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM tenants WHERE id = $1::uuid)`,
		tenantID).Scan(&tenantExists); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("read tenants: %v", err)
	}
	if !tenantExists {
		if _, err := seedTx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'churn-scorer-test', 'churn-scorer-test', 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
			_ = seedTx.Rollback(ctx)
			t.Fatalf("seed tenant (role lacks tenants INSERT; needs a pre-seeded DB): %v", err)
		}
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}

	// --- 3. Worker-scoped enumeration must see the tenant -----------------
	s := &Scorer{Pool: pool}
	ids, err := s.listTenants(ctx)
	if err != nil {
		t.Fatalf("listTenants: %v", err)
	}
	found := false
	for _, id := range ids {
		if id == tenantID {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("listTenants did not return seeded tenant %s (got %d tenants) — worker scope / 1708 policy not effective", tenantID, len(ids))
	}

	// --- 4. Without worker scope the tenant must be invisible -------------
	// Only meaningful when the connected role is actually subject to RLS
	// (local superusers bypass it wholesale).
	var privileged bool
	if err := pool.QueryRow(ctx, `
SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user`).Scan(&privileged); err != nil {
		t.Fatalf("inspect role: %v", err)
	}
	if !privileged {
		var n int
		if err := pool.QueryRow(ctx, `
SELECT COUNT(*) FROM tenants WHERE id = $1::uuid`, tenantID).Scan(&n); err != nil {
			t.Fatalf("bare count: %v", err)
		}
		if n != 0 {
			t.Errorf("bare (no-GUC) query saw %d tenant rows, want 0 — RLS gate unexpectedly open", n)
		}
	}
}
