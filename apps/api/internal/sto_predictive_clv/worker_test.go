// SPDX-License-Identifier: AGPL-3.0-only
package sto_predictive_clv

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// TestWorkerRun_NoSeamIsNoOp: without a Recompute seam wired, Run() is the
// historical no-op (and must not touch the DB — a nil Pool here would panic
// if it tried).
func TestWorkerRun_NoSeamIsNoOp(t *testing.T) {
	w := &Worker{Pool: nil}
	if err := w.Run(context.Background()); err != nil {
		t.Fatalf("nil-pool Run should be a no-op, got %v", err)
	}
	// A non-nil pool but nil seam must also short-circuit before enumerating.
	w2 := &Worker{Pool: &db.Pool{}}
	if err := w2.Run(context.Background()); err != nil {
		t.Fatalf("nil-seam Run should be a no-op, got %v", err)
	}
}

// TestWorkerRun_EnumeratesAndContinuesPastErrors runs against a real migrated
// DB: it seeds two tenants, runs the worker with a seam that records the
// tenants it was called for and errors on one of them, and asserts both seeded
// tenants were recomputed and the error on one did not stop the other.
func TestWorkerRun_EnumeratesAndContinuesPastErrors(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping DB-backed worker test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	tenantA := seedTenant(t, pool)
	tenantB := seedTenant(t, pool)

	called := map[string]int{}
	w := &Worker{
		Pool:   pool,
		Logger: nil,
		Recompute: func(_ context.Context, tenantID string) error {
			called[tenantID]++
			if tenantID == tenantB {
				return errors.New("boom") // one bad tenant must not halt the pass
			}
			return nil
		},
	}
	if err := w.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}

	if called[tenantA] != 1 {
		t.Errorf("tenant A recomputed %d times, want 1", called[tenantA])
	}
	if called[tenantB] != 1 {
		t.Errorf("tenant B recomputed %d times, want 1 (error must not skip it)", called[tenantB])
	}
}

// seedTenant inserts a throwaway tenant via the self-referential GUC trick
// (SET app.tenant_id to the id being inserted so the tenants-RLS WITH CHECK
// passes) and registers cleanup.
func seedTenant(t *testing.T, pool *db.Pool) string {
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
VALUES ($1::uuid, $2, $3, 'pro')`, id, "clv-worker-"+id[:8], "clv worker test"); err != nil {
		t.Fatalf("seed tenant (role lacks tenants INSERT?): %v", err)
	}
	t.Cleanup(func() {
		c, err := pool.Acquire(context.Background())
		if err != nil {
			return
		}
		defer c.Release()
		_, _ = c.Exec(context.Background(), `SELECT set_config('app.tenant_id', $1, false)`, id)
		_, _ = c.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1::uuid`, id)
	})
	return id
}
