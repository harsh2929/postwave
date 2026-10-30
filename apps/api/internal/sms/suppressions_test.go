// SPDX-License-Identifier: AGPL-3.0-only

package sms

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestSuppressionListPredicateUsesIndexableExactFilters(t *testing.T) {
	snapshot := time.Date(2026, 8, 28, 0, 0, 0, 0, time.UTC)
	tests := []struct {
		name, reason, phone string
		want                []string
		wantArgs            int
	}{
		{"browse", "", "", []string{"tenant_id = $1::uuid", "created_at <= $2"}, 2},
		{"reason", "manual", "", []string{"reason = $3"}, 3},
		{"exact phone", "", "+14155551212", []string{"phone_e164 = $3"}, 3},
		{"reason and phone", "manual", "+14155551212", []string{"reason = $3", "phone_e164 = $4"}, 4},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			where, args := suppressionListPredicate(suppressionTestTenant, tc.reason, tc.phone, snapshot)
			if strings.Contains(where, " OR reason") || strings.Contains(where, " OR phone_e164") {
				t.Fatalf("optional filters retained generic-plan OR predicates: %s", where)
			}
			for _, want := range tc.want {
				if !strings.Contains(where, want) {
					t.Fatalf("predicate %q missing %q", where, want)
				}
			}
			if len(args) != tc.wantArgs || args[0] != suppressionTestTenant || args[1] != snapshot {
				t.Fatalf("predicate args = %#v, want tenant/snapshot + %d filters", args, tc.wantArgs-2)
			}
		})
	}
}

func TestSuppressionExactQueryReplayBypassIsMethodAndCanonicalPathExact(t *testing.T) {
	tests := []struct {
		method string
		path   string
		want   bool
	}{
		{http.MethodPost, "/api/v1/sms/suppressions/query", true},
		{http.MethodPost, "/api/v1/sms/suppressions/query?reason=manual", true},
		{http.MethodGet, "/api/v1/sms/suppressions/query", false},
		{http.MethodPost, "/api/v1/sms/suppressions", false},
		{http.MethodPost, "/api/v1/sms/suppressions/query/", false},
		{http.MethodPost, "/api/v1/sms/suppressions/query/extra", false},
		{http.MethodPost, "/api/v1/sms/suppressions%2Fquery", false},
	}
	for _, test := range tests {
		req := httptest.NewRequest(test.method, test.path, nil)
		if got := SuppressionExactQueryReplayBypass(req, nil); got != test.want {
			t.Errorf("%s %s bypass=%t, want %t", test.method, test.path, got, test.want)
		}
	}
}

const suppressionTestTenant = "33333333-3333-4333-8333-333333333333"

func suppressionRequest(t *testing.T, method, target, body string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: suppressionTestTenant}))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	return req
}

func withSMSRouteParam(req *http.Request, key, value string) *http.Request {
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add(key, value)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeContext))
}

func TestCanonicalTenantUUIDAcceptsLegacyVersionsButNotAliases(t *testing.T) {
	for _, value := range []string{
		"33333333-3333-4333-8333-333333333333", // v4
		"11111111-1111-1111-8111-111111111111", // canonical non-v4 legacy tenant
		"00000000-0000-0000-0000-000000000000", // PostgreSQL's canonical nil UUID
	} {
		if !validCanonicalTenantUUID(value) {
			t.Fatalf("canonical tenant UUID %q rejected", value)
		}
	}
	for _, value := range []string{
		"", "tenant", "33333333-3333-4333-8333-33333333333",
		"33333333-3333-4333-8333-333333333333 ",
		"33333333-3333-4333-8333-333333333333"[:35],
		"33333333-3333-4333-8333-33333333333A",
	} {
		if validCanonicalTenantUUID(value) {
			t.Fatalf("non-canonical tenant UUID %q accepted", value)
		}
	}
}

