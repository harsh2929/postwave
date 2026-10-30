package socialads

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGoogleAdsProviderValidateCredentials(t *testing.T) {
	var sawToken bool
	var sawAds bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/oauth2/v3/token":
			sawToken = true
			if err := r.ParseForm(); err != nil {
				t.Fatalf("parse form: %v", err)
			}
			if r.Form.Get("grant_type") != "refresh_token" || r.Form.Get("client_id") != "client-id" || r.Form.Get("client_secret") != "client-secret" || r.Form.Get("refresh_token") != "refresh-token" {
				t.Fatalf("unexpected token form: %v", r.Form)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "access-token", "expires_in": 3600})
		case "/v24/customers:listAccessibleCustomers":
			sawAds = true
			if r.Header.Get("Authorization") != "Bearer access-token" {
				t.Fatalf("authorization = %q", r.Header.Get("Authorization"))
			}
			if r.Header.Get("developer-token") != "dev-token" {
				t.Fatalf("developer-token = %q", r.Header.Get("developer-token"))
			}
			if r.Header.Get("login-customer-id") != "1234567890" {
				t.Fatalf("login-customer-id = %q", r.Header.Get("login-customer-id"))
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"resourceNames": []string{"customers/111", "customers/222"}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	provider := NewGoogleAdsProvider(GoogleAdsConfig{
		APIBaseURL:      srv.URL,
		APIVersion:      "v24",
		DeveloperToken:  "dev-token",
		ClientID:        "client-id",
		ClientSecret:    "client-secret",
		RefreshToken:    "refresh-token",
		LoginCustomerID: "123-456-7890",
		OAuthTokenURL:   srv.URL + "/oauth2/v3/token",
	}, srv.Client())
	res, err := provider.ValidateCredentials(context.Background())
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	if !sawToken || !sawAds {
		t.Fatalf("sawToken=%v sawAds=%v", sawToken, sawAds)
	}
	if res.Provider != "google_ads" || res.Status != "credentials_validated" {
		t.Fatalf("result = %#v", res)
	}
}

func TestGoogleAdsProviderMissingCredentialsFailClosed(t *testing.T) {
	provider := NewGoogleAdsProvider(GoogleAdsConfig{}, http.DefaultClient)
	res, err := provider.ValidateCredentials(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
	if res.Status != "requires_provider" {
		t.Fatalf("status = %q", res.Status)
	}
}
