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

func hubSpotOAuthFixedNow() func() time.Time {
	return func() time.Time { return time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC) }
}

func TestHubSpotOAuthExchangeAuthorizationCode(t *testing.T) {
	var gotPath, gotContentType, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotContentType = r.Header.Get("Content-Type")
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token":  "at_new",
			"refresh_token": "rt_new",
			"token_type":    "bearer",
			"expires_in":    1800,
		})
	}))
	defer srv.Close()

	client := HubSpotOAuthClient{HTTPClient: srv.Client(), OAuthBaseURL: srv.URL, Now: hubSpotOAuthFixedNow()}
	creds := HubSpotCredentials{ClientID: "cid", ClientSecret: "csecret"}
	token, err := client.ExchangeAuthorizationCode(context.Background(), creds, "the-code", "https://app.example/callback")
	if err != nil {
		t.Fatalf("exchange: %v", err)
	}
	if gotPath != "/oauth/v1/token" {
		t.Fatalf("path = %q", gotPath)
	}
	if !strings.HasPrefix(gotContentType, "application/x-www-form-urlencoded") {
		t.Fatalf("content-type = %q", gotContentType)
	}
	for _, want := range []string{"grant_type=authorization_code", "client_id=cid", "client_secret=csecret", "code=the-code", "redirect_uri=https%3A%2F%2Fapp.example%2Fcallback"} {
		if !strings.Contains(gotBody, want) {
			t.Fatalf("body %q missing %q", gotBody, want)
		}
	}
	if token.AccessToken != "at_new" || token.RefreshToken != "rt_new" {
		t.Fatalf("token = %+v", token)
	}
	wantExpiry := hubSpotOAuthFixedNow()().Add(1800 * time.Second)
	if !token.ExpiresAt.Equal(wantExpiry) {
		t.Fatalf("expires_at = %v, want %v", token.ExpiresAt, wantExpiry)
	}
}

func TestHubSpotOAuthRefreshAccessToken(t *testing.T) {
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "at_refreshed", "expires_in": 1800})
	}))
	defer srv.Close()

	client := HubSpotOAuthClient{HTTPClient: srv.Client(), OAuthBaseURL: srv.URL, Now: hubSpotOAuthFixedNow()}
	creds := HubSpotCredentials{ClientID: "cid", ClientSecret: "csecret", RefreshToken: "rt_old"}
	token, err := client.RefreshAccessToken(context.Background(), creds)
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	for _, want := range []string{"grant_type=refresh_token", "refresh_token=rt_old", "client_id=cid", "client_secret=csecret"} {
		if !strings.Contains(gotBody, want) {
			t.Fatalf("body %q missing %q", gotBody, want)
		}
	}
	if token.AccessToken != "at_refreshed" {
		t.Fatalf("token = %+v", token)
	}
}

func TestHubSpotOAuthAccessTokenInfo(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = json.NewEncoder(w).Encode(map[string]any{
			"hub_id":     12345678,
			"app_id":     42,
			"user_id":    99,
			"hub_domain": "acme.com",
			"scopes":     []string{"crm.objects.contacts.read"},
		})
	}))
	defer srv.Close()

	client := HubSpotOAuthClient{HTTPClient: srv.Client(), OAuthBaseURL: srv.URL}
	creds := HubSpotCredentials{AccessToken: "at_xyz"}
	info, err := client.AccessTokenInfo(context.Background(), creds)
	if err != nil {
		t.Fatalf("access token info: %v", err)
	}
	if gotPath != "/oauth/v1/access-tokens/at_xyz" {
		t.Fatalf("path = %q", gotPath)
	}
	if info.PortalID != "12345678" {
		t.Fatalf("portal_id = %q", info.PortalID)
	}
	if info.AppID != "42" {
		t.Fatalf("app_id = %q", info.AppID)
	}
	if info.HubDomain != "acme.com" {
		t.Fatalf("hub_domain = %q", info.HubDomain)
	}
}

func TestHubSpotOAuthRevokeRefreshToken(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	client := HubSpotOAuthClient{HTTPClient: srv.Client(), OAuthBaseURL: srv.URL}
	creds := HubSpotCredentials{RefreshToken: "rt_revoke"}
	if err := client.RevokeRefreshToken(context.Background(), creds); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if gotMethod != http.MethodDelete {
		t.Fatalf("method = %q", gotMethod)
	}
	if gotPath != "/oauth/v1/refresh-tokens/rt_revoke" {
		t.Fatalf("path = %q", gotPath)
	}
}

func TestHubSpotAuthorizeURL(t *testing.T) {
	cfg := HubSpotOAuthConfig{
		ClientID:    "cid",
		RedirectURL: "https://app.example/callback",
		Scopes:      []string{"crm.objects.contacts.read", "oauth"},
	}
	got, err := hubSpotOAuthAuthorizeURL(cfg, "state-123")
	if err != nil {
		t.Fatalf("authorize url: %v", err)
	}
	for _, want := range []string{"https://app.hubspot.com/oauth/authorize", "client_id=cid", "state=state-123", "scope=crm.objects.contacts.read+oauth", "redirect_uri=https%3A%2F%2Fapp.example%2Fcallback"} {
		if !strings.Contains(got, want) {
			t.Fatalf("authorize url %q missing %q", got, want)
		}
	}
}
