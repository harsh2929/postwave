// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestOutboundHealthReportsSkippedWithoutClassifyingItAsAnError(t *testing.T) {
	t.Parallel()

	payload, err := json.Marshal(OutboundHealth{DeliveriesTotal: 3, DeliveriesSkipped: 2})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(payload), `"deliveries_skipped":2`) {
		t.Fatalf("health payload does not expose skipped deliveries: %s", payload)
	}

	source, err := os.ReadFile("health.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(source), "status <> 'skipped'") {
		t.Fatal("top-error query must exclude tombstone-cancelled deliveries")
	}
}

func TestStatusBucket(t *testing.T) {
	cases := []struct {
		in  int
		out string
	}{
		{0, "error"},
		{200, "2xx"},
		{204, "2xx"},
		{301, "3xx"},
		{400, "4xx"},
		{404, "4xx"},
		{500, "5xx"},
		{599, "5xx"},
		{700, "error"},
		{-1, "error"},
	}
	for _, c := range cases {
		if got := statusBucket(c.in); got != c.out {
			t.Errorf("statusBucket(%d) = %q, want %q", c.in, got, c.out)
		}
	}
}

func TestPercentile(t *testing.T) {
	cases := []struct {
		name   string
		values []int
		p      float64
		want   int
	}{
		{"empty", []int{}, 0.50, 0},
		{"single", []int{42}, 0.50, 42},
		{"p0 returns min", []int{1, 5, 10}, 0, 1},
		{"p100 returns max", []int{1, 5, 10}, 1, 10},
		// 5 values, p50 → index 2 (middle).
		{"p50 of 5 odd-count", []int{1, 2, 3, 4, 5}, 0.50, 3},
		// 11 values, p50 → middle = 6. p90 ≈ index 9.
		{"p90 of 11", []int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100}, 0.90, 10},
		{"does not mutate input", []int{3, 1, 2}, 0.50, 2},
	}
	for _, c := range cases {
		// Snapshot input to verify no mutation.
		snap := append([]int(nil), c.values...)
		got := percentile(c.values, c.p)
		if got != c.want {
			t.Errorf("%s: percentile(%v, %v) = %d, want %d", c.name, c.values, c.p, got, c.want)
		}
		if len(c.values) > 0 && c.values[0] != snap[0] {
			t.Errorf("%s: input was mutated", c.name)
		}
	}
}

func TestHealthHandlerRejectsMissingTenant(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/outbound-webhooks/abc/health", nil)
	rec := httptest.NewRecorder()
	(&Deps{}).Health(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestHealthHandler503WhenStoreMissing(t *testing.T) {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "t1"})
	req := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/v1/outbound-webhooks/abc/health", nil)
	rec := httptest.NewRecorder()
	(&Deps{}).Health(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

func TestReEnableHandler503WhenStoreMissing(t *testing.T) {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "t1"})
	req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/v1/outbound-webhooks/abc/re-enable", nil)
	rec := httptest.NewRecorder()
	(&Deps{}).ReEnable(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

func TestReEnableHandlerRejectsMissingTenant(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/outbound-webhooks/abc/re-enable", nil)
	rec := httptest.NewRecorder()
	(&Deps{}).ReEnable(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}
