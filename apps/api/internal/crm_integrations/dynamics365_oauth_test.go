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

func TestDynamics365OAuthExchangeUsesTenantURLAndScope(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	var gotPath, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "d365.at", "refresh_token": "d365.rt", "expires_in": 3600})
	}))
	defer srv.Close()

	client := Dynamics365OAuthClient{HTTPClient: srv.Client(), OAuthBaseURL: srv.URL, TenantID: "contoso.onmicrosoft.com", Now: func() time.Time { return now }}
	creds := Dynamics365Credentials{ClientID: "cid", ClientSecret: "csec", EnvironmentURL: "https://acme.crm.dynamics.com"}
	token, err := client.ExchangeAuthorizationCode(context.Background(), creds, "code", "https://app/cb", "https://acme.crm.dynamics.com")
	if err != nil {
		t.Fatalf("exchange: %v", err)
	}
	if gotPath != "/contoso.onmicrosoft.com/oauth2/v2.0/token" {
		t.Fatalf("path = %q", gotPath)
	}
	for _, want := range []string{"grant_type=authorization_code", "client_id=cid", "scope=https%3A%2F%2Facme.crm.dynamics.com%2F.default+offline_access"} {
		if !strings.Contains(gotBody, want) {
			t.Fatalf("body %q missing %q", gotBody, want)
		}
	}
	if token.AccessToken != "d365.at" || !token.ExpiresAt.Equal(now.Add(3600*time.Second)) {
		t.Fatalf("token = %+v", token)
	}
}

func TestDynamics365AuthorizeURL(t *testing.T) {
	cfg := Dynamics365OAuthConfig{ClientID: "cid", RedirectURL: "https://app/cb", TenantID: "common"}
	got, err := dynamics365OAuthAuthorizeURL(cfg, "st", "https://acme.crm.dynamics.com")
	if err != nil {
		t.Fatalf("authorize url: %v", err)
	}
	for _, want := range []string{"login.microsoftonline.com/common/oauth2/v2.0/authorize", "response_type=code", "client_id=cid", "state=st"} {
		if !strings.Contains(got, want) {
			t.Fatalf("authorize url %q missing %q", got, want)
		}
	}
}
