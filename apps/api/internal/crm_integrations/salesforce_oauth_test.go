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

func salesforceOAuthFixedNow() func() time.Time {
	return func() time.Time { return time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC) }
}

func TestSalesforceOAuthExchangeAuthorizationCode(t *testing.T) {
	var gotPath, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token":  "00Dxx!at",
			"refresh_token": "5Aep!rt",
			"instance_url":  "https://acme.my.salesforce.com",
			"id":            "https://login.salesforce.com/id/00D/005",
			"token_type":    "Bearer",
		})
	}))
	defer srv.Close()

	client := SalesforceOAuthClient{HTTPClient: srv.Client(), LoginURL: srv.URL, Now: salesforceOAuthFixedNow(), TokenTTL: 2 * time.Hour}
	creds := SalesforceCredentials{ClientID: "cid", ClientSecret: "csecret"}
	token, err := client.ExchangeAuthorizationCode(context.Background(), creds, "the-code", "https://app.example/callback")
	if err != nil {
		t.Fatalf("exchange: %v", err)
	}
	if gotPath != "/services/oauth2/token" {
		t.Fatalf("path = %q", gotPath)
	}
	for _, want := range []string{"grant_type=authorization_code", "client_id=cid", "client_secret=csecret", "code=the-code"} {
		if !strings.Contains(gotBody, want) {
			t.Fatalf("body %q missing %q", gotBody, want)
		}
	}
	if token.AccessToken != "00Dxx!at" || token.RefreshToken != "5Aep!rt" {
		t.Fatalf("token = %+v", token)
	}
	if token.InstanceURL != "https://acme.my.salesforce.com" {
		t.Fatalf("instance_url = %q", token.InstanceURL)
	}
	wantExpiry := salesforceOAuthFixedNow()().Add(2 * time.Hour)
	if !token.ExpiresAt.Equal(wantExpiry) {
		t.Fatalf("expires_at = %v, want %v (now + assumed TTL)", token.ExpiresAt, wantExpiry)
	}
}

func TestSalesforceOAuthRefreshAccessToken(t *testing.T) {
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "00Dxx!at2", "instance_url": "https://acme.my.salesforce.com"})
	}))
	defer srv.Close()

	client := SalesforceOAuthClient{HTTPClient: srv.Client(), LoginURL: srv.URL, Now: salesforceOAuthFixedNow()}
	creds := SalesforceCredentials{ClientID: "cid", ClientSecret: "csecret", RefreshToken: "5Aep!rt"}
	token, err := client.RefreshAccessToken(context.Background(), creds)
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	for _, want := range []string{"grant_type=refresh_token", "refresh_token=5Aep", "client_id=cid"} {
		if !strings.Contains(gotBody, want) {
			t.Fatalf("body %q missing %q", gotBody, want)
		}
	}
	if token.AccessToken != "00Dxx!at2" {
		t.Fatalf("token = %+v", token)
	}
}

func TestSalesforceOAuthRevokeRefreshToken(t *testing.T) {
	var gotPath, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	client := SalesforceOAuthClient{HTTPClient: srv.Client(), LoginURL: srv.URL}
	if err := client.RevokeRefreshToken(context.Background(), SalesforceCredentials{RefreshToken: "5Aep!rt"}); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if gotPath != "/services/oauth2/revoke" {
		t.Fatalf("path = %q", gotPath)
	}
	if !strings.Contains(gotBody, "token=5Aep") {
		t.Fatalf("body = %q", gotBody)
	}
}

func TestSalesforceAuthorizeURL(t *testing.T) {
	cfg := SalesforceOAuthConfig{ClientID: "cid", RedirectURL: "https://app.example/callback", LoginURL: "https://test.salesforce.com", Scopes: []string{"api", "refresh_token"}}
	got, err := salesforceOAuthAuthorizeURL(cfg, "state-9")
	if err != nil {
		t.Fatalf("authorize url: %v", err)
	}
	for _, want := range []string{"https://test.salesforce.com/services/oauth2/authorize", "response_type=code", "client_id=cid", "state=state-9"} {
		if !strings.Contains(got, want) {
			t.Fatalf("authorize url %q missing %q", got, want)
		}
	}
}

func TestSalesforceOAuthSettingsFromRequestPreservesFieldSelections(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/oauth/start?contact_fields=Account.Id,Owner.Email&lead_fields=Campaign__c&campaign_member_fields=Campaign.Type&task_fields=CallDisposition&sync_leads=false&sync_campaign_members=false&sync_tasks=false", nil)
	got := salesforceOAuthSettingsFromRequest(req)
	if got["contact_fields"] != "Account.Id,Owner.Email" || got["lead_fields"] != "Campaign__c" || got["campaign_member_fields"] != "Campaign.Type" || got["task_fields"] != "CallDisposition" || got["sync_leads"] != "false" || got["sync_campaign_members"] != "false" || got["sync_tasks"] != "false" {
		t.Fatalf("settings=%+v", got)
	}
}
