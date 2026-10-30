// SPDX-License-Identifier: AGPL-3.0-only
package campaigns

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestGoalResultsUseEachRecipientsSendWindow_DB(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	tenantID := setupTenantQ(t, pool, ctx, "goal-send-window")
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var campaignID string
	if err := tx.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject, status, body_html, goal_event, goal_window_hours)
VALUES ($1::uuid, 'Goal window', 'Hello', 'sent', '<p>Hello</p>', 'purchase', 1)
RETURNING id::text`, tenantID).Scan(&campaignID); err != nil {
		t.Fatal(err)
	}
	first := time.Now().UTC().Add(-3 * time.Hour).Truncate(time.Second)
	second := first.Add(time.Hour)
	for _, send := range []struct {
		email string
		at    time.Time
	}{
		{"first@example.test", first},
		{"second@example.test", second},
	} {
		if _, err := tx.Exec(ctx, `
INSERT INTO campaign_report_events (tenant_id, campaign_id, subscriber_email, event_type, at)
VALUES ($1::uuid, $2::uuid, $3, 'sent', $4)`, tenantID, campaignID, send.email, send.at); err != nil {
			t.Fatal(err)
		}
	}
	for _, conversion := range []struct {
		email *string
		at    time.Time
	}{
		{goalEmail("first@example.test"), first.Add(30 * time.Minute)},  // valid despite a later recipient send
		{goalEmail("second@example.test"), first.Add(30 * time.Minute)}, // before this recipient was sent
		{nil, first.Add(45 * time.Minute)},                              // explicitly attributed anonymous event
		{goalEmail("first@example.test"), first.Add(90 * time.Minute)},  // outside this recipient's window
	} {
		if _, err := tx.Exec(ctx, `
INSERT INTO conversions (tenant_id, subscriber_email, event_name, amount_cents, currency, campaign_id, occurred_at)
VALUES ($1::uuid, $2, 'purchase', 150, 'USD', $3::uuid, $4)`, tenantID, conversion.email, campaignID, conversion.at); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/v1/campaigns/"+campaignID+"/goal-results", nil)
	route := chi.NewRouteContext()
	route.URLParams.Add("id", campaignID)
	request = request.WithContext(middleware.WithTenant(context.WithValue(request.Context(), chi.RouteCtxKey, route), &middleware.Tenant{ID: tenantID}))
	recorder := httptest.NewRecorder()
	(&Deps{Repo: &Repo{Pool: pool}}).goalResults(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var result GoalResults
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Recipients != 2 || result.ConversionCount != 2 || result.ConvertedRecipients != 1 || result.ConversionRate != 0.5 || result.AttributedRevenue != 300 || result.Currency != "USD" || result.RevenueStatus != "single_currency" {
		t.Fatalf("goal results = %+v, want two valid conversions for two sent recipients", result)
	}

	// Different currencies are not additive. The report must not label a
	// USD+EUR sum with whichever currency happens to be first in the query.
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO conversions (tenant_id, subscriber_email, event_name, amount_cents, currency, campaign_id, occurred_at)
VALUES ($1::uuid, 'first@example.test', 'purchase', 100, 'EUR', $2::uuid, $3)`,
		tenantID, campaignID, first.Add(50*time.Minute)); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	mixedRecorder := httptest.NewRecorder()
	(&Deps{Repo: &Repo{Pool: pool}}).goalResults(mixedRecorder, request)
	if mixedRecorder.Code != http.StatusOK {
		t.Fatalf("mixed status=%d body=%s", mixedRecorder.Code, mixedRecorder.Body.String())
	}
	result = GoalResults{}
	if err := json.Unmarshal(mixedRecorder.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.ConversionCount != 3 || result.ConvertedRecipients != 1 || result.ConversionRate != 0.5 || result.AttributedRevenue != 0 || result.Currency != "" || result.RevenueStatus != "mixed_currency" {
		t.Fatalf("mixed revenue was silently added: %+v", result)
	}
}

func goalEmail(value string) *string { return &value }
