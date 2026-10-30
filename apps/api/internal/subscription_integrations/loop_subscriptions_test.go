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

type fakeLoopSecretResolver struct{ json string }

func (f fakeLoopSecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakeLoopSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*loopCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestLoopSubscriptionsBackfillMapsSubscriptions(t *testing.T) {
	var gotPath, gotToken, gotPage string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotToken = r.Header.Get("X-Loop-Token")
		gotPage = r.URL.Query().Get("pageNo")
		// Loop's current shape: singular /subscription, {data, pageInfo}, numeric
		// id, customer.email, epoch-seconds nextBillingDateEpoch.
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{
				{"id": 2241, "customer": map[string]any{"email": "Ada@Example.com"}, "status": "ACTIVE", "sku": "TEA-1",
					"productTitle": "Tea Club", "nextBillingDateEpoch": 1782604800},
			},
			"pageInfo": map[string]any{"hasNextPage": true},
		})
	}))
	defer srv.Close()

	backfiller := LoopSubscriptionsRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: LoopSubscriptionsSecretsCredentialResolver{Secrets: fakeLoopSecretResolver{json: `{"api_key":"loop_tok"}`}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderLoopSubscriptions, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !strings.HasSuffix(gotPath, "/admin/2023-10/subscription") || gotToken != "loop_tok" || gotPage != "1" {
		t.Fatalf("path=%q token=%q page=%q", gotPath, gotToken, gotPage)
	}
	if len(req.Subscriptions) != 1 {
		t.Fatalf("subscriptions = %d", len(req.Subscriptions))
	}
	s := req.Subscriptions[0]
	if s.Email != "ada@example.com" || s.Status != "ACTIVE" || s.SubscriptionID != "2241" || s.SKU != "TEA-1" {
		t.Fatalf("mapped = %+v", s)
	}
	if s.SourceID != "loop-subscriptions://subscription/2241" {
		t.Fatalf("source id = %q", s.SourceID)
	}
	if s.NextChargeAt == nil || s.NextChargeAt.Year() != 2026 {
		t.Fatalf("nextBillingDateEpoch not parsed: %v", s.NextChargeAt)
	}
	if req.Cursor != "loop:2" {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}
