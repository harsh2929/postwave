// SPDX-License-Identifier: AGPL-3.0-only

package holdout

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestDeleteAllowsOnlyUndecidedHoldouts_DB(t *testing.T) {
	pool := holdoutDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	tenantID := createHoldoutTenant(t, pool, ctx)
	deps := &Deps{Pool: pool}

	undecidedCampaignID := createHoldoutCampaign(t, pool, ctx, tenantID)
	createHoldoutRow(t, pool, ctx, tenantID, undecidedCampaignID, "delete-me", 10)
	undecidedResponse := deleteHoldoutRequest(t, deps, tenantID, undecidedCampaignID)
	if undecidedResponse.Code != http.StatusNoContent {
		t.Fatalf("delete undecided status = %d, body=%s", undecidedResponse.Code, undecidedResponse.Body.String())
	}
	if got := holdoutRowCount(t, pool, ctx, tenantID, undecidedCampaignID); got != 0 {
		t.Fatalf("undecided holdout rows after delete = %d, want 0", got)
	}

	decidedCampaignID := createHoldoutCampaign(t, pool, ctx, tenantID)
	createHoldoutRow(t, pool, ctx, tenantID, decidedCampaignID, "keep-me", 10)
	const subscriberEmail = "holdout-delete-evidence@example.test"
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin subscriber setup: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'api')`, tenantID, subscriberEmail); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("insert subscriber: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber: %v", err)
	}
	fixedNow := time.Date(2026, 8, 30, 9, 0, 0, 0, time.UTC)
	plan, err := planAudienceAt(ctx, pool, tenantID, decidedCampaignID, []string{subscriberEmail}, fixedNow)
	if err != nil || plan == nil {
		t.Fatalf("plan decided holdout: plan=%v err=%v", plan, err)
	}
	freezeTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin freeze: %v", err)
	}
	if err := PersistAssignmentPlanTx(ctx, freezeTx, tenantID, decidedCampaignID, plan, plan.TreatmentCount()); err != nil {
		_ = freezeTx.Rollback(ctx)
		t.Fatalf("freeze assignment evidence: %v", err)
	}
	if err := freezeTx.Commit(ctx); err != nil {
		t.Fatalf("commit assignment evidence: %v", err)
	}

	decidedResponse := deleteHoldoutRequest(t, deps, tenantID, decidedCampaignID)
	if decidedResponse.Code != http.StatusConflict {
		t.Fatalf("delete decided status = %d, want 409; body=%s", decidedResponse.Code, decidedResponse.Body.String())
	}
	if got := holdoutRowCount(t, pool, ctx, tenantID, decidedCampaignID); got != 1 {
		t.Fatalf("decided holdout rows after rejected delete = %d, want 1", got)
	}
}

func deleteHoldoutRequest(t *testing.T, deps *Deps, tenantID, campaignID string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/campaigns/"+campaignID+"/holdout", nil)
	route := chi.NewRouteContext()
	route.URLParams.Add("id", campaignID)
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, route)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID})
	recorder := httptest.NewRecorder()
	deps.Delete(recorder, req.WithContext(ctx))
	return recorder
}

func holdoutRowCount(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, campaignID string) int {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin holdout count: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var count int
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM campaign_holdouts
 WHERE tenant_id = $1::uuid
   AND campaign_id = $2::uuid`, tenantID, campaignID).Scan(&count); err != nil {
		t.Fatalf("count holdouts: %v", err)
	}
	return count
}
