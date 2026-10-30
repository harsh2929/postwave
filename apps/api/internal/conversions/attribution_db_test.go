// SPDX-License-Identifier: AGPL-3.0-only
//
// DB-backed attribution math tests. Skip without DATABASE_URL.
// Fixtures live under a throwaway tenant; cleanup is the tenant
// DELETE (conversions / campaigns / campaign_report_events all
// cascade on tenant_id).
package conversions

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func attributionDB(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed attribution test")
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

// randUUID builds a v4-format UUID from crypto/rand without pulling
// a uuid dependency into the module's direct requirements.
func randUUID(t *testing.T) string {
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

// createAttributionTenant inserts a throwaway tenant. The tenants RLS
// insert/delete policies require app.tenant_id = id, so the id is
// generated client-side and the GUC bound before each statement.
func createAttributionTenant(t *testing.T, pool *db.Pool, ctx context.Context) string {
	t.Helper()
	tenantID := randUUID(t)
	slug := "convattr-" + tenantID[:8]
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		t.Fatalf("bind tenant guc: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $2, 'studio')`, tenantID, slug); err != nil {
		t.Fatalf("insert tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant: %v", err)
	}
	t.Cleanup(func() {
		ctx2, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		tx2, err := db.WithTenant(ctx2, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = tx2.Rollback(ctx2) }()
		_, _ = tx2.Exec(ctx2, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = tx2.Commit(ctx2)
	})
	return tenantID
}

func createAttributionCampaign(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, name string) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject, status)
VALUES ($1::uuid, $2, 'subject', 'sent')
RETURNING id::text`, tenantID, name).Scan(&id); err != nil {
		t.Fatalf("insert campaign %q: %v", name, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit campaign: %v", err)
	}
	return id
}

func seedSentEvents(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, campaignID string, n int) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for i := 0; i < n; i++ {
		if _, err := tx.Exec(ctx, `
INSERT INTO campaign_report_events (tenant_id, campaign_id, subscriber_email, event_type, at)
VALUES ($1::uuid, $2::uuid, NULL, 'sent', now())`, tenantID, campaignID); err != nil {
			t.Fatalf("insert sent event: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit sent events: %v", err)
	}
}

// seedConversion inserts a conversion fact directly so occurred_at,
// currency and campaign attribution are fully controlled. campaignID
// "" → unattributed; amountCents nil → non-monetary.
func seedConversion(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, campaignID string, amountCents *int64, currency string, occurredAt time.Time) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO conversions (tenant_id, event_name, amount_cents, currency, campaign_id, occurred_at)
VALUES ($1::uuid, 'purchase', $2, NULLIF($3, ''), NULLIF($4, '')::uuid, $5)`,
		tenantID, amountCents, currency, campaignID, occurredAt); err != nil {
		t.Fatalf("insert conversion: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit conversion: %v", err)
	}
}

func i64(v int64) *int64 { return &v }

// TestCampaignAttribution_Math seeds a mixed-currency, partially
// attributed fixture set and asserts every figure in the response.
func TestCampaignAttribution_Math(t *testing.T) {
	pool := attributionDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantID := createAttributionTenant(t, pool, ctx)
	campA := createAttributionCampaign(t, pool, ctx, tenantID, "Spring Sale")
	campB := createAttributionCampaign(t, pool, ctx, tenantID, "Summer Promo")
	campC := createAttributionCampaign(t, pool, ctx, tenantID, "Newsletter")

	seedSentEvents(t, pool, ctx, tenantID, campA, 4)
	seedSentEvents(t, pool, ctx, tenantID, campB, 2)
	// campC: zero sends — revenue_per_send must be omitted, not 0/Inf.

	now := time.Now().UTC()
	inWindow := now.Add(-24 * time.Hour)
	// Campaign A: 1000 + 2000 USD, plus 500 EUR (mixed currency).
	seedConversion(t, pool, ctx, tenantID, campA, i64(1000), "USD", now)
	seedConversion(t, pool, ctx, tenantID, campA, i64(2000), "USD", inWindow)
	seedConversion(t, pool, ctx, tenantID, campA, i64(500), "EUR", inWindow)
	// Campaign B: 3000 USD (revenue ties A; A wins on conversions).
	seedConversion(t, pool, ctx, tenantID, campB, i64(3000), "USD", inWindow)
	// Campaign C: one non-monetary conversion.
	seedConversion(t, pool, ctx, tenantID, campC, nil, "", inWindow)
	// Unattributed: 4000 USD + one non-monetary.
	seedConversion(t, pool, ctx, tenantID, "", i64(4000), "USD", inWindow)
	seedConversion(t, pool, ctx, tenantID, "", nil, "", inWindow)
	// Outside the 90-day window: must not appear anywhere.
	seedConversion(t, pool, ctx, tenantID, campA, i64(99999), "USD", now.AddDate(0, 0, -100))

	repo := &Repo{Pool: pool}
	out, err := repo.CampaignAttribution(ctx, tenantID, 90, now)
	if err != nil {
		t.Fatalf("CampaignAttribution: %v", err)
	}

	if out.Currency != "USD" {
		t.Errorf("dominant currency = %q, want USD", out.Currency)
	}
	if out.TotalRevenueCents != 10000 {
		t.Errorf("total_revenue_cents = %d, want 10000", out.TotalRevenueCents)
	}
	if out.UnattributedCents != 4000 || out.UnattributedConversions != 2 {
		t.Errorf("unattributed = cents:%d conv:%d, want 4000/2",
			out.UnattributedCents, out.UnattributedConversions)
	}
	// Currency disclosure: USD 10000/4 monetary rows, EUR 500/1.
	if len(out.Currencies) != 2 {
		t.Fatalf("currencies = %+v, want USD + EUR", out.Currencies)
	}
	if out.Currencies[0].Currency != "USD" || out.Currencies[0].RevenueCents != 10000 || out.Currencies[0].Conversions != 4 {
		t.Errorf("currencies[0] = %+v, want USD/10000/4", out.Currencies[0])
	}
	if out.Currencies[1].Currency != "EUR" || out.Currencies[1].RevenueCents != 500 || out.Currencies[1].Conversions != 1 {
		t.Errorf("currencies[1] = %+v, want EUR/500/1", out.Currencies[1])
	}

	if len(out.Items) != 3 {
		t.Fatalf("items = %d, want 3 (%+v)", len(out.Items), out.Items)
	}
	a, b, c := out.Items[0], out.Items[1], out.Items[2]

	// A first: revenue ties B at 3000 USD but has more conversions.
	if a.CampaignID != campA || a.CampaignName != "Spring Sale" {
		t.Errorf("items[0] = %+v, want campaign A", a)
	}
	// 3 conversions (2 USD + 1 EUR — count is currency-free), USD-only revenue.
	if a.Conversions != 3 || a.RevenueCents != 3000 || a.EmailsSent != 4 {
		t.Errorf("A = conv:%d rev:%d sent:%d, want 3/3000/4", a.Conversions, a.RevenueCents, a.EmailsSent)
	}
	if a.RevenuePerSendCents == nil || *a.RevenuePerSendCents != 750 {
		t.Errorf("A revenue_per_send = %v, want 750", a.RevenuePerSendCents)
	}

	if b.CampaignID != campB || b.Conversions != 1 || b.RevenueCents != 3000 || b.EmailsSent != 2 {
		t.Errorf("B = %+v, want campB conv:1 rev:3000 sent:2", b)
	}
	if b.RevenuePerSendCents == nil || *b.RevenuePerSendCents != 1500 {
		t.Errorf("B revenue_per_send = %v, want 1500", b.RevenuePerSendCents)
	}

	if c.CampaignID != campC || c.Conversions != 1 || c.RevenueCents != 0 || c.EmailsSent != 0 {
		t.Errorf("C = %+v, want campC conv:1 rev:0 sent:0", c)
	}
	if c.RevenuePerSendCents != nil {
		t.Errorf("C revenue_per_send = %v, want nil (0 sends)", *c.RevenuePerSendCents)
	}

	if out.Days != 90 {
		t.Errorf("days = %d, want 90", out.Days)
	}
}

