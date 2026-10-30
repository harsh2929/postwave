// SPDX-License-Identifier: AGPL-3.0-only
//
// clv_dashboard_test.go — SUB-127 (CLV dashboard). Covers:
//   1. A pure-function guard that the Go-side tier definition list
//      (clvTierDefs) stays in lock-step with the tier keys the SQL CASE
//      in GetCLVDistribution can emit — drift here would silently drop a
//      tier from the dashboard.
//   2. A pg-backed test of GetCLVDistribution that seeds a profile_predictions
//      snapshot and asserts headline aggregates, percentiles, tier
//      banding (champions / at_risk), and the top/at-risk previews.
//      Skips cleanly without DATABASE_URL, matching the project convention.

package predictive

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// TestCLVTierDefsCoverSQLCase guards that every tier key the SQL CASE in
// GetCLVDistribution can produce has a matching entry in clvTierDefs (and
// vice versa). If a tier is renamed/added in one place but not the other,
// the dashboard would drop or mislabel a band — this catches it without a
// database.
func TestCLVTierDefsCoverSQLCase(t *testing.T) {
	// Keys the SQL CASE emits. Keep in sync with GetCLVDistribution.
	sqlKeys := map[string]bool{
		"at_risk":    true,
		"champions":  true,
		"high_value": true,
		"mid_value":  true,
		"low_value":  true,
	}
	goKeys := map[string]bool{}
	for _, d := range clvTierDefs {
		if d.Label == "" {
			t.Errorf("tier %q has empty label", d.Key)
		}
		goKeys[d.Key] = true
	}
	for k := range sqlKeys {
		if !goKeys[k] {
			t.Errorf("SQL tier key %q missing from clvTierDefs", k)
		}
	}
	for k := range goKeys {
		if !sqlKeys[k] {
			t.Errorf("clvTierDefs key %q is never emitted by the SQL CASE", k)
		}
	}
}

func newCLVTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed CLV dashboard test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedCLVTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("worker scope for seeding: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'clv-dash-test', 'clv-dash-test', 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant (role lacks tenants INSERT; needs a pre-seeded DB): %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
}

// TestGetCLVDistribution_AggregatesSnapshot pins SUB-127: the aggregation
// endpoint returns correct headline stats, percentiles, tier banding, and
// previews over a seeded profile_predictions snapshot.
func TestGetCLVDistribution_AggregatesSnapshot(t *testing.T) {
	pool := newCLVTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41362"
	seedCLVTenant(t, pool, tenantID)

	suffix := time.Now().UnixNano()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	// The tenant ID is intentionally stable so the worker-scope seed can be
	// reused. Clear an earlier run's snapshot before inserting this run's
	// timestamped addresses; otherwise repeated uncached test runs accumulate
	// profiles and make the aggregate assertions order-dependent.
	if _, err := tx.Exec(ctx, `DELETE FROM profile_predictions WHERE tenant_id = $1::uuid`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("clear prior profile_predictions: %v", err)
	}
	now := time.Now().UTC()
	// 5 profiles spanning the value range. The top one has high churn risk
	// and positive value → at_risk. The rest band by total_clv percentile.
	rows := []struct {
		email       string
		total       int
		churn       float64
		sufficiency string
	}{
		{fmt.Sprintf("low1-%d@ex.test", suffix), 100, 0.1, "limited"},
		{fmt.Sprintf("low2-%d@ex.test", suffix), 500, 0.1, "insufficient"},
		{fmt.Sprintf("mid-%d@ex.test", suffix), 5000, 0.2, "sufficient"},
		{fmt.Sprintf("high-%d@ex.test", suffix), 20000, 0.3, "sufficient"},
		{fmt.Sprintf("atrisk-%d@ex.test", suffix), 90000, 0.8, "sufficient"},
	}
	for _, r := range rows {
		if _, err := tx.Exec(ctx, `
INSERT INTO profile_predictions
  (tenant_id, email, historic_clv_cents, predicted_clv_cents, total_clv_cents,
   churn_risk, predicted_order_count, predicted_gender, confidence,
   data_sufficiency, explanation, calculated_at)
VALUES ($1::uuid, $2::citext, $3, 0, $3, $4, 0, 'unknown', 0.5, $5, '{}'::jsonb, $6)
ON CONFLICT (tenant_id, email) DO UPDATE SET
  total_clv_cents = EXCLUDED.total_clv_cents,
  churn_risk = EXCLUDED.churn_risk,
  data_sufficiency = EXCLUDED.data_sufficiency`,
			tenantID, r.email, r.total, r.churn, r.sufficiency, now); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed profile_predictions (role may lack INSERT/table): %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit profile seed: %v", err)
	}

	r := &Repo{Pool: pool}
	got, err := r.GetCLVDistribution(ctx, tenantID, 10)
	if err != nil {
		t.Fatalf("GetCLVDistribution: %v", err)
	}
	if got.ProfileCount != 5 {
		t.Fatalf("ProfileCount = %d, want 5", got.ProfileCount)
	}
	if got.ScoredProfiles != 4 {
		t.Errorf("ScoredProfiles = %d, want 4 (one insufficient excluded)", got.ScoredProfiles)
	}
	if want := int64(100 + 500 + 5000 + 20000 + 90000); got.TotalCLVCents != want {
		t.Errorf("TotalCLVCents = %d, want %d", got.TotalCLVCents, want)
	}
	if got.Percentiles.P50 <= 0 {
		t.Errorf("P50 = %d, want > 0", got.Percentiles.P50)
	}
	// Tiers must be emitted in defined order and cover all 5 bands.
	if len(got.Tiers) != len(clvTierDefs) {
		t.Fatalf("len(Tiers) = %d, want %d", len(got.Tiers), len(clvTierDefs))
	}
	tierProfiles := map[string]int{}
	for _, tier := range got.Tiers {
		tierProfiles[tier.Key] = tier.Profiles
	}
	if tierProfiles["at_risk"] != 1 {
		t.Errorf("at_risk tier profiles = %d, want 1", tierProfiles["at_risk"])
	}
	// The at-risk preview must include the high-churn high-value profile.
	if len(got.AtRiskProfiles) != 1 {
		t.Errorf("AtRiskProfiles len = %d, want 1", len(got.AtRiskProfiles))
	}
	// Top profile is the highest total_clv (the at-risk one at 90000).
	if len(got.TopProfiles) == 0 || got.TopProfiles[0].TotalCLVCents != 90000 {
		t.Errorf("top profile = %+v, want total 90000", got.TopProfiles)
	}
	if got.LastCalculatedAt == nil {
		t.Error("LastCalculatedAt nil, want non-nil")
	}

	aggregateOnly, err := r.GetCLVDistribution(ctx, tenantID, 0)
	if err != nil {
		t.Fatalf("GetCLVDistribution aggregate-only: %v", err)
	}
	if len(aggregateOnly.TopProfiles) != 0 || len(aggregateOnly.AtRiskProfiles) != 0 {
		t.Fatalf("aggregate-only previews = top:%d risk:%d, want none", len(aggregateOnly.TopProfiles), len(aggregateOnly.AtRiskProfiles))
	}
	if aggregateOnly.ProfileCount != got.ProfileCount || aggregateOnly.TotalCLVCents != got.TotalCLVCents {
		t.Fatalf("aggregate-only totals = %+v, want profile_count=%d total_clv_cents=%d", aggregateOnly, got.ProfileCount, got.TotalCLVCents)
	}
}
