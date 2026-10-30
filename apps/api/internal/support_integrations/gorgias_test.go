// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeGorgiasSecretResolver struct{ json string }

func (f fakeGorgiasSecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakeGorgiasSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*gorgiasCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestGorgiasBackfillMapsTickets(t *testing.T) {
	var gotPath, gotAuth, gotCursor, gotLimit string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotCursor = r.URL.Query().Get("cursor")
		gotLimit = r.URL.Query().Get("limit")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{
				{"id": 501, "subject": "Where is my order", "status": "open", "priority": "normal",
					"tags": []map[string]any{{"name": "shipping"}},
					"customer": map[string]any{"id": 9, "email": "Ada@Example.com", "name": "Ada L", "integrations": map[string]any{
						"shopify": map[string]any{
							"access_token": "must-not-copy",
							"customer":     map[string]any{"id": "gid://shopify/Customer/88"},
							"orders": []map[string]any{{
								"id":                 "gid://shopify/Order/1001",
								"name":               "#1001",
								"financial_status":   "paid",
								"fulfillment_status": "fulfilled",
								"total_price":        "125.50",
								"currency":           "USD",
								"line_items": []map[string]any{{
									"product_id": "77",
									"variant_id": "88",
									"sku":        "SKU-77",
								}},
							}},
						},
						"recharge": map[string]any{
							"subscriptions": []map[string]any{{"id": "sub_123", "status": "active"}},
						},
					}},
					"updated_datetime": "2026-06-20T10:00:00Z"},
			},
			"meta": map[string]any{"next_cursor": "CUR2"},
		})
	}))
	defer srv.Close()

	backfiller := GorgiasRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: GorgiasSecretsCredentialResolver{Secrets: fakeGorgiasSecretResolver{json: `{"email":"ops@acme.com","api_key":"gk"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderGorgias, CredentialsRef: "c", Settings: map[string]any{"page_size": 500}}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("ops@acme.com:gk"))
	if !strings.Contains(gotPath, "/api/tickets") || gotAuth != wantAuth || gotCursor != "" || gotLimit != "100" {
		t.Fatalf("path=%q auth=%q cursor=%q limit=%q", gotPath, gotAuth, gotCursor, gotLimit)
	}
	if len(req.Tickets) != 1 {
		t.Fatalf("tickets = %d", len(req.Tickets))
	}
	tk := req.Tickets[0]
	if tk.Email != "ada@example.com" || tk.Subject != "Where is my order" || tk.Status != "open" {
		t.Fatalf("mapped ticket = %+v", tk)
	}
	if tk.SourceID != "gorgias://ticket/501" || tk.ConversationID != "501" {
		t.Fatalf("source id = %q conv = %q", tk.SourceID, tk.ConversationID)
	}
	if tk.Properties["shopify_order_id"] != "gid://shopify/Order/1001" ||
		tk.Properties["order_number"] != "#1001" ||
		tk.Properties["order_financial_status"] != "paid" ||
		tk.Properties["order_total"] != "125.50" ||
		tk.Properties["order_currency"] != "USD" ||
		tk.Properties["shopify_customer_id"] != "gid://shopify/Customer/88" ||
		tk.Properties["recharge_subscription_id"] != "sub_123" ||
		tk.Properties["recharge_subscription_status"] != "active" ||
		tk.Properties["gorgias_commerce_context_present"] != true {
		t.Fatalf("commerce properties = %+v", tk.Properties)
	}
	if !stringSlicePropertyContains(t, tk.Properties, "product_source_candidates", "gid://shopify/Product/77") ||
		!stringSlicePropertyContains(t, tk.Properties, "variant_source_candidates", "gid://shopify/ProductVariant/88") ||
		!stringSlicePropertyContains(t, tk.Properties, "product_sku_candidates", "sku-77") {
		t.Fatalf("commerce candidate properties = %+v", tk.Properties)
	}
	if _, ok := tk.Properties["access_token"]; ok {
		t.Fatalf("commerce properties must not copy raw credentials: %+v", tk.Properties)
	}
	if req.Cursor != "gorgias:CUR2" {
		t.Fatalf("next cursor = %q", req.Cursor)
	}
}

func TestGorgiasTicketWithoutCommerceDoesNotInventOrderEvidence(t *testing.T) {
	var tk gorgiasTicket
	if err := json.Unmarshal([]byte(`{"id":501,"subject":"Plain support ticket","status":"open","priority":"normal","customer":{"email":"Ada@Example.com","name":"Ada L"},"updated_datetime":"2026-06-20T10:00:00Z"}`), &tk); err != nil {
		t.Fatalf("unmarshal ticket: %v", err)
	}
	out, ok := mapGorgiasTicket(tk)
	if !ok {
		t.Fatal("expected ticket to map")
	}
	if out.Properties["gorgias_ticket_id"] != "501" {
		t.Fatalf("ticket properties = %+v", out.Properties)
	}
	for _, key := range []string{"gorgias_commerce_context_present", "external_order_id", "order_status", "shopify_order_id"} {
		if _, exists := out.Properties[key]; exists {
			t.Fatalf("plain ticket must not include commerce evidence key %q: %+v", key, out.Properties)
		}
	}
}

func stringSlicePropertyContains(t *testing.T, props map[string]any, key, needle string) bool {
	t.Helper()
	values, ok := props[key].([]string)
	if !ok {
		t.Fatalf("%s = %T(%v), want []string", key, props[key], props[key])
	}
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

func TestGorgiasRefreshTicketMapsSingleTicket(t *testing.T) {
	var gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id":       501,
			"subject":  "Where is my order",
			"status":   "open",
			"priority": "normal",
			"tags":     []map[string]any{{"name": "shipping"}},
			"customer": map[string]any{"id": 9, "email": "Ada@Example.com", "name": "Ada L"},
		})
	}))
	defer srv.Close()

	backfiller := GorgiasRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: GorgiasSecretsCredentialResolver{Secrets: fakeGorgiasSecretResolver{json: `{"email":"ops@acme.com","api_key":"gk"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.RefreshTicket(context.Background(), "tenant-1", Integration{Provider: ProviderGorgias, CredentialsRef: "c"}, "501")
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("ops@acme.com:gk"))
	if gotPath != "/api/tickets/501" || gotAuth != wantAuth {
		t.Fatalf("path=%q auth=%q", gotPath, gotAuth)
	}
	if req.RunMode != "webhook" || req.Cursor != "gorgias-refresh-501" || len(req.Tickets) != 1 {
		t.Fatalf("request=%+v", req)
	}
	tk := req.Tickets[0]
	if tk.SourceID != "gorgias://ticket/501" || tk.Email != "ada@example.com" || tk.Subject != "Where is my order" {
		t.Fatalf("ticket=%+v", tk)
	}
}

func TestGorgiasDeleteHTTPIntegrationUsesBasicAuth(t *testing.T) {
	var gotMethod, gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	backfiller := GorgiasRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: GorgiasSecretsCredentialResolver{Secrets: fakeGorgiasSecretResolver{json: `{"email":"ops@acme.com","api_key":"gk"}`}},
		APIBaseURL:  srv.URL,
	}
	out, err := backfiller.DeleteGorgiasHTTPIntegration(context.Background(), "tenant-1", Integration{Provider: ProviderGorgias, CredentialsRef: "c"}, "http_123")
	if err != nil {
		t.Fatalf("delete integration: %v", err)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("ops@acme.com:gk"))
	if gotMethod != http.MethodDelete || gotPath != "/api/integrations/http_123" || gotAuth != wantAuth {
		t.Fatalf("method=%q path=%q auth=%q", gotMethod, gotPath, gotAuth)
	}
	if out.IntegrationID != "http_123" || out.Status != "deleted" || out.ProviderStatusCode != http.StatusNoContent {
		t.Fatalf("cleanup result=%+v", out)
	}
}

