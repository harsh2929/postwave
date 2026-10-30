// SPDX-License-Identifier: AGPL-3.0-only
package loyalty_integrations

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeFriendbuySecretResolver struct{ json string }

func (f fakeFriendbuySecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakeFriendbuySecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*friendbuyCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestFriendbuyBackfillExchangesTokenThenMapsCustomers(t *testing.T) {
	var tokenCalled bool
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/authorization"):
			tokenCalled = true
			_ = json.NewEncoder(w).Encode(map[string]any{"token": "fb.tok", "expires": "2026-06-21T00:00:00Z"})
		case strings.Contains(r.URL.Path, "/customers"):
			gotAuth = r.Header.Get("Authorization")
			if gotAuth != "Bearer fb.tok" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"results": []map[string]any{
					{"email": "Ada@Example.com", "firstName": "Ada", "lastName": "L", "referralCode": "ADA-50"},
				},
				"next": "CUR2",
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	backfiller := FriendbuyRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: FriendbuySecretsCredentialResolver{Secrets: fakeFriendbuySecretResolver{json: `{"key":"k","secret":"s"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderFriendbuy, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !tokenCalled {
		t.Fatal("friendbuy did not exchange key/secret for a token")
	}
	if len(req.Members) != 1 {
		t.Fatalf("members = %d", len(req.Members))
	}
	m := req.Members[0]
	if m.Email != "ada@example.com" || m.ReferralCode != "ADA-50" || m.FirstName != "Ada" {
		t.Fatalf("mapped = %+v", m)
	}
	if m.SourceID != "friendbuy://customer/ada@example.com" {
		t.Fatalf("source id = %q", m.SourceID)
	}
	if req.Cursor != "friendbuy:CUR2" {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}