func TestListSuppressionsRejectsSensitiveAndHostileQueryBeforeDatabase(t *testing.T) {
	d := &Deps{}
	tests := []struct {
		name     string
		rawQuery string
		code     string
	}{
		{"phone", "phone=%2B14155551212", "sensitive_filter_requires_body"},
		{"empty phone", "phone=", "sensitive_filter_requires_body"},
		{"malformed escape", "%ZZ=1", "invalid_query"},
		{"semicolon", "reason=manual;limit=1", "invalid_query"},
		{"duplicate", "reason=manual&reason=manual", "invalid_query"},
		{"unknown", "search=manual", "invalid_query"},
		{"empty reason", "reason=", "invalid_reason"},
		{"padded reason", "reason=%20manual", "invalid_reason"},
		{"empty limit", "limit=", "invalid_limit"},
		{"empty cursor", "cursor=", "invalid_cursor"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := suppressionRequest(t, http.MethodGet, "/api/v1/sms/suppressions", "")
			req.URL.RawQuery = tc.rawQuery
			rec := httptest.NewRecorder()
			d.ListSuppressions(rec, req)
			if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"`+tc.code+`"`) {
				t.Fatalf("status/body = %d %s, want 400/%s", rec.Code, rec.Body.String(), tc.code)
			}
		})
	}
}

func TestQuerySuppressionsIsStrictBodyReadAndRejectsURLQuery(t *testing.T) {
	d := &Deps{}
	tests := []struct {
		name   string
		target string
		body   string
		code   string
	}{
		{"URL query", "/api/v1/sms/suppressions/query?phone=x", `{"phone":"+14155551212"}`, "invalid_query"},
		{"missing phone", "/api/v1/sms/suppressions/query", `{}`, "invalid_phone"},
		{"invalid phone", "/api/v1/sms/suppressions/query", `{"phone":"%2B1415"}`, "invalid_phone"},
		{"unknown field", "/api/v1/sms/suppressions/query", `{"phone":"+14155551212","search":"x"}`, "unknown_field"},
		{"empty reason", "/api/v1/sms/suppressions/query", `{"phone":"+14155551212","reason":""}`, "invalid_reason"},
		{"padded reason", "/api/v1/sms/suppressions/query", `{"phone":"+14155551212","reason":" manual"}`, "invalid_reason"},
		{"cursor is not part of exact lookup", "/api/v1/sms/suppressions/query", `{"phone":"+14155551212","cursor":"opaque"}`, "unknown_field"},
		{"limit is not part of exact lookup", "/api/v1/sms/suppressions/query", `{"phone":"+14155551212","limit":1}`, "unknown_field"},
		{"trailing value", "/api/v1/sms/suppressions/query", `{"phone":"+14155551212"}{}`, "multiple_json_values"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := suppressionRequest(t, http.MethodPost, tc.target, tc.body)
			rec := httptest.NewRecorder()
			d.QuerySuppressions(rec, req)
			if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), tc.code) {
				t.Fatalf("status/body = %d %s, want 400/%s", rec.Code, rec.Body.String(), tc.code)
			}
		})
	}
}

func TestSuppressionMutationsRejectAmbiguousInputsBeforeDatabase(t *testing.T) {
	d := &Deps{}

	req := suppressionRequest(t, http.MethodPost, "/api/v1/sms/suppressions?reason=manual", `{"phone":"+14155551212","reason":"manual"}`)
	rec := httptest.NewRecorder()
	d.AddSuppression(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_query") {
		t.Fatalf("add query status/body = %d %s", rec.Code, rec.Body.String())
	}

	req = suppressionRequest(t, http.MethodPost, "/api/v1/sms/suppressions", `{"phone":"+14155551212"}`)
	rec = httptest.NewRecorder()
	d.AddSuppression(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_reason") {
		t.Fatalf("missing add reason status/body = %d %s", rec.Code, rec.Body.String())
	}

	req = suppressionRequest(t, http.MethodPost, "/api/v1/sms/suppressions", `{"phone":"+14155551212","reason":" manual"}`)
	rec = httptest.NewRecorder()
	d.AddSuppression(rec, req)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "system_suppression_authority_required") {
		t.Fatalf("padded add reason status/body = %d %s", rec.Code, rec.Body.String())
	}

	for _, id := range []string{"not-a-uuid", "11111111-1111-1111-8111-111111111111", "33333333-3333-4333-8333-33333333333A"} {
		req = suppressionRequest(t, http.MethodDelete, "/api/v1/sms/suppressions/"+id, "")
		req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: suppressionTestTenant}))
		// These unit tests call the handler directly, so populate the chi path
		// parameter exactly as the mounted router would.
		req = withSMSRouteParam(req, "id", id)
		rec = httptest.NewRecorder()
		d.RemoveSuppression(rec, req)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_suppression_id") {
			t.Fatalf("id %q status/body = %d %s", id, rec.Code, rec.Body.String())
		}
	}
}
