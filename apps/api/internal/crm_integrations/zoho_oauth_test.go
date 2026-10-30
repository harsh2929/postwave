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

func zohoOAuthFixedNow() func() time.Time {
	return func() time.Time { return time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC) }
}

func TestZohoOAuthExchangeAuthorizationCode(t *testing.T) {
	var gotPath, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token":  "1000.at",
			"refresh_token": "1000.rt",
			"api_domain":    "https://www.zohoapis.com",
			"token_type":    "Bearer",
			"expires_in":    3600,
		})
	}))
	defer srv.Close()

	client := ZohoOAuthClient{HTTPClient: srv.Client(), AccountsURL: srv.URL, Now: zohoOAuthFixedNow()}
	creds := ZohoCredentials{ClientID: "cid", ClientSecret: "csecret"}
	token, err := client.ExchangeAuthorizationCode(context.Background(), creds, "the-code", "https://app.example/callback")
	if err != nil {
		t.Fatalf("exchange: %v", err)
	}
	if gotPath != "/oauth/v2/token" {
		t.Fatalf("path = %q", gotPath)
	}
	for _, want := range []string{"grant_type=authorization_code", "client_id=cid", "client_secret=csecret", "code=the-code"} {
		if !strings.Contains(gotBody, want) {
			t.Fatalf("body %q missing %q", gotBody, want)
		}
	}
	if token.AccessToken != "1000.at" || token.RefreshToken != "1000.rt" || token.APIBaseURL != "https://www.zohoapis.com" {
		t.Fatalf("token = %+v", token)
	}
	wantExpiry := zohoOAuthFixedNow()().Add(3600 * time.Second)
	if !token.ExpiresAt.Equal(wantExpiry) {
		t.Fatalf("expires_at = %v, want %v", token.ExpiresAt, wantExpiry)
	}
}

func TestZohoOAuthRefreshAccessToken(t *testing.T) {
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "1000.at2", "api_domain": "https://www.zohoapis.com", "expires_in": 3600})
	}))
	defer srv.Close()

	client := ZohoOAuthClient{HTTPClient: srv.Client(), AccountsURL: srv.URL, Now: zohoOAuthFixedNow()}
	creds := ZohoCredentials{ClientID: "cid", ClientSecret: "csecret", RefreshToken: "1000.rt"}
	token, err := client.RefreshAccessToken(context.Background(), creds)
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	for _, want := range []string{"grant_type=refresh_token", "refresh_token=1000.rt", "client_id=cid"} {
		if !strings.Contains(gotBody, want) {
			t.Fatalf("body %q missing %q", gotBody, want)
		}
	}
	if token.AccessToken != "1000.at2" {
		t.Fatalf("token = %+v", token)
	}
}

func TestZohoOAuthRevokeRefreshToken(t *testing.T) {
	var gotPath, gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	client := ZohoOAuthClient{HTTPClient: srv.Client(), AccountsURL: srv.URL}
	if err := client.RevokeRefreshToken(context.Background(), ZohoCredentials{RefreshToken: "1000.rt"}); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if gotPath != "/oauth/v2/token/revoke" {
		t.Fatalf("path = %q", gotPath)
	}
	if !strings.Contains(gotQuery, "token=1000.rt") {
		t.Fatalf("query = %q", gotQuery)
	}
}

func TestZohoAuthorizeURL(t *testing.T) {
	cfg := ZohoOAuthConfig{ClientID: "cid", RedirectURL: "https://app.example/callback", AccountsURL: "https://accounts.zoho.eu", Scopes: []string{"ZohoCRM.modules.ALL", "ZohoCRM.users.READ"}}
	got, err := zohoOAuthAuthorizeURL(cfg, "state-z")
	if err != nil {
		t.Fatalf("authorize url: %v", err)
	}
	for _, want := range []string{"https://accounts.zoho.eu/oauth/v2/auth", "response_type=code", "client_id=cid", "access_type=offline", "state=state-z"} {
		if !strings.Contains(got, want) {
			t.Fatalf("authorize url %q missing %q", got, want)
		}
	}
}
