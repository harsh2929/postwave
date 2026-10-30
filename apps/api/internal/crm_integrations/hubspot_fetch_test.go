// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHubSpotFetchContactByID(t *testing.T) {
	var gotPath, gotProps string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotProps = r.URL.Query().Get("properties")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id":         "501",
			"properties": map[string]any{"email": "Ada@Example.com", "firstname": "Ada"},
			"updatedAt":  "2026-06-20T10:00:00Z",
		})
	}))
	defer srv.Close()

	backfiller := HubSpotRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeHubSpotCredentialResolver{creds: HubSpotCredentials{AccessToken: "at"}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}
	contact, ok, err := backfiller.FetchContactByID(context.Background(), "tenant-1", Integration{Provider: ProviderHubSpot}, "501")
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if !ok {
		t.Fatal("expected a mapped contact")
	}
	if !strings.HasSuffix(gotPath, "/contacts/501") {
		t.Fatalf("path = %q", gotPath)
	}
	if !strings.Contains(gotProps, "email") {
		t.Fatalf("properties = %q", gotProps)
	}
	if contact.Email != "ada@example.com" {
		t.Fatalf("email = %q", contact.Email)
	}
	if contact.SourceID != "hubspot://contact/501" {
		t.Fatalf("source id = %q", contact.SourceID)
	}
}

func TestHubSpotFetchContactByIDNotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	backfiller := HubSpotRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeHubSpotCredentialResolver{creds: HubSpotCredentials{AccessToken: "at"}},
		APIBaseURL:  srv.URL,
	}
	_, ok, err := backfiller.FetchContactByID(context.Background(), "tenant-1", Integration{Provider: ProviderHubSpot}, "999")
	if err != nil {
		t.Fatalf("404 should not be an error: %v", err)
	}
	if ok {
		t.Fatal("404 should yield ok=false")
	}
}
