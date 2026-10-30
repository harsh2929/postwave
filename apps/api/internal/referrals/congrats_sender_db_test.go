// SPDX-License-Identifier: AGPL-3.0-only
package referrals

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// newCongratsTestPool connects to DATABASE_URL or skips, matching the
// project-wide pg-backed test convention (outbound_webhooks/store_test.go).
func newCongratsTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed referrals congrats test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// TestScanDueConversionsUsesWorkerScope is the regression test for the
// 2026-06-10 desktop-audit CRITICAL: the congrats worker's cross-tenant
// conversions scan ran as a bare Pool.Query with no GUC bound, so FORCE
// RLS on referral_conversions returned zero rows forever and the worker
// never fired. It pins three things:
//
//  1. migration 0383 is applied (worker-select policy + widened
//     restrictive policy exist on referral_conversions);
//  2. scanDueConversions — which now runs under db.WithWorkerScope —
//     actually sees a seeded due conversion;
//  3. when running as an RLS-subject role, the same scan WITHOUT worker
//     scope sees nothing, proving the scope is load-bearing.
func TestScanDueConversionsUsesWorkerScope(t *testing.T) {
	pool := newCongratsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// --- 1. Migration pin -------------------------------------------------
	var hasWorkerPolicy bool
	if err := pool.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'referral_conversions'
       AND policyname = 'referral_conversions_worker_select')`).Scan(&hasWorkerPolicy); err != nil {
		t.Fatalf("inspect pg_policies (referral tables likely missing): %v", err)
	}
	if !hasWorkerPolicy {
		t.Fatal("migration 0383 not applied: referral_conversions_worker_select policy missing — the congrats worker scan will silently return zero rows")
	}
	var isolationQual string
	if err := pool.QueryRow(ctx, `
SELECT COALESCE(qual, '') FROM pg_policies
 WHERE tablename = 'referral_conversions'
   AND policyname = 'tenant_isolation'`).Scan(&isolationQual); err != nil {
		t.Fatalf("read tenant_isolation policy: %v", err)
	}
	if !strings.Contains(isolationQual, "outbox_worker") {
		t.Fatal("restrictive tenant_isolation policy on referral_conversions does not admit app.outbox_worker — it ANDs over the permissive worker policy, so the worker scan would still see zero rows (migration 0383 incomplete)")
	}

	// --- 2. Seed: tenant + one due conversion -----------------------------
	const tenantID = "00000000-0000-4000-8000-00c0a9a75de5"
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
VALUES ($1::uuid, 'congrats-scan-test', 'congrats-scan-test', 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
			_ = seedTx.Rollback(ctx)
			t.Fatalf("seed tenant (role lacks tenants INSERT; needs a pre-seeded DB): %v", err)
		}
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	var convID string
	// created_at far in the past so the ORDER BY created_at ASC LIMIT 200
	// scan reaches this row even in a dirty dev database.
	if err := tx.QueryRow(ctx, `
INSERT INTO referral_conversions
       (tenant_id, referrer_subscriber_id, referee_subscriber_id,
        fraud_score, credit_status, created_at)
VALUES ($1::uuid, 'sub-referrer', 'sub-referee', 0, 'credited',
        now() - interval '20 years')
RETURNING id::text`, tenantID).Scan(&convID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed conversion: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit conversion seed: %v", err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = tx.Rollback(ctx) }()
		_, _ = tx.Exec(ctx, `DELETE FROM referral_conversions WHERE id::text = $1`, convID)
		_ = tx.Commit(ctx)
	})

	// --- 3. Worker-scoped scan must see the row ---------------------------
	s := &CongratsSender{Pool: pool}
	rows, err := s.scanDueConversions(ctx)
	if err != nil {
		t.Fatalf("scanDueConversions: %v", err)
	}
	found := false
	for _, r := range rows {
		if r.id == convID {
			found = true
			if r.tenantID != tenantID {
				t.Errorf("tenant id = %q, want %q", r.tenantID, tenantID)
			}
			break
		}
	}
	if !found {
		t.Fatalf("scanDueConversions did not return the seeded due conversion %s (got %d rows) — worker scope / 0383 policy not effective", convID, len(rows))
	}

	// --- 4. Without worker scope the row must be invisible ----------------
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
SELECT COUNT(*) FROM referral_conversions WHERE id::text = $1`, convID).Scan(&n); err != nil {
			t.Fatalf("bare count: %v", err)
		}
		if n != 0 {
			t.Errorf("bare (no-GUC) query saw %d conversion rows, want 0 — RLS gate unexpectedly open", n)
		}
	}
}

// TestVerificationWorkerListTenantsUsesWorkerScope pins the companion
// fix: after the tenants RLS split (0333) the verification worker's
// cross-tenant enumeration also needs worker scope (1708 policy), or it
// silently sees zero tenants and never credits pending conversions —
// starving the congrats worker's credit_status='credited' filter.
func TestVerificationWorkerListTenantsUsesWorkerScope(t *testing.T) {
	pool := newCongratsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	const tenantID = "00000000-0000-4000-8000-00c0a9a75de5"
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
VALUES ($1::uuid, 'congrats-scan-test', 'congrats-scan-test', 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
			_ = seedTx.Rollback(ctx)
			t.Fatalf("seed tenant (role lacks tenants INSERT; needs a pre-seeded DB): %v", err)
		}
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}

	w := &VerificationWorker{Pool: pool}
	ids, err := w.listTenants(ctx)
	if err != nil {
		t.Fatalf("listTenants: %v", err)
	}
	for _, id := range ids {
		if id == tenantID {
			return // enumeration sees the tenant — worker scope effective
		}
	}
	t.Fatalf("listTenants did not return seeded tenant %s (got %d tenants) — worker scope not effective", tenantID, len(ids))
}
