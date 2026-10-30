// SPDX-License-Identifier: AGPL-3.0-only
package subscription_integrations

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeChargebeeSecretResolver struct{ json string }

func (f fakeChargebeeSecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakeChargebeeSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*chargebeeCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestChargebeeBackfillMapsSubscriptions(t *testing.T) {
	var gotPath, gotAuth, gotOffset string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotOffset = r.URL.Query().Get("offset")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"list": []map[string]any{
				{
					"subscription": map[string]any{"id": "sub_1", "customer_id": "cus_1", "status": "active",
						"billing_period": 1, "billing_period_unit": "month", "next_billing_at": 1718880000, "plan_id": "tea-monthly"},
					"customer": map[string]any{"id": "cus_1", "email": "Ada@Example.com"},
				},
			},
			"next_offset": "OFF2",
		})
	}))
	defer srv.Close()

	backfiller := ChargebeeRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: ChargebeeSecretsCredentialResolver{Secrets: fakeChargebeeSecretResolver{json: `{"api_key":"cb_key"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderChargebee, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("cb_key:"))
	if !strings.Contains(gotPath, "/api/v2/subscriptions") || gotAuth != wantAuth || gotOffset != "" {
		t.Fatalf("path=%q auth=%q offset=%q", gotPath, gotAuth, gotOffset)
	}
	if len(req.Subscriptions) != 1 {
		t.Fatalf("subscriptions = %d", len(req.Subscriptions))
	}
	s := req.Subscriptions[0]
	if s.Email != "ada@example.com" || s.Status != "active" || s.SubscriptionID != "sub_1" || s.CustomerID != "cus_1" || s.ProductID != "tea-monthly" {
		t.Fatalf("mapped = %+v", s)
	}
	if s.SourceID != "chargebee://subscription/sub_1" {
		t.Fatalf("source id = %q", s.SourceID)
	}
	if s.NextChargeAt == nil {
		t.Fatal("next_billing_at epoch not parsed")
	}
	if req.Cursor != "chargebee:OFF2" {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

func TestChargebeeBackfillCompleteCursorStops(t *testing.T) {
	backfiller := ChargebeeRESTBackfiller{
		Credentials: ChargebeeSecretsCredentialResolver{Secrets: fakeChargebeeSecretResolver{json: `{"api_key":"k","site":"acme"}`}},
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderChargebee, CredentialsRef: "c"}, chargebeeCursorComplete)
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if len(req.Subscriptions) != 0 || req.Cursor != chargebeeCursorComplete {
		t.Fatalf("complete cursor should short-circuit, got %+v", req)
	}
}

func TestChargebeeUsesDocumentedSiteIDSetting(t *testing.T) {
	creds := withChargebeeSite(ChargebeeCredentials{APIKey: "cb_key"}, Integration{
		Provider: ProviderChargebee,
		Settings: map[string]any{"site_id": "acme-test"},
	})
	baseURL, err := chargebeeBaseURL("", creds)
	if err != nil {
		t.Fatalf("base url: %v", err)
	}
	if baseURL != "https://acme-test.chargebee.com" {
		t.Fatalf("base url = %q", baseURL)
	}
}
