// SPDX-License-Identifier: AGPL-3.0-only
package subscription_integrations

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeBoldSecretResolver struct{ json string }

func (f fakeBoldSecretResolver) Get(_ context.Context, _ string) (string, error) { return f.json, nil }
func (f fakeBoldSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*boldCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestBoldBackfillMapsSubscriptions(t *testing.T) {
	var gotPath, gotAuth, gotVersion, gotExpand string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotVersion = r.Header.Get("Bold-API-Version-Date")
		gotExpand = r.URL.Query().Get("expand")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": map[string]any{
				"subscriptions": []map[string]any{
					{"id": "sub_9", "status": "active", "next_order_datetime": "2026-07-01T00:00:00Z",
						"customer": map[string]any{"email": "Ada@Example.com", "first_name": "Ada", "last_name": "L"}},
				},
			},
			"meta": map[string]any{"pagination": map[string]any{"total_pages": 2, "current_page": 1}},
		})
	}))
	defer srv.Close()

	backfiller := BoldRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: BoldSecretsCredentialResolver{Secrets: fakeBoldSecretResolver{json: `{"access_token":"bold.tok","shop_identifier":"myshop"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderBoldSubscriptions, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !strings.Contains(gotPath, "/shops/myshop/subscriptions") || gotAuth != "Bearer bold.tok" || gotVersion == "" || gotExpand != "customer" {
		t.Fatalf("path=%q auth=%q version=%q expand=%q", gotPath, gotAuth, gotVersion, gotExpand)
	}
	if len(req.Subscriptions) != 1 {
		t.Fatalf("subscriptions = %d", len(req.Subscriptions))
	}
	s := req.Subscriptions[0]
	if s.Email != "ada@example.com" || s.Status != "active" || s.SubscriptionID != "sub_9" {
		t.Fatalf("mapped = %+v", s)
	}
	if s.SourceID != "bold-subscriptions://subscription/sub_9" {
		t.Fatalf("source id = %q", s.SourceID)
	}
	if s.NextChargeAt == nil {
		t.Fatal("next_order_datetime not parsed")
	}
	if req.Cursor != "bold:2" {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

func TestBoldProviderSpecRequiresRuntimeShopIdentifier(t *testing.T) {
	spec, ok := ProviderSpecByKey(ProviderBoldSubscriptions)
	if !ok {
		t.Fatal("missing Bold provider spec")
	}
	if !providerHasField(spec.RequiredSettings, "shop_identifier") {
		t.Fatalf("Bold provider spec must require shop_identifier for runtime path routing: %+v", spec.RequiredSettings)
	}
	if providerHasField(spec.RequiredSettings, "store_domain") {
		t.Fatalf("store_domain should be optional context, not the runtime-required identifier: %+v", spec.RequiredSettings)
	}
}

func providerHasField(fields []ProviderField, key string) bool {
	for _, field := range fields {
		if field.Key == key {
			return true
		}
	}
	return false
}