func TestGorgiasDeleteHTTPIntegrationTreatsNotFoundAsAlreadyAbsent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"missing"}`))
	}))
	defer srv.Close()

	backfiller := GorgiasRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: GorgiasSecretsCredentialResolver{Secrets: fakeGorgiasSecretResolver{json: `{"email":"ops@acme.com","api_key":"gk"}`}},
		APIBaseURL:  srv.URL,
	}
	out, err := backfiller.DeleteGorgiasHTTPIntegration(context.Background(), "tenant-1", Integration{Provider: ProviderGorgias, CredentialsRef: "c"}, "http_123")
	if err != nil {
		t.Fatalf("delete integration should treat 404 as clean: %v", err)
	}
	if out.Status != "already_absent" || out.ProviderStatusCode != http.StatusNotFound {
		t.Fatalf("cleanup result=%+v", out)
	}
}

func TestGorgiasCredentialResolverUsesAccountDomainSetting(t *testing.T) {
	resolver := GorgiasSecretsCredentialResolver{Secrets: fakeGorgiasSecretResolver{json: `{"email":"ops@acme.com","api_key":"gk"}`}}
	creds, err := resolver.ResolveGorgias(context.Background(), "tenant-1", Integration{
		Provider:       ProviderGorgias,
		CredentialsRef: "c",
		Settings:       map[string]any{"account_domain": "acme.gorgias.com"},
	})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got := gorgiasBaseURL("", creds); got != "https://acme.gorgias.com" {
		t.Fatalf("base URL = %q", got)
	}
}

func TestGorgiasBackfillCompleteCursorStops(t *testing.T) {
	backfiller := GorgiasRESTBackfiller{
		Credentials: GorgiasSecretsCredentialResolver{Secrets: fakeGorgiasSecretResolver{json: `{"email":"a@b.com","api_key":"k"}`}},
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderGorgias, CredentialsRef: "c"}, gorgiasCursorComplete)
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if len(req.Tickets) != 0 || req.Cursor != gorgiasCursorComplete {
		t.Fatalf("complete cursor should short-circuit, got %+v", req)
	}
}
