package analytics

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// pct() is the only pure function in the SequenceFunnel pipeline; it
// drives every percentage in the JSON response so a regression here
// shows up directly in the dashboard.
func TestPct(t *testing.T) {
	cases := []struct {
		num, denom int
		want       float64
	}{
		{0, 0, 0},     // empty cohort: no division-by-zero
		{0, 100, 0},   // no events: 0%
		{50, 100, 50}, // round half
		{100, 100, 100},
		{1, 3, 33.333333333333336}, // float
		{5, -1, 0},                 // defensive: negative denom returns 0
	}
	for _, tc := range cases {
		got := pct(tc.num, tc.denom)
		if math.Abs(got-tc.want) > 1e-9 {
			t.Errorf("pct(%d,%d) = %v, want %v", tc.num, tc.denom, got, tc.want)
		}
	}
}

func TestSequenceFunnel_NoTenantReturns401(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/voice/sequences/abc/funnel", nil)
	rec := httptest.NewRecorder()
	d.SequenceFunnel(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "no_tenant") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestSequenceFunnel_MissingIDReturns400(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{
		ID:   "00000000-0000-0000-0000-000000000001",
		Slug: "test",
	})
	// Empty {id} via a chi RouteContext.
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", "")
	ctx = context.WithValue(ctx, chi.RouteCtxKey, rctx)
	req := httptest.NewRequestWithContext(ctx, http.MethodGet,
		"/api/v1/voice/sequences//funnel", nil)
	rec := httptest.NewRecorder()
	d.SequenceFunnel(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "missing_id") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// SUB-128: subscriber cohort funnel.

func TestSubscriberFunnel_NoTenantReturns401(t *testing.T) {
	d := &ExtendedDeps{Service: &Service{Pool: nil}}
	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/analytics/subscribers/funnel", nil)
	rec := httptest.NewRecorder()
	d.SubscriberFunnel(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "no_tenant") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestSubscriberFunnel_BadBucketReturns400(t *testing.T) {
	// An unsupported bucket is rejected by the service BEFORE any DB I/O,
	// so a nil pool is fine — the validation error surfaces as a 400.
	d := &ExtendedDeps{Service: &Service{Pool: nil}}
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{
		ID:   "00000000-0000-0000-0000-000000000001",
		Slug: "test",
	})
	req := httptest.NewRequestWithContext(ctx, http.MethodGet,
		"/api/v1/analytics/subscribers/funnel?bucket=week", nil)
	rec := httptest.NewRecorder()
	d.SubscriberFunnel(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "validation_failed") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestSubscriberFunnel_BadCohortByReturns400(t *testing.T) {
	d := &ExtendedDeps{Service: &Service{Pool: nil}}
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{
		ID:   "00000000-0000-0000-0000-000000000001",
		Slug: "test",
	})
	req := httptest.NewRequestWithContext(ctx, http.MethodGet,
		"/api/v1/analytics/subscribers/funnel?cohort_by=signup_week", nil)
	rec := httptest.NewRecorder()
	d.SubscriberFunnel(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body=%s", rec.Code, rec.Body.String())
	}
}

// TestSubscriberFunnel_JSONShape pins the wire shape the CohortFunnelCard
// frontend reads directly: cohort rows carry the four counts + two derived
// rates, and the aggregate steps carry stable stage keys + labels.
func TestSubscriberFunnel_JSONShape(t *testing.T) {
	sf := SubscriberFunnel{
		Bucket:   "month",
		CohortBy: "created_at_month",
		Steps: []SubscriberFunnelStep{
			{Stage: "signup", Label: "Signed Up", Count: 100, ConversionRate: 100},
			{Stage: "first_purchase", Label: "First Purchase", Count: 40, ConversionRate: 40},
			{Stage: "repeat_purchase", Label: "Repeat Purchase", Count: 10, ConversionRate: 25},
		},
		Cohorts: []CohortFunnelRow{
			{
				CohortLabel:         "2026-05",
				SignupCount:         100,
				FirstPurchaseCount:  40,
				RepeatPurchaseCount: 10,
				FirstPurchaseRate:   40,
				RepeatPurchaseRate:  25,
			},
		},
	}
	b, err := json.Marshal(sf)
	if err != nil {
		t.Fatal(err)
	}
	got := string(b)
	want := []string{
		`"bucket":"month"`,
		`"cohort_by":"created_at_month"`,
		`"stage":"signup"`,
		`"label":"Signed Up"`,
		`"conversion_rate":100`,
		`"cohort_label":"2026-05"`,
		`"signup_count":100`,
		`"first_purchase_count":40`,
		`"repeat_purchase_count":10`,
		`"first_purchase_rate":40`,
		`"repeat_purchase_rate":25`,
	}
	for _, w := range want {
		if !strings.Contains(got, w) {
			t.Errorf("missing %q in %s", w, got)
		}
	}
}

func TestFunnelStep_JSONShape(t *testing.T) {
	// Ensure the JSON wire shape stays stable; the web dashboard
	// reads these field names directly.
	s := FunnelStep{
		Position:   2,
		Reached:    100,
		Opened:     40,
		Clicked:    20,
		OpenRate:   40,
		ClickRate:  20,
		DropoffPct: 50,
	}
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		`"position":2`,
		`"reached":100`,
		`"opened":40`,
		`"clicked":20`,
		`"open_rate":40`,
		`"click_rate":20`,
		`"dropoff_pct":50`,
	}
	got := string(b)
	for _, w := range want {
		if !strings.Contains(got, w) {
			t.Errorf("missing %q in %s", w, got)
		}
	}
}
