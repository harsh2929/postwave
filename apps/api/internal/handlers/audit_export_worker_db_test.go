// SPDX-License-Identifier: AGPL-3.0-only
//
// DB-backed regression for Finding 1 (2026-06 backend audit): the
// audit-export worker's claim/heartbeat/complete/fail ran on a bare
// Pool.Acquire'd conn with NO worker-scope GUC. audit_export_jobs is
// ENABLE+FORCE RLS and migration 0390 gates the cross-tenant claim
// UPDATE behind app.outbox_worker (worker_all + the widened
// tenant_isolation OR in USING and WITH CHECK). Without that GUC the
// pending → in_progress UPDATE matched zero rows and the old error
// path (`if err != nil { return nil }`) swallowed both pgx.ErrNoRows
// AND real errors, so the worker silently drained nothing forever.
// The fix wraps each op in db.WithWorkerScope and distinguishes
// pgx.ErrNoRows from real errors.
//
// Skip without DATABASE_URL (mirrors referrals/congrats_sender_db_test.go).
package handlers

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func auditExportDB(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed audit-export worker test")
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

// TestExportWorkerClaimUsesWorkerScope pins:
//
//  1. migration 0390 is applied (worker_all policy on audit_export_jobs
//     + outbox_worker admitted by the restrictive tenant_isolation);
//  2. a seeded 'pending' job is invisible to a bare (no-GUC) conn — the
//     RLS gate the bug bypassed;
//  3. the worker's tick (now db.WithWorkerScope) claims that pending job
//     and drives it to a terminal 'completed' status.
func TestExportWorkerClaimUsesWorkerScope(t *testing.T) {
	pool := auditExportDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// --- 1. Migration pin -------------------------------------------------
	var hasWorkerPolicy bool
	if err := pool.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'audit_export_jobs'
       AND policyname = 'worker_all')`).Scan(&hasWorkerPolicy); err != nil {
		t.Fatalf("inspect pg_policies (audit_export_jobs likely missing): %v", err)
	}
	if !hasWorkerPolicy {
		t.Fatal("migration 0390 not applied: worker_all policy on audit_export_jobs missing — the export worker claim will silently match zero rows")
	}
	var isolationQual string
	if err := pool.QueryRow(ctx, `
SELECT COALESCE(qual, '') FROM pg_policies
 WHERE tablename = 'audit_export_jobs'
   AND policyname = 'tenant_isolation'`).Scan(&isolationQual); err != nil {
		t.Fatalf("read tenant_isolation policy: %v", err)
	}
	if !strings.Contains(isolationQual, "outbox_worker") {
		t.Fatal("restrictive tenant_isolation on audit_export_jobs does not admit app.outbox_worker — it ANDs over the permissive worker_all policy, so the claim would still see zero rows (migration 0390 incomplete)")
	}

	// --- 2. Seed: tenant + one pending export job -------------------------
	const tenantID = "00000000-0000-4000-8000-00e1c2d97f01"
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
VALUES ($1::uuid, 'audit-export-test', 'audit-export-test', 'studio')
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
	var jobID string
	if err := tx.QueryRow(ctx, `
INSERT INTO audit_export_jobs (tenant_id, filters_json, status)
VALUES ($1::uuid, '{}'::jsonb, 'pending')
RETURNING id::text`, tenantID).Scan(&jobID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed pending job: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit job seed: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		ct, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = ct.Rollback(ctx) }()
		_, _ = ct.Exec(ctx, `DELETE FROM audit_export_jobs WHERE id = $1::uuid`, jobID)
		_ = ct.Commit(ctx)
	})

	// --- 3. A bare (no-GUC) conn must NOT see the pending job -------------
	var privileged bool
	if err := pool.QueryRow(ctx, `
SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user`).Scan(&privileged); err != nil {
		t.Fatalf("inspect role: %v", err)
	}
	if !privileged {
		var n int
		if err := pool.QueryRow(ctx, `
SELECT COUNT(*) FROM audit_export_jobs WHERE id = $1::uuid`, jobID).Scan(&n); err != nil {
			t.Fatalf("bare count: %v", err)
		}
		if n != 0 {
			t.Errorf("bare (no-GUC) query saw %d export-job rows, want 0 — RLS gate unexpectedly open", n)
		}
	}

	// --- 4. The worker tick must claim + complete the job ----------------
	w := &AuditExportWorker{
		Pool:           pool,
		Interval:       time.Second,
		OutputDir:      t.TempDir(),
		FlushEveryRows: 500,
	}
	if err := w.tick(ctx); err != nil {
		t.Fatalf("tick: %v — the claim under worker scope should succeed", err)
	}

	// Job must have advanced past 'pending' to a terminal status. Read
	// back under worker scope (the worker's own view).
	verifyTx, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		t.Fatalf("verify worker scope: %v", err)
	}
	defer func() { _ = verifyTx.Rollback(ctx) }()
	var status string
	if err := verifyTx.QueryRow(ctx,
		`SELECT status FROM audit_export_jobs WHERE id = $1::uuid`, jobID).Scan(&status); err != nil {
		t.Fatalf("read back job status: %v", err)
	}
	if status != "completed" {
		t.Fatalf("job status = %q after tick, want 'completed' — the worker either failed to claim (0390 gate) or failed to mark completed", status)
	}
}
