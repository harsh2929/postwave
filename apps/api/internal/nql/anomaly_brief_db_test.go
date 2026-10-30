// SPDX-License-Identifier: AGPL-3.0-only
//
// DB-backed revenue-scope regressions. These tests follow the API module's
// convention of skipping when DATABASE_URL is unavailable. Fixtures live in
// throwaway tenants and exercise the real RLS transaction + aggregate SQL.
package nql

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func anomalyBriefDB(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed anomaly brief test")
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

func anomalyBriefUUID(t *testing.T) string {
	t.Helper()
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func createAnomalyBriefTenant(t *testing.T, pool *db.Pool, ctx context.Context, label string) string {
	t.Helper()
	tenantID := anomalyBriefUUID(t)
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $3, 'studio')`, tenantID, "nqlbrief-"+tenantID[:8], label); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant (role lacks tenants INSERT; needs a pre-seeded DB): %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cleanup, err := db.WithTenant(cleanupCtx, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = cleanup.Rollback(cleanupCtx) }()
		_, _ = cleanup.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = cleanup.Commit(cleanupCtx)
	})
	return tenantID
}

func createAnomalyBriefCampaign(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, name string) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("campaign tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var campaignID string
	if err := tx.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject, status)
VALUES ($1::uuid, $2, 'Revenue evidence', 'sent')
RETURNING id::text`, tenantID, name).Scan(&campaignID); err != nil {
		t.Fatalf("seed campaign: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit campaign: %v", err)
	}
	return campaignID
}