// TestAttributionTimeseries_ZeroFillAndFilter asserts zero-filling,
// window sums (attributed + unattributed) and the campaign_id filter.
func TestAttributionTimeseries_ZeroFillAndFilter(t *testing.T) {
	pool := attributionDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantID := createAttributionTenant(t, pool, ctx)
	campA := createAttributionCampaign(t, pool, ctx, tenantID, "Drip")

	now := time.Now().UTC()
	seedConversion(t, pool, ctx, tenantID, campA, i64(1000), "USD", now)
	seedConversion(t, pool, ctx, tenantID, campA, i64(2000), "USD", now.Add(-24*time.Hour))
	seedConversion(t, pool, ctx, tenantID, "", i64(700), "USD", now)
	seedConversion(t, pool, ctx, tenantID, "", nil, "", now)
	seedConversion(t, pool, ctx, tenantID, campA, i64(99999), "USD", now.AddDate(0, 0, -10)) // outside days=7

	repo := &Repo{Pool: pool}
	out, err := repo.AttributionTimeseries(ctx, tenantID, 7, "", now)
	if err != nil {
		t.Fatalf("AttributionTimeseries: %v", err)
	}
	if len(out.Points) != 7 {
		t.Fatalf("points = %d, want 7 (zero-filled)", len(out.Points))
	}
	if out.Currency != "USD" {
		t.Errorf("currency = %q, want USD", out.Currency)
	}
	var sumRev, sumConv int64
	for _, p := range out.Points {
		sumRev += p.RevenueCents
		sumConv += p.Conversions
	}
	if sumRev != 3700 || sumConv != 4 {
		t.Errorf("window sums = rev:%d conv:%d, want 3700/4", sumRev, sumConv)
	}
	today := out.Points[6]
	if today.Date != now.Format("2006-01-02") {
		t.Errorf("last point date = %q, want %q", today.Date, now.Format("2006-01-02"))
	}
	if today.RevenueCents != 1700 || today.Conversions != 3 {
		t.Errorf("today = %+v, want rev:1700 conv:3", today)
	}
	if out.Points[5].RevenueCents != 2000 || out.Points[5].Conversions != 1 {
		t.Errorf("yesterday = %+v, want rev:2000 conv:1", out.Points[5])
	}
	// Day before yesterday: zero-filled.
	if out.Points[4].RevenueCents != 0 || out.Points[4].Conversions != 0 {
		t.Errorf("points[4] = %+v, want zero-filled", out.Points[4])
	}

	// campaign_id filter: only A's rows.
	filtered, err := repo.AttributionTimeseries(ctx, tenantID, 7, campA, now)
	if err != nil {
		t.Fatalf("AttributionTimeseries(campA): %v", err)
	}
	sumRev, sumConv = 0, 0
	for _, p := range filtered.Points {
		sumRev += p.RevenueCents
		sumConv += p.Conversions
	}
	if sumRev != 3000 || sumConv != 2 {
		t.Errorf("filtered sums = rev:%d conv:%d, want 3000/2", sumRev, sumConv)
	}
	if filtered.CampaignID != campA {
		t.Errorf("filtered campaign_id = %q, want %q", filtered.CampaignID, campA)
	}
}
