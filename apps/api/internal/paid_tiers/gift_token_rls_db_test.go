// SPDX-License-Identifier: AGPL-3.0-only

package paid_tiers

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// A gift link must reveal exactly one gift, and only to whoever holds its token.
//
// `GiftPreview` and `RedeemGift` set app.tenant_id to the all-zero uuid — the
// redeemer has no tenant, which is the point of a gift link — and set
// app.public_gift_token to the token presented. NOTHING read that GUC: a
// schema-wide search across every policy and every function body found zero
// references. So the row was matched against the all-zero tenant, no real gift
// ever matched, and every preview and redemption returned "not found".
//
// Migration 1905 admits the token in BOTH the restrictive rule (so it does not
// veto) and a permissive one (so something grants). Either alone leaves the
// behaviour unchanged, which is how a half-finished RLS change hides.
func TestAGiftTokenRevealsExactlyItsOwnGift(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping gift token RLS test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	tenantID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'gift-rls-test', 'gift-rls-' || right($1::text, 12), 'studio')`, tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO gift_subscriptions
    (tenant_id, purchaser_email, recipient_email, plan_id, duration_months, redemption_token_sha256)
VALUES ($1::uuid, 'buyer@example.test', 'mine@example.test', 'pro', 3, decode('a1b2','hex')),
       ($1::uuid, 'buyer@example.test', 'other@example.test', 'pro', 3, decode('c3d4','hex'))`,
		tenantID); err != nil {
		t.Fatalf("seed gifts: %v", err)
	}

	// The public path: no tenant, one token.
	publicScope := func(token string) {
		t.Helper()
		if _, err := tx.Exec(ctx,
			`SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true),
			        set_config('app.public_gift_token', $1, true)`, token); err != nil {
			t.Fatalf("set public gift scope: %v", err)
		}
	}
	count := func(where string, args ...any) int {
		t.Helper()
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM gift_subscriptions `+where, args...).Scan(&n); err != nil {
			t.Fatalf("count: %v", err)
		}
		return n
	}

	publicScope("a1b2")
	if got := count(`WHERE redemption_token_sha256 = decode('a1b2','hex')`); got != 1 {
		t.Fatalf("the holder of a valid gift token sees %d gifts, want 1. Preview "+
			"and redemption return \"not found\" for every real gift.", got)
	}
	if got := count(`WHERE redemption_token_sha256 = decode('c3d4','hex')`); got != 0 {
		t.Fatalf("one token exposed %d OTHER gift(s) belonging to the same tenant; "+
			"the capability is not scoped to its own row", got)
	}
	publicScope("ffff")
	if got := count(""); got != 0 {
		t.Fatalf("a wrong token saw %d gift(s)", got)
	}
	publicScope("")
	if got := count(""); got != 0 {
		t.Fatalf("a request presenting NO token saw %d gift(s); the public path is "+
			"open to anyone who reaches it", got)
	}
}
