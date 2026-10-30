// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

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

func TestKeapOAuthExchange(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "keap.at", "refresh_token": "keap.rt", "expires_in": 86400, "scope": "full"})
	}))
	defer srv.Close()

	client := KeapOAuthClient{HTTPClient: srv.Client(), TokenURL: srv.URL, Now: func() time.Time { return now }}
	creds := KeapCredentials{ClientID: "cid", ClientSecret: "csec"}
	token, err := client.ExchangeAuthorizationCode(context.Background(), creds, "code", "https://app/cb")
	if err != nil {
		t.Fatalf("exchange: %v", err)
	}
	for _, want := range []string{"grant_type=authorization_code", "client_id=cid", "code=code"} {
		if !strings.Contains(gotBody, want) {
			t.Fatalf("body %q missing %q", gotBody, want)
		}
	}
	if token.AccessToken != "keap.at" || token.RefreshToken != "keap.rt" || !token.ExpiresAt.Equal(now.Add(86400*time.Second)) {
		t.Fatalf("token = %+v", token)
	}
}

func TestKeapAuthorizeURL(t *testing.T) {
	cfg := KeapOAuthConfig{ClientID: "cid", RedirectURL: "https://app/cb"}
	got, err := keapOAuthAuthorizeURL(cfg, "st")
	if err != nil {
		t.Fatalf("authorize url: %v", err)
	}
	for _, want := range []string{"accounts.infusionsoft.com/app/oauth/authorize", "client_id=cid", "scope=full", "state=st"} {
		if !strings.Contains(got, want) {
			t.Fatalf("authorize url %q missing %q", got, want)
		}
	}
}
