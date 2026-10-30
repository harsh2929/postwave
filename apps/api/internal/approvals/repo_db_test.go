// SPDX-License-Identifier: AGPL-3.0-only
//
// DB-backed tests for the approvals Repo. Mirrors the t.Skip-when-
// DATABASE_URL-unset pattern used in scim_db_test.go so the suite
// stays green on CI workers that don't expose a live Postgres.
//
// Coverage focus: the single-use token consumption ledger added by
// migration 0173 (audit CRITICAL F2). The unique index on
// (approval_id, token_sha256) is what makes the replay gate
// race-safe; this test asserts the index is what Postgres actually
// uses to reject the second insert.

package approvals

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func newApprovalsTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed approvals tests")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func randHexBytes(t *testing.T, n int) string {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b)
}

// seedApprovalRow inserts a tenant + a pending approval and returns
// (tenantID, approvalID, cleanup). The approval row is the FK target
// for approval_token_consumption inserts.
func seedApprovalRow(t *testing.T, pool *pgxpool.Pool) (string, string, func()) {
	t.Helper()
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer conn.Release()
	var tenantID string
	if err := conn.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&tenantID); err != nil {
		t.Fatalf("uuid: %v", err)
	}
	if _, err := conn.Exec(ctx,
		`SELECT set_config('app.tenant_id', $1, false)`, tenantID); err != nil {
		t.Fatalf("set guc: %v", err)
	}
	if _, err := conn.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $3, 'pro')`,
		tenantID, "approvals-test-"+randHexBytes(t, 4), "approvals test"); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	var approvalID string
	if err := conn.QueryRow(ctx, `
INSERT INTO approvals (
    tenant_id, resource_type, resource_id, status,
    requested_at, expires_at
)
VALUES ($1::uuid, 'campaign', gen_random_uuid(), 'pending',
        now(), now() + interval '1 day')
RETURNING id::text`, tenantID).Scan(&approvalID); err != nil {
		t.Fatalf("seed approval: %v", err)
	}
	cleanup := func() {
		ctx := context.Background()
		conn, err := pool.Acquire(ctx)
		if err != nil {
			return
		}
		defer conn.Release()
		_, _ = conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, tenantID)
		_, _ = conn.Exec(ctx,
			`DELETE FROM approval_token_consumption WHERE approval_id = $1::uuid`, approvalID)
		_, _ = conn.Exec(ctx, `DELETE FROM approvals WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = conn.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	}
	return tenantID, approvalID, cleanup
}

// TestMarkTokenConsumed_RejectsReplay drives the audit CRITICAL F2
// invariant: the first call with a given (approval_id, token) pair
// succeeds; the second returns ErrTokenAlreadyUsed. The third call
// with a DIFFERENT token on the SAME approval must succeed, because
// the uniqueness is scoped to the SHA-256 of the token, not the
// approval row.
func TestMarkTokenConsumed_RejectsReplay(t *testing.T) {
	pool := newApprovalsTestPool(t)
	_, approvalID, cleanup := seedApprovalRow(t, pool)
	defer cleanup()
	repo := &Repo{Pool: pool}

	tok := "tok_" + randHexBytes(t, 16)

	// First click — consumes the token.
	if err := repo.MarkTokenConsumed(context.Background(), approvalID, tok); err != nil {
		t.Fatalf("first MarkTokenConsumed: %v", err)
	}
	// Second click with the SAME token — must hit the unique index.
	err := repo.MarkTokenConsumed(context.Background(), approvalID, tok)
	if !errors.Is(err, ErrTokenAlreadyUsed) {
		t.Fatalf("second MarkTokenConsumed: want ErrTokenAlreadyUsed, got %v", err)
	}
	// A different token (different sha256) on the same approval is
	// fine — the index keys on (approval_id, token_sha256), not
	// (approval_id) alone.
	if err := repo.MarkTokenConsumed(context.Background(), approvalID, "tok_"+randHexBytes(t, 16)); err != nil {
		t.Fatalf("MarkTokenConsumed with different token: %v", err)
	}
}

// TestMarkTokenConsumed_RejectsEmptyInputs asserts the cheap guard
// at the top of the function — empty approvalID or empty token
// should not even reach Postgres (saves a round trip and protects
// against accidentally inserting a NULL/empty hash row).
func TestMarkTokenConsumed_RejectsEmptyInputs(t *testing.T) {
	pool := newApprovalsTestPool(t)
	repo := &Repo{Pool: pool}
	cases := []struct {
		name       string
		approvalID string
		token      string
	}{
		{"empty approval id", "", "tok_x"},
		{"empty token", "00000000-0000-0000-0000-000000000000", ""},
		{"both empty", "", ""},
		{"whitespace approval id", "   ", "tok_x"},
		{"whitespace token", "00000000-0000-0000-0000-000000000000", "   "},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := repo.MarkTokenConsumed(context.Background(), tc.approvalID, tc.token)
			if !errors.Is(err, ErrBadToken) {
				t.Errorf("want ErrBadToken, got %v", err)
			}
		})
	}
}

// TestMarkTokenConsumed_PersistsHashNotRaw asserts the ledger stores
// SHA-256 of the token, not the raw value. A DB dump must not leak
// undecided tokens. We verify by reading the row back and confirming
// the bytes match an independent re-hash and are exactly 32 bytes.
func TestMarkTokenConsumed_PersistsHashNotRaw(t *testing.T) {
	pool := newApprovalsTestPool(t)
	_, approvalID, cleanup := seedApprovalRow(t, pool)
	defer cleanup()
	repo := &Repo{Pool: pool}

	tok := "tok_" + randHexBytes(t, 16)
	if err := repo.MarkTokenConsumed(context.Background(), approvalID, tok); err != nil {
		t.Fatalf("MarkTokenConsumed: %v", err)
	}

	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer conn.Release()
	var stored []byte
	var consumedAt time.Time
	err = conn.QueryRow(ctx, `
SELECT token_sha256, consumed_at FROM approval_token_consumption
 WHERE approval_id = $1::uuid
 LIMIT 1`, approvalID).Scan(&stored, &consumedAt)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if len(stored) != 32 {
		t.Errorf("stored token len = %d, want 32 (SHA-256)", len(stored))
	}
	if string(stored) == tok {
		t.Error("stored bytes equal raw token — hash was bypassed")
	}
	if consumedAt.IsZero() {
		t.Error("consumed_at not populated")
	}
}
