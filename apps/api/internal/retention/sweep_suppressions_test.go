package retention

// SUB-049 — time-bounded suppressions auto-unblock when their expiry
// fires. These tests pin the no-DB guards (table allow-list, batch-loop
// bounds) so they run everywhere, plus a DATABASE_URL-gated integration
// test that seeds an already-expired email_suppressions row and asserts
// the sweep deletes it while leaving a still-active row in place.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// TestSweepExpiredSuppressionsRejectsUnknownTable — the table name is
// interpolated into the SQL string, so a non-allow-listed name must
// error rather than execute. The guard runs BEFORE the batch loop, so
// no pool is dereferenced even with a nil Pool.
func TestSweepExpiredSuppressionsRejectsUnknownTable(t *testing.T) {
	s := &Sweeper{} // nil Pool — guard must fire first
	bad := []string{
		"users; DROP TABLE x",
		"suppressions",            // wrong table, not allow-listed
		"email_suppressions_evil", // close-but-not-equal
		"",
	}
	for _, tbl := range bad {
		if _, err := s.sweepExpiredSuppressionsTable(context.Background(), "tid", tbl); err == nil {
			t.Errorf("expected error for non-allow-listed table %q", tbl)
		}
	}
}

// TestSweepExpiredSuppressionsCtxCanceled — a cancelled context makes
// the batch loop bail on its first iteration before touching the pool,
// so the fan-out returns the context error rather than panicking on the
// nil pool. Confirms the ctx.Err() guard ordering.
func TestSweepExpiredSuppressionsCtxCanceled(t *testing.T) {
	s := &Sweeper{} // nil Pool
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.sweepExpiredSuppressions(ctx, "tid"); err == nil {
		t.Fatalf("expected context-cancelled error, got nil")
	}
}

// TestSweepExpiredSuppressionsIntegration seeds one expired and one
// still-active email_suppressions row and asserts the sweep removes only
// the expired one. Skips when DATABASE_URL is unset.
func TestSweepExpiredSuppressionsIntegration(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	// Closed via t.Cleanup, not defer: a deferred Close runs when the test
	// function returns, which is BEFORE any t.Cleanup callback, so the
	// cleanups below were all issuing queries on a closed pool and silently
	// swallowing the error — the fixture rows were never actually removed.
	// t.Cleanup is LIFO, so registering Close first makes it run last.
	t.Cleanup(pool.Close)

	// The tenant this test operates in must be created BY this test.
	// It used to hardcode 00000000-0000-0000-0000-000000000001 and seed
	// straight into email_suppressions, which only worked when some other
	// test in some other package happened to have left a tenant row with
	// that id behind. On a freshly-migrated database there is no such row
	// and email_suppressions_tenant_id_fkey rejects the seed — which is a
	// missing seed, not the schema drift the old failure message guessed at.
	tenantID := uuid.NewString()
	tag := randHexSweep(t)
	expired := "exp" + tag + "@example.com"
	active := "act" + tag + "@example.com"

	tenantTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant (tenant seed): %v", err)
	}
	if _, err := tenantTx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'suppression-sweep-test', $2, 'studio')`,
		tenantID, "suppression-sweep-"+tenantID); err != nil {
		_ = tenantTx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tenantTx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
	t.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer ccancel()
		ctx4, err := db.WithTenant(cctx, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = ctx4.Rollback(cctx) }()
		if _, err := ctx4.Exec(cctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID); err != nil {
			return
		}
		_ = ctx4.Commit(cctx)
	})

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	past := time.Now().Add(-time.Hour)
	future := time.Now().Add(time.Hour)
	if _, err := tx.Exec(ctx, `
INSERT INTO email_suppressions (tenant_id, email, reason, expires_at)
VALUES ($1::uuid, $2, 'manual', $3), ($1::uuid, $4, 'manual', $5)`,
		tenantID, expired, past, active, future); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed failed (schema drift?): %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer ccancel()
		if ctx2, _ := db.WithTenant(cctx, pool, tenantID); ctx2 != nil {
			_, _ = ctx2.Exec(cctx, `DELETE FROM email_suppressions WHERE tenant_id=$1::uuid AND email = ANY($2)`,
				tenantID, []string{expired, active})
			_ = ctx2.Commit(cctx)
		}
	})

	s := &Sweeper{Pool: pool}
	n, err := s.sweepExpiredSuppressions(ctx, tenantID)
	if err != nil {
		t.Fatalf("sweepExpiredSuppressions: %v", err)
	}
	if n < 1 {
		t.Fatalf("purged %d, want >=1 (the expired row)", n)
	}

	// The active row must survive; the expired one must be gone.
	ctx2, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant verify: %v", err)
	}
	defer func() { _ = ctx2.Rollback(ctx) }()
	var expiredCount, activeCount int
	if err := ctx2.QueryRow(ctx,
		`SELECT count(*) FROM email_suppressions WHERE tenant_id=$1::uuid AND email=$2`,
		tenantID, expired).Scan(&expiredCount); err != nil {
		t.Fatalf("count expired: %v", err)
	}
	if err := ctx2.QueryRow(ctx,
		`SELECT count(*) FROM email_suppressions WHERE tenant_id=$1::uuid AND email=$2`,
		tenantID, active).Scan(&activeCount); err != nil {
		t.Fatalf("count active: %v", err)
	}
	if expiredCount != 0 {
		t.Errorf("expired row survived (count=%d)", expiredCount)
	}
	if activeCount != 1 {
		t.Errorf("active row was deleted (count=%d)", activeCount)
	}

	// SUB-049: the auto-unblock must leave a compliance audit trail. Assert
	// the sweep wrote exactly one action='expire' suppression_audit row for
	// the expired address (source_table='email_suppressions') and none for
	// the still-active row. The actor columns stay NULL on an automated
	// sweep, so we only assert action + source_table here.
	var expireAuditCount, activeAuditCount int
	if err := ctx2.QueryRow(ctx,
		`SELECT count(*) FROM suppression_audit
		  WHERE tenant_id=$1::uuid AND email=$2::citext
		    AND action='expire' AND source_table='email_suppressions'`,
		tenantID, expired).Scan(&expireAuditCount); err != nil {
		t.Fatalf("count expire audit: %v", err)
	}
	if err := ctx2.QueryRow(ctx,
		`SELECT count(*) FROM suppression_audit
		  WHERE tenant_id=$1::uuid AND email=$2::citext AND action='expire'`,
		tenantID, active).Scan(&activeAuditCount); err != nil {
		t.Fatalf("count active audit: %v", err)
	}
	if expireAuditCount != 1 {
		t.Errorf("expire audit rows for swept address = %d, want 1", expireAuditCount)
	}
	if activeAuditCount != 0 {
		t.Errorf("expire audit row written for still-active address (count=%d)", activeAuditCount)
	}

	t.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer ccancel()
		if ctx3, _ := db.WithTenant(cctx, pool, tenantID); ctx3 != nil {
			_, _ = ctx3.Exec(cctx,
				`DELETE FROM suppression_audit WHERE tenant_id=$1::uuid AND email = ANY($2::citext[])`,
				tenantID, []string{expired, active})
			_ = ctx3.Commit(cctx)
		}
	})
}

func randHexSweep(t *testing.T) string {
	t.Helper()
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b[:])
}
