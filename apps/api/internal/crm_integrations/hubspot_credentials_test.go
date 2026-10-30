// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeHubSpotManagedStore struct {
	secrets map[string]string
}

func (f *fakeHubSpotManagedStore) GetHubSpotCredentialSecret(_ context.Context, _, ref string) (string, error) {
	if v, ok := f.secrets[ref]; ok {
		return v, nil
	}
	return "", ErrNotFound
}

func (f *fakeHubSpotManagedStore) PutHubSpotCredentialSecret(_ context.Context, _, ref string, creds HubSpotCredentials) error {
	f.secrets[ref] = hubSpotStoredCredentialJSON(creds)
	return nil
}

func hubSpotManagedSecretJSON(t *testing.T, m map[string]any) string {
	t.Helper()
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestHubSpotResolverRefreshesExpiringToken(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "at_fresh", "refresh_token": "rt_rotated", "expires_in": 1800})
	}))
	defer srv.Close()

	ref := "crm:hubspot:abc"
	store := &fakeHubSpotManagedStore{secrets: map[string]string{
		ref: hubSpotManagedSecretJSON(t, map[string]any{
			"access_token":  "at_old",
			"refresh_token": "rt_old",
			"client_id":     "cid",
			"client_secret": "csec",
			"expires_at":    now.Add(-time.Minute).Format(time.RFC3339), // already expired
		}),
	}}
	resolver := &HubSpotSecretsCredentialResolver{
		Store:       store,
		OAuthClient: HubSpotOAuthClient{HTTPClient: srv.Client(), OAuthBaseURL: srv.URL, Now: func() time.Time { return now }},
		Now:         func() time.Time { return now },
	}
	creds, err := resolver.ResolveHubSpot(context.Background(), "tenant-1", Integration{Provider: ProviderHubSpot, CredentialsRef: ref})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if creds.AccessToken != "at_fresh" {
		t.Fatalf("access token = %q, want refreshed", creds.AccessToken)
	}
	// The rotated token must be persisted back to the store.
	if got := store.secrets[ref]; got == "" || !strings.Contains(got, "at_fresh") || !strings.Contains(got, "rt_rotated") {
		t.Fatalf("store not updated with refreshed token: %s", got)
	}
}

func TestHubSpotResolverSkipsRefreshWhenFresh(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	ref := "crm:hubspot:fresh"
	store := &fakeHubSpotManagedStore{secrets: map[string]string{
		ref: hubSpotManagedSecretJSON(t, map[string]any{
			"access_token":  "at_valid",
			"refresh_token": "rt_old",
			"client_id":     "cid",
			"client_secret": "csec",
			"expires_at":    now.Add(time.Hour).Format(time.RFC3339), // well in the future
		}),
	}}
	resolver := &HubSpotSecretsCredentialResolver{
		Store:       store,
		OAuthClient: HubSpotOAuthClient{HTTPClient: srv.Client(), OAuthBaseURL: srv.URL, Now: func() time.Time { return now }},
		Now:         func() time.Time { return now },
	}
	creds, err := resolver.ResolveHubSpot(context.Background(), "tenant-1", Integration{Provider: ProviderHubSpot, CredentialsRef: ref})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if creds.AccessToken != "at_valid" {
		t.Fatalf("access token = %q, want unchanged", creds.AccessToken)
	}
	if called {
		t.Fatal("should not call the OAuth refresh endpoint when the token is still fresh")
	}
}
