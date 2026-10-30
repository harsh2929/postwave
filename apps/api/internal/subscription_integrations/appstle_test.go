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

type fakeAppstleSecretResolver struct{ json string }

func (f fakeAppstleSecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakeAppstleSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*appstleCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestAppstleBackfillMapsContracts(t *testing.T) {
	var gotPath, gotKey, gotPage string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotKey = r.Header.Get("X-API-Key")
		gotPage = r.URL.Query().Get("page")
		// Spring Pageable {content,...} envelope
		_ = json.NewEncoder(w).Encode(map[string]any{
			"content": []map[string]any{
				{"id": "123", "status": "ACTIVE", "customerEmail": "Ada@Example.com", "nextBillingDate": "2026-07-01T00:00:00Z"},
			},
			"totalPages": 2, "number": 0, "last": false,
		})
	}))
	defer srv.Close()

	backfiller := AppstleRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: AppstleSecretsCredentialResolver{Secrets: fakeAppstleSecretResolver{json: `{"api_key":"apst_key"}`}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderAppstle, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !strings.Contains(gotPath, "/subscription-contracts") || gotKey != "apst_key" || gotPage != "0" {
		t.Fatalf("path=%q key=%q page=%q", gotPath, gotKey, gotPage)
	}
	if len(req.Subscriptions) != 1 {
		t.Fatalf("subscriptions = %d", len(req.Subscriptions))
	}
	s := req.Subscriptions[0]
	if s.Email != "ada@example.com" || s.Status != "ACTIVE" || s.SubscriptionID != "123" {
		t.Fatalf("mapped = %+v", s)
	}
	if s.SourceID != "appstle://subscription/123" {
		t.Fatalf("source id = %q", s.SourceID)
	}
	if s.NextChargeAt == nil {
		t.Fatal("nextBillingDate not parsed")
	}
	// not last => next page (0-indexed -> 1)
	if req.Cursor != "appstle:1" {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}
