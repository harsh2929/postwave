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

type fakeSalesforceManagedStore struct {
	secrets map[string]string
}

func (f *fakeSalesforceManagedStore) GetSalesforceCredentialSecret(_ context.Context, _, ref string) (string, error) {
	if v, ok := f.secrets[ref]; ok {
		return v, nil
	}
	return "", ErrNotFound
}

func (f *fakeSalesforceManagedStore) PutSalesforceCredentialSecret(_ context.Context, _, ref string, creds SalesforceCredentials) error {
	f.secrets[ref] = salesforceStoredCredentialJSON(creds)
	return nil
}

func TestSalesforceResolverRefreshesExpiringToken(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "at_fresh", "refresh_token": "rt_rotated", "instance_url": "https://acme.my.salesforce.com"})
	}))
	defer srv.Close()

	ref := "crm:salesforce:abc"
	store := &fakeSalesforceManagedStore{secrets: map[string]string{}}
	raw, _ := json.Marshal(map[string]any{
		"access_token":  "at_old",
		"refresh_token": "rt_old",
		"client_id":     "cid",
		"client_secret": "csec",
		"instance_url":  "https://acme.my.salesforce.com",
		"expires_at":    now.Add(-time.Minute).Format(time.RFC3339),
	})
	store.secrets[ref] = string(raw)

	resolver := &SalesforceSecretsCredentialResolver{
		Store:       store,
		OAuthClient: SalesforceOAuthClient{HTTPClient: srv.Client(), LoginURL: srv.URL, Now: func() time.Time { return now }},
		Now:         func() time.Time { return now },
	}
	creds, err := resolver.ResolveSalesforce(context.Background(), "tenant-1", Integration{Provider: ProviderSalesforce, CredentialsRef: ref})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if creds.AccessToken != "at_fresh" {
		t.Fatalf("access token = %q, want refreshed", creds.AccessToken)
	}
	if got := store.secrets[ref]; !strings.Contains(got, "at_fresh") || !strings.Contains(got, "rt_rotated") {
		t.Fatalf("store not updated with refreshed token: %s", got)
	}
}
