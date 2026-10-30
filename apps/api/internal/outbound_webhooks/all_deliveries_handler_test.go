// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestSearchDeliveriesRejectsMalformedFiltersBeforeDatabaseAccess(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		query string
		code  string
	}{
		{name: "status", query: "?status=failed", code: "invalid_status"},
		{name: "webhook id", query: "?webhook_id=not-a-uuid", code: "invalid_webhook_id"},
		{name: "since", query: "?since=yesterday", code: "invalid_since"},
		{name: "limit low", query: "?limit=0", code: "invalid_limit"},
		{name: "limit high", query: "?limit=501", code: "invalid_limit"},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			ctx := middleware.WithTenant(
				context.Background(),
				&middleware.Tenant{ID: "00000000-0000-4000-8000-000000000001"},
			)
			req := httptest.NewRequestWithContext(
				ctx,
				http.MethodGet,
				"/api/v1/outbound-webhooks/deliveries/search"+test.query,
				nil,
			)
			rec := httptest.NewRecorder()
			(&Deps{Store: &Store{}}).SearchDeliveries(rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), test.code) {
				t.Fatalf("body %q missing %q", rec.Body.String(), test.code)
			}
		})
	}
}

func TestAllDeliveriesRejectsMalformedFiltersBeforeDatabaseAccess(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name  string
		query string
		code  string
	}{
		{name: "status", query: "?status=failed", code: "invalid_status"},
		{name: "limit", query: "?limit=1000", code: "invalid_limit"},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			ctx := middleware.WithTenant(
				context.Background(),
				&middleware.Tenant{ID: "00000000-0000-4000-8000-000000000001"},
			)
			req := httptest.NewRequestWithContext(
				ctx,
				http.MethodGet,
				"/api/v1/outbound-webhooks/deliveries"+test.query,
				nil,
			)
			rec := httptest.NewRecorder()
			(&Deps{Store: &Store{}}).AllDeliveries(rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), test.code) {
				t.Fatalf("body %q missing %q", rec.Body.String(), test.code)
			}
		})
	}
}

func TestUnifiedDeliveryReadSurfacePrivacyAndStatusContracts(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile("all_deliveries_handler.go")
	if err != nil {
		t.Fatalf("read unified delivery handler: %v", err)
	}
	source := string(raw)
	for _, contract := range []string{
		"apikeys.RequireScope(apikeys.ScopeAdmin)",
		"w.id = d.webhook_id AND w.tenant_id = d.tenant_id",
		"u.WebhookURL = destinationDisplay(u.WebhookURL)",
		"s.WebhookURL = destinationDisplay(s.WebhookURL)",
		"d.status = 'exhausted'",
		"d.status = 'pending' AND d.last_error IS NOT NULL",
		"d.status = 'skipped'",
		"if err := rows.Err(); err != nil",
		"if err := tx.Commit(r.Context()); err != nil",
	} {
		if !strings.Contains(source, contract) {
			t.Errorf("unified delivery contract missing %q", contract)
		}
	}
	if strings.Contains(source, "d.status = 'failed'") {
		t.Error("delivery aggregate still counts an unwritten 'failed' status")
	}
}
