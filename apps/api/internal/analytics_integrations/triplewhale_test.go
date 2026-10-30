// SPDX-License-Identifier: AGPL-3.0-only
package analytics_integrations

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeTripleWhaleSecretResolver struct{ json string }

func (f fakeTripleWhaleSecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakeTripleWhaleSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*tripleWhaleCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errAnalyticsNotJSONSecret
}

func TestTripleWhaleBackfillMapsCustomers(t *testing.T) {
	var gotMethod, gotPath, gotAPIKey, gotAuth, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotAPIKey = r.Header.Get("x-api-key")
		gotAuth = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		if strings.Contains(gotBody, "OFFSET 1") {
			_, _ = w.Write([]byte(`[]`))
			return
		}
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{"email": "Bo@Example.com", "firstName": "Bo", "lastName": "R", "totalSpent": 240.5, "ordersCount": 3},
		})
	}))
	defer srv.Close()

	backfiller := TripleWhaleRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: TripleWhaleSecretsCredentialResolver{Secrets: fakeTripleWhaleSecretResolver{json: `{"api_key":"tw_key","shop_id":"acme.example.com"}`}},
		APIBaseURL:  srv.URL,
	}
	integration := Integration{Provider: ProviderTripleWhale, CredentialsRef: "c", Settings: map[string]any{"start_date": "2026-01-01", "end_date": "2026-06-20", "page_size": "1"}}
	req, err := backfiller.BackfillPage(context.Background(), "t", integration, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if gotMethod != http.MethodPost || gotAPIKey != "tw_key" || gotAuth != "" || !strings.Contains(gotBody, "2026-01-01") {
		t.Fatalf("method=%q api_key=%q auth=%q body=%q", gotMethod, gotAPIKey, gotAuth, gotBody)
	}
	if gotPath != "/api/v2/orcabase/api/sql" {
		t.Fatalf("path = %q", gotPath)
	}
	var payload struct {
		ShopID string `json:"shopId"`
		Query  string `json:"query"`
	}
	if err := json.Unmarshal([]byte(gotBody), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.ShopID != "acme.example.com" || !strings.Contains(payload.Query, "FROM customers_table ORDER BY email_address, customer_id, platform LIMIT 1 OFFSET 0") {
		t.Fatalf("unexpected SQL request: %+v", payload)
	}
	if len(req.Profiles) != 1 {
		t.Fatalf("profiles = %d", len(req.Profiles))
	}
	p := req.Profiles[0]
	if p.Email != "bo@example.com" || p.FirstName != "Bo" {
		t.Fatalf("mapped = %+v", p)
	}
	if p.SourceID != "triplewhale://customer/bo@example.com" {
		t.Fatalf("source id = %q", p.SourceID)
	}
	if req.Cursor != "triplewhale:2" {
		t.Fatalf("cursor = %q", req.Cursor)
	}
	if p.Traits["triplewhale_total_spent"] != "240.5" || p.Traits["triplewhale_orders_count"] != "3" {
		t.Fatalf("traits = %+v", p.Traits)
	}
	next, err := backfiller.BackfillPage(context.Background(), "t", integration, req.Cursor)
	if err != nil || len(next.Profiles) != 0 || next.Cursor != tripleWhaleCursorComplete {
		t.Fatalf("empty final page: req=%+v err=%v", next, err)
	}
}

func TestTripleWhaleSQLRequiresShopAndAcceptsSettingsFallback(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["shopId"] != "acme.example.com" {
			t.Errorf("shopId = %v", body["shopId"])
		}
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()
	b := TripleWhaleRESTBackfiller{HTTPClient: srv.Client(), APIBaseURL: srv.URL, Credentials: TripleWhaleSecretsCredentialResolver{Secrets: fakeTripleWhaleSecretResolver{json: `{"api_key":"tw_key"}`}}}
	integration := Integration{Provider: ProviderTripleWhale, CredentialsRef: "c"}
	if _, err := b.BackfillPage(context.Background(), "t", integration, ""); err == nil || !strings.Contains(err.Error(), "shop_id is required") || calls != 0 {
		t.Fatalf("missing shop must fail before HTTP: calls=%d err=%v", calls, err)
	}
	integration.Settings = map[string]any{"shop_domain": "acme.example.com"}
	req, err := b.BackfillPage(context.Background(), "t", integration, "")
	if err != nil || req.Cursor != tripleWhaleCursorComplete || calls != 1 {
		t.Fatalf("shop_domain fallback: calls=%d cursor=%q err=%v", calls, req.Cursor, err)
	}
}

func TestTripleWhaleExplicitEndpointKeepsLegacyResponseContract(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/certified-customers" || r.Header.Get("x-api-key") != "tw_key" {
			t.Errorf("unexpected request path=%q", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"customers":[{"email":"qa@example.com"}],"hasNextPage":false}`))
	}))
	defer srv.Close()
	b := TripleWhaleRESTBackfiller{HTTPClient: srv.Client(), APIBaseURL: srv.URL, Credentials: TripleWhaleSecretsCredentialResolver{Secrets: fakeTripleWhaleSecretResolver{json: `{"api_key":"tw_key"}`}}}
	req, err := b.BackfillPage(context.Background(), "t", Integration{Provider: ProviderTripleWhale, CredentialsRef: "c", Settings: map[string]any{"endpoint": "/certified-customers"}}, "")
	if err != nil || len(req.Profiles) != 1 || req.Cursor != tripleWhaleCursorComplete {
		t.Fatalf("custom endpoint: req=%+v err=%v", req, err)
	}
}

func TestTripleWhaleCustomShopIDKeepsDestinationRestrictions(t *testing.T) {
	input := IntegrationInput{Provider: ProviderTripleWhale, CredentialsRef: "cred_triple_whale_qa", Settings: map[string]any{"shop_id": "moosewave.com"}}
	normalized, _, err := normalizeIntegrationInput(input)
	if err != nil {
		t.Fatalf("custom shop identifier should not be treated as a network destination: %v", err)
	}
	cleanup := analyticsDisconnectCleanupEvidence(Integration{Provider: ProviderTripleWhale, Settings: normalized.Settings}, time.Now())
	if cleanup["provider_scope_id"] != "moosewave.com" {
		t.Fatalf("cleanup did not identify the configured shop: %+v", cleanup)
	}
	// Plain HTTP loopback is explicitly allowed only in Go test binaries for
	// httptest servers. HTTPS loopback and unrelated public hosts remain denied.
	for _, destination := range []string{"https://127.0.0.1:8080", "https://untrusted.example.com"} {
		input.Settings["api_base_url"] = destination
		if _, _, err := normalizeIntegrationInput(input); err == nil {
			t.Fatalf("shop metadata must not allow a different API destination: %s", destination)
		}
	}
}

func TestTripleWhaleRejectsConflictingShopScopeBeforeHTTP(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()
	b := TripleWhaleRESTBackfiller{HTTPClient: srv.Client(), APIBaseURL: srv.URL, Credentials: TripleWhaleSecretsCredentialResolver{Secrets: fakeTripleWhaleSecretResolver{json: `{"api_key":"tw_key","shop_id":"actual.example.com"}`}}}
	_, err := b.BackfillPage(context.Background(), "t", Integration{Provider: ProviderTripleWhale, CredentialsRef: "c", Settings: map[string]any{"shop_id": "different.example.com"}}, "")
	if err == nil || calls != 0 || !strings.Contains(err.Error(), "do not match") {
		t.Fatalf("conflicting audit and API scope must fail before HTTP: calls=%d err=%v", calls, err)
	}
}
