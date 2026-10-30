// SPDX-License-Identifier: AGPL-3.0-only
//
// repo_test.go — SUB-129 (data-sufficiency tenant report). Covers:
//   1. A pure-function guard on sufficiencyPct (the percentage derivation
//      used on every read of the rollup), including the divide-by-zero case.
//   2. A no-tenant 401 guard on the DataSufficiency handler.
//   3. A pg-backed test that seeds a profile_predictions snapshot, runs
//      refreshSufficiencyRollup, and asserts GetDataSufficiency returns the
//      correct counts + derived percentages. Skips cleanly without
//      DATABASE_URL, matching the project convention (clv_dashboard_test.go).

package predictive

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestSufficiencyPct(t *testing.T) {
	cases := []struct {
		count, total int
		want         float64
	}{
		{0, 0, 0},     // empty snapshot: no division-by-zero
		{0, 100, 0},   // none in bucket: 0%
		{50, 100, 50}, // half
		{100, 100, 100},
		{1, 3, 33.333333333333336}, // float
		{5, -1, 0},                 // defensive: negative total returns 0
	}
	for _, tc := range cases {
		got := sufficiencyPct(tc.count, tc.total)
		if math.Abs(got-tc.want) > 1e-9 {
			t.Errorf("sufficiencyPct(%d,%d) = %v, want %v", tc.count, tc.total, got, tc.want)
		}
	}
}

func TestDataSufficiency_NoTenantReturns401(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/predictive/data-sufficiency", nil)
	rec := httptest.NewRecorder()
	d.DataSufficiency(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "no_tenant") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func newSufficiencyTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed data-sufficiency test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedSufficiencyTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("worker scope for seeding: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'sufficiency-test', 'sufficiency-test-' || right($1::text, 12), 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant (role lacks tenants INSERT; needs a pre-seeded DB): %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
}

// TestRefreshAndGetDataSufficiency pins SUB-129: refreshSufficiencyRollup
// aggregates the three-way data_sufficiency distribution and
// GetDataSufficiency reads it back with correct counts + derived percentages.
func TestRefreshAndGetDataSufficiency(t *testing.T) {
	pool := newSufficiencyTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41363"
	seedSufficiencyTenant(t, pool, tenantID)

	suffix := time.Now().UnixNano()
	now := time.Now().UTC()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	// This test reuses a stable tenant but creates timestamped addresses.
	// Remove snapshots and the derived rollup from prior runs so an uncached
	// suite remains repeatable against a long-lived integration database.
	if _, err := tx.Exec(ctx, `DELETE FROM profile_predictions WHERE tenant_id = $1::uuid`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("clear prior profile_predictions: %v", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM profile_prediction_sufficiency_rollup WHERE tenant_id = $1::uuid`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("clear prior sufficiency rollup: %v", err)
	}
	// 1 insufficient, 2 limited, 3 sufficient = 6 total.
	rows := []struct {
		email       string
		sufficiency string
	}{
		{fmt.Sprintf("i1-%d@ex.test", suffix), "insufficient"},
		{fmt.Sprintf("l1-%d@ex.test", suffix), "limited"},
		{fmt.Sprintf("l2-%d@ex.test", suffix), "limited"},
		{fmt.Sprintf("s1-%d@ex.test", suffix), "sufficient"},
		{fmt.Sprintf("s2-%d@ex.test", suffix), "sufficient"},
		{fmt.Sprintf("s3-%d@ex.test", suffix), "sufficient"},
	}
	for _, r := range rows {
		if _, err := tx.Exec(ctx, `
INSERT INTO profile_predictions
  (tenant_id, email, historic_clv_cents, predicted_clv_cents, total_clv_cents,
   churn_risk, predicted_order_count, predicted_gender, confidence,
   data_sufficiency, explanation, calculated_at)
VALUES ($1::uuid, $2::citext, 0, 0, 0, 0, 0, 'unknown', 0.5, $3, '{}'::jsonb, $4)
ON CONFLICT (tenant_id, email) DO UPDATE SET
  data_sufficiency = EXCLUDED.data_sufficiency`,
			tenantID, r.email, r.sufficiency, now); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed profile_predictions (role may lack INSERT/table): %v", err)
		}
	}
	if err := refreshSufficiencyRollup(ctx, tx, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("refreshSufficiencyRollup (role may lack INSERT/table): %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed+rollup: %v", err)
	}

	r := &Repo{Pool: pool}
	got, err := r.GetDataSufficiency(ctx, tenantID)
	if err != nil {
		t.Fatalf("GetDataSufficiency: %v", err)
	}
	if got.Total != 6 {
		t.Fatalf("Total = %d, want 6", got.Total)
	}
	if got.Insufficient.Count != 1 {
		t.Errorf("Insufficient.Count = %d, want 1", got.Insufficient.Count)
	}
	if got.Limited.Count != 2 {
		t.Errorf("Limited.Count = %d, want 2", got.Limited.Count)
	}
	if got.Sufficient.Count != 3 {
		t.Errorf("Sufficient.Count = %d, want 3", got.Sufficient.Count)
	}
	if math.Abs(got.Sufficient.Percentage-50.0) > 1e-9 {
		t.Errorf("Sufficient.Percentage = %v, want 50", got.Sufficient.Percentage)
	}
	if math.Abs(got.Limited.Percentage-(2.0/6.0*100)) > 1e-9 {
		t.Errorf("Limited.Percentage = %v", got.Limited.Percentage)
	}
	if got.LastUpdated == nil {
		t.Error("LastUpdated nil, want non-nil")
	}
}

// TestGetDataSufficiency_AbsentRollupIsEmpty pins the empty-state contract:
// a tenant with no rollup row yet (never recomputed) gets a zeroed report and
// a nil LastUpdated rather than an error.
func TestGetDataSufficiency_AbsentRollupIsEmpty(t *testing.T) {
	pool := newSufficiencyTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41364"
	seedSufficiencyTenant(t, pool, tenantID)

	// Best-effort clear any rollup row from a prior run so the assertion is
	// deterministic.
	if tx, err := db.WithTenant(ctx, pool, tenantID); err == nil {
		_, _ = tx.Exec(ctx, `DELETE FROM profile_prediction_sufficiency_rollup WHERE tenant_id = $1::uuid`, tenantID)
		_ = tx.Commit(ctx)
	}

	r := &Repo{Pool: pool}
	got, err := r.GetDataSufficiency(ctx, tenantID)
	if err != nil {
		t.Fatalf("GetDataSufficiency: %v", err)
	}
	if got.Total != 0 {
		t.Errorf("Total = %d, want 0", got.Total)
	}
	if got.LastUpdated != nil {
		t.Errorf("LastUpdated = %v, want nil", got.LastUpdated)
	}
}

// ensure middleware import is used even when the pg tests skip; the handler
// 401 test above relies on it for context-free requests, but this keeps the
// import honest if that test is ever removed.
var _ = middleware.TenantFromContext
