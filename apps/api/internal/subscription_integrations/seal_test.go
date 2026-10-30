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

type fakeSealSecretResolver struct{ json string }

func (f fakeSealSecretResolver) Get(_ context.Context, _ string) (string, error) { return f.json, nil }
func (f fakeSealSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*sealCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestSealBackfillMapsSubscriptions(t *testing.T) {
	var gotPath, gotToken, gotPage string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotToken = r.Header.Get("X-Seal-Token")
		gotPage = r.URL.Query().Get("page")
		// payload-wrapped shape
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true,
			"payload": map[string]any{
				"subscriptions": []map[string]any{
					{"id": 4242, "email": "Ada@Example.com", "status": "ACTIVE", "next_billing_date": "2026-07-01T00:00:00Z"},
				},
			},
		})
	}))
	defer srv.Close()

	backfiller := SealRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: SealSecretsCredentialResolver{Secrets: fakeSealSecretResolver{json: `{"token":"seal_tok"}`}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderSealSubscriptions, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !strings.Contains(gotPath, "/subscriptions") || gotToken != "seal_tok" || gotPage != "1" {
		t.Fatalf("path=%q token=%q page=%q", gotPath, gotToken, gotPage)
	}
	if len(req.Subscriptions) != 1 {
		t.Fatalf("subscriptions = %d", len(req.Subscriptions))
	}
	s := req.Subscriptions[0]
	if s.Email != "ada@example.com" || s.Status != "ACTIVE" || s.SubscriptionID != "4242" {
		t.Fatalf("mapped = %+v", s)
	}
	if s.SourceID != "seal-subscriptions://subscription/4242" {
		t.Fatalf("source id = %q", s.SourceID)
	}
	if s.NextChargeAt == nil {
		t.Fatal("next_billing_date not parsed")
	}
	// PageSize=1 and 1 row returned => another page expected.
	if req.Cursor != "seal:2" {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}