func seedAnomalyBriefConversion(
	t *testing.T,
	pool *db.Pool,
	ctx context.Context,
	tenantID, campaignID, currency string,
	amountCents *int64,
	occurredAt time.Time,
) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("conversion tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO conversions
  (tenant_id, event_name, amount_cents, currency, campaign_id, occurred_at)
VALUES
  ($1::uuid, 'purchase', $2, NULLIF($3, ''), NULLIF($4, '')::uuid, $5)`,
		tenantID, amountCents, currency, campaignID, occurredAt); err != nil {
		t.Fatalf("seed conversion: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit conversion: %v", err)
	}
}

func anomalyCents(value int64) *int64 { return &value }

func requireRevenueScope(t *testing.T, agg *anomalyAggregates, currency string, conversions, excluded int64) {
	t.Helper()
	if agg.Metric != "revenue" || agg.WindowDays != 7 {
		t.Fatalf("aggregate provenance = (%q, %d), want (revenue, 7)", agg.Metric, agg.WindowDays)
	}
	if agg.RevenueScope == nil {
		t.Fatal("revenue_scope is nil")
	}
	if agg.RevenueScope.Currency == nil || *agg.RevenueScope.Currency != currency {
		t.Fatalf("currency = %v, want %q", agg.RevenueScope.Currency, currency)
	}
	if agg.RevenueScope.MonetaryConversionCount != conversions {
		t.Fatalf("monetary_conversion_count = %d, want %d", agg.RevenueScope.MonetaryConversionCount, conversions)
	}
	if agg.RevenueScope.ExcludedCurrencyCount != excluded {
		t.Fatalf("excluded_currency_count = %d, want %d", agg.RevenueScope.ExcludedCurrencyCount, excluded)
	}
}

func TestGatherAnomalyRevenueAggregates_USDOnly(t *testing.T) {
	pool := anomalyBriefDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := createAnomalyBriefTenant(t, pool, ctx, "USD-only anomaly brief")
	campaignID := createAnomalyBriefCampaign(t, pool, ctx, tenantID, "USD campaign")
	now := time.Now().UTC()
	seedAnomalyBriefConversion(t, pool, ctx, tenantID, campaignID, "USD", anomalyCents(3_000), now.Add(-4*time.Hour))
	seedAnomalyBriefConversion(t, pool, ctx, tenantID, campaignID, "USD", anomalyCents(2_000), now.Add(-3*time.Hour))
	seedAnomalyBriefConversion(t, pool, ctx, tenantID, campaignID, "USD", anomalyCents(1_000), now.Add(-8*24*time.Hour))

	agg, err := (&AnalyticsDeps{Pool: pool}).gatherAnomalyAggregates(ctx, tenantID, anomalyMetricByID("revenue"), 7)
	if err != nil {
		t.Fatalf("gatherAnomalyAggregates: %v", err)
	}
	requireRevenueScope(t, agg, "USD", 3, 0)
	if agg.CurrentTotal != 5_000 || agg.PreviousTotal != 1_000 {
		t.Fatalf("totals = (%d, %d), want (5000, 1000)", agg.CurrentTotal, agg.PreviousTotal)
	}
	if len(agg.Daily) != 1 || agg.Daily[0].Value != 5_000 {
		t.Fatalf("daily = %#v, want one USD-only 5000 point", agg.Daily)
	}
	if len(agg.TopCampaigns) != 1 || agg.TopCampaigns[0].Value != 5_000 {
		t.Fatalf("top_campaigns = %#v, want one USD-only 5000 row", agg.TopCampaigns)
	}
}

func TestGatherAnomalyRevenueAggregates_MixedCurrencyAndTenantIsolation(t *testing.T) {
	pool := anomalyBriefDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	primaryTenant := createAnomalyBriefTenant(t, pool, ctx, "Mixed anomaly brief")
	otherTenant := createAnomalyBriefTenant(t, pool, ctx, "Isolated anomaly brief")
	primaryCampaign := createAnomalyBriefCampaign(t, pool, ctx, primaryTenant, "Mixed campaign")
	otherCampaign := createAnomalyBriefCampaign(t, pool, ctx, otherTenant, "Other tenant campaign")
	now := time.Now().UTC()

	// Combined-horizon totals tie at 10,000. USD wins by row count (3 vs
	// 1), even though EUR is larger in the current window. This proves the
	// dominant choice is made once over current + previous, not independently
	// per aggregate.
	seedAnomalyBriefConversion(t, pool, ctx, primaryTenant, primaryCampaign, "USD", anomalyCents(4_000), now.Add(-4*time.Hour))
	seedAnomalyBriefConversion(t, pool, ctx, primaryTenant, primaryCampaign, "USD", anomalyCents(3_000), now.Add(-3*time.Hour))
	seedAnomalyBriefConversion(t, pool, ctx, primaryTenant, primaryCampaign, "USD", anomalyCents(3_000), now.Add(-8*24*time.Hour))
	seedAnomalyBriefConversion(t, pool, ctx, primaryTenant, primaryCampaign, "EUR", anomalyCents(10_000), now.Add(-2*time.Hour))
	seedAnomalyBriefConversion(t, pool, ctx, otherTenant, otherCampaign, "INR", anomalyCents(1_000_000_000), now.Add(-time.Hour))

	deps := &AnalyticsDeps{Pool: pool}
	agg, err := deps.gatherAnomalyAggregates(ctx, primaryTenant, anomalyMetricByID("revenue"), 7)
	if err != nil {
		t.Fatalf("primary gatherAnomalyAggregates: %v", err)
	}
	requireRevenueScope(t, agg, "USD", 4, 1)
	if agg.CurrentTotal != 7_000 || agg.PreviousTotal != 3_000 {
		t.Fatalf("primary totals = (%d, %d), want USD-only (7000, 3000)", agg.CurrentTotal, agg.PreviousTotal)
	}
	if len(agg.Daily) != 1 || agg.Daily[0].Value != 7_000 {
		t.Fatalf("primary daily = %#v, want EUR and other tenant excluded", agg.Daily)
	}
	if len(agg.TopCampaigns) != 1 || agg.TopCampaigns[0].Value != 7_000 {
		t.Fatalf("primary top_campaigns = %#v, want USD-only 7000", agg.TopCampaigns)
	}

	isolated, err := deps.gatherAnomalyAggregates(ctx, otherTenant, anomalyMetricByID("revenue"), 7)
	if err != nil {
		t.Fatalf("isolated gatherAnomalyAggregates: %v", err)
	}
	requireRevenueScope(t, isolated, "INR", 1, 0)
	if isolated.CurrentTotal != 1_000_000_000 || isolated.PreviousTotal != 0 {
		t.Fatalf("isolated totals = (%d, %d), want (1000000000, 0)", isolated.CurrentTotal, isolated.PreviousTotal)
	}
}

func TestGatherAnomalyRevenueAggregates_ZeroMonetaryRows(t *testing.T) {
	pool := anomalyBriefDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := createAnomalyBriefTenant(t, pool, ctx, "Zero revenue anomaly brief")
	seedAnomalyBriefConversion(t, pool, ctx, tenantID, "", "", nil, time.Now().UTC().Add(-time.Hour))

	agg, err := (&AnalyticsDeps{Pool: pool}).gatherAnomalyAggregates(ctx, tenantID, anomalyMetricByID("revenue"), 7)
	if err != nil {
		t.Fatalf("gatherAnomalyAggregates: %v", err)
	}
	if agg.RevenueScope == nil {
		t.Fatal("revenue_scope is nil")
	}
	if agg.RevenueScope.Currency != nil || agg.RevenueScope.MonetaryConversionCount != 0 || agg.RevenueScope.ExcludedCurrencyCount != 0 {
		t.Fatalf("revenue_scope = %#v, want explicit no-monetary-conversions scope", agg.RevenueScope)
	}
	if agg.CurrentTotal != 0 || agg.PreviousTotal != 0 || len(agg.Daily) != 0 || len(agg.TopCampaigns) != 0 {
		t.Fatalf("zero-row aggregates = %#v, want zero totals and empty evidence", agg)
	}
}

func TestGatherAnomalyRevenueAggregates_InvalidCurrencyFailsClosed(t *testing.T) {
	pool := anomalyBriefDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	for _, tc := range []struct {
		name, currency string
	}{
		{name: "missing", currency: ""},
		{name: "invented", currency: "ZZZ"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tenantID := createAnomalyBriefTenant(t, pool, ctx, "Invalid currency anomaly brief")
			seedAnomalyBriefConversion(t, pool, ctx, tenantID, "", tc.currency, anomalyCents(100), time.Now().UTC().Add(-time.Hour))

			agg, err := (&AnalyticsDeps{Pool: pool}).gatherAnomalyAggregates(ctx, tenantID, anomalyMetricByID("revenue"), 7)
			if err == nil {
				t.Fatalf("aggregates = %#v, want invalid currency error", agg)
			}
		})
	}
}
