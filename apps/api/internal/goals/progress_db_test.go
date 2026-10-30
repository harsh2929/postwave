// SPDX-License-Identifier: AGPL-3.0-only
//
// DB-backed regression for the goals revenue_cents metric. Skip
// without DATABASE_URL (project-wide pg-backed test convention).
//
// Pins Finding 3 (2026-06 backend audit): the revenue_cents goal
// metric used to SUM(amount_cents) across ALL currencies, violating
// the conversions package's "never sum across currencies" contract —
// a USD+EUR tenant got a meaningless cross-currency total. The fix
// resolves the window's dominant currency and SUMs only that
// currency's rows. This test seeds a mixed-currency tenant where USD
// dominates and asserts the metric returns the USD-only sum, NOT the
// USD+EUR mash-up.
package goals

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func progressDB(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed goals progress test")
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

// randUUIDGoals builds a v4-format UUID from crypto/rand without
// pulling a uuid dependency into the module's direct requirements
// (mirrors conversions' attribution_db_test.go).
func randUUIDGoals(t *testing.T) string {
	t.Helper()
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// TestRevenueMetricUsesDominantCurrencyOnly is the Finding 3 regression:
// a tenant with USD (dominant) + EUR conversions in the window must
// report the USD-only sum, never the cross-currency total.
func TestRevenueMetricUsesDominantCurrencyOnly(t *testing.T) {
	pool := progressDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantID := randUUIDGoals(t)
	slug := "goalsrev-" + tenantID[:8]

	// Seed the throwaway tenant under its own GUC (tenants RLS requires
	// app.tenant_id = id on insert).
	seed, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $2, 'studio')`, tenantID, slug); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed tenant (role lacks tenants INSERT; needs a pre-seeded DB): %v", err)
	}
	if err := seed.Commit(ctx); err != nil {
		t.Fatalf("commit tenant: %v", err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = tx.Rollback(ctx) }()
		_, _ = tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = tx.Commit(ctx)
	})

	// Window [start, end) and an occurred_at safely inside it.
	start := time.Now().UTC().Add(-24 * time.Hour)
	end := start.Add(7 * 24 * time.Hour)
	at := start.Add(1 * time.Hour)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("conversions tx: %v", err)
	}
	// USD dominates (300_00 total) over EUR (100_00). The buggy
	// cross-currency SUM would return 40000 (300_00+100_00); the fix
	// returns 30000 (USD only).
	for _, row := range []struct {
		cents    int64
		currency string
	}{
		{200_00, "USD"},
		{100_00, "USD"},
		{100_00, "EUR"},
	} {
		if _, err := tx.Exec(ctx, `
INSERT INTO conversions (tenant_id, subscriber_email, event_name, amount_cents, currency, occurred_at)
VALUES ($1::uuid, 'buyer@example.com', 'purchase', $2, $3, $4)`,
			tenantID, row.cents, row.currency, at); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed conversion %s: %v", row.currency, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit conversions: %v", err)
	}

	d := &Deps{Pool: pool}
	got, err := d.currentValue(ctx, tenantID, "revenue_cents", start, end)
	if err != nil {
		t.Fatalf("currentValue: %v", err)
	}
	const wantUSD = 30000.0
	if got != wantUSD {
		t.Fatalf("revenue_cents = %v, want %v (USD-only dominant sum, NOT the %v USD+EUR cross-currency total)",
			got, wantUSD, 40000.0)
	}
}
