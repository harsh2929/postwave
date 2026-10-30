// SPDX-License-Identifier: AGPL-3.0-only
//
// End-to-end Merkle backfill test. Seeds a few audit_log rows for a
// tenant, runs MerkleWorker.tick(), and verifies:
//
//   * Every row receives prev_hash / row_hash.
//   * The chain is well-formed: row N's prev_hash == row N-1's row_hash.
//   * The snapshot root in audit_merkle_roots matches the tip.

package auditsink

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func newAuditTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed auditsink tests")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func randHex(t *testing.T) string {
	t.Helper()
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b[:])
}

func seedAuditTenant(t *testing.T, pool *pgxpool.Pool) (string, func()) {
	t.Helper()
	ctx := context.Background()
	var id string
	if err := pool.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&id); err != nil {
		t.Fatalf("uuid: %v", err)
	}
	tx, err := db.WithTenant(ctx, pool, id)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $3, 'pro')`,
		id, "audit-test-"+randHex(t), "Audit test"); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant: %v", err)
	}
	cleanup := func() {
		ctx := context.Background()
		tx, err := db.WithTenant(ctx, pool, id)
		if err != nil {
			return
		}
		defer func() { _ = tx.Rollback(ctx) }()
		_, _ = tx.Exec(ctx, "SELECT set_config('app.audit_trim_worker', 'true', true)")
		if _, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, id); err == nil {
			_ = tx.Commit(ctx)
		}
	}
	return id, cleanup
}

// seedAuditRow inserts one audit_log row with row_hash NULL (the
// pre-backfill state).
func seedAuditRow(t *testing.T, pool *pgxpool.Pool, tenantID, action string) int64 {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id int64
	err = tx.QueryRow(ctx, `
INSERT INTO audit_log (tenant_id, action, actor_type, actor_label)
VALUES ($1::uuid, $2, 'human', 'test')
RETURNING id`, tenantID, action).Scan(&id)
	if err != nil {
		t.Fatalf("insert audit row: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit audit row: %v", err)
	}
	return id
}

func TestMerkleWorker_BackfillChain(t *testing.T) {
	pool := newAuditTestPool(t)
	tenantID, cleanup := seedAuditTenant(t, pool)
	defer cleanup()

	// Seed 5 audit rows with row_hash NULL.
	for i := 0; i < 5; i++ {
		seedAuditRow(t, pool, tenantID, "test.action."+randHex(t))
	}

	// Run one tick of the Merkle worker.
	w := &MerkleWorker{Pool: pool, Logger: slog.Default()}
	if err := w.tick(context.Background()); err != nil {
		t.Fatalf("tick: %v", err)
	}

	// Every row must have prev_hash + row_hash now.
	ctx := context.Background()
	tx, txErr := db.WithTenant(ctx, pool, tenantID)
	if txErr != nil {
		t.Fatalf("tenant verification tx: %v", txErr)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var nullCount int
	if err := tx.QueryRow(ctx,
		`SELECT COUNT(*) FROM audit_log
		   WHERE tenant_id = $1::uuid AND row_hash IS NULL`,
		tenantID).Scan(&nullCount); err != nil {
		t.Fatalf("count null hashes: %v", err)
	}
	if nullCount != 0 {
		t.Errorf("expected 0 rows with NULL row_hash after backfill, got %d", nullCount)
	}

	// Walk the chain: each row's prev_hash should equal the previous
	// row's row_hash (or zero for the first).
	rows, txErr := tx.Query(ctx, `
SELECT id, prev_hash, row_hash FROM audit_log
 WHERE tenant_id = $1::uuid
 ORDER BY id ASC`, tenantID)
	if txErr != nil {
		t.Fatalf("walk chain: %v", txErr)
	}
	defer rows.Close()
	var lastHash []byte
	for rows.Next() {
		var id int64
		var prev, row []byte
		if err := rows.Scan(&id, &prev, &row); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if lastHash != nil && string(prev) != string(lastHash) {
			t.Errorf("row %d prev_hash does not match previous row's row_hash (chain broken)", id)
		}
		lastHash = row
	}

	// A root snapshot should exist with the chain's tip.
	var rootHash []byte
	txErr = tx.QueryRow(ctx, `
SELECT root_hash FROM audit_merkle_roots
 WHERE tenant_id = $1::uuid
 ORDER BY id DESC LIMIT 1`, tenantID).Scan(&rootHash)
	if txErr != nil {
		t.Fatalf("read root: %v", txErr)
	}
	if string(rootHash) != string(lastHash) {
		t.Errorf("audit_merkle_roots tip != last row_hash")
	}
}
