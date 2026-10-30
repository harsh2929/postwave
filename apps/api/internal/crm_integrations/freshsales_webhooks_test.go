// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func TestFreshsalesWebhookHydratesSparseContactAndUpserts(t *testing.T) {
	var gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"contact": map[string]any{
				"id":            9,
				"email":         "Ada@Example.com",
				"first_name":    "Ada",
				"last_name":     "Lovelace",
				"mobile_number": "+15551234567",
				"job_title":     "Buyer",
			},
		})
	}))
	defer srv.Close()

	store := newFakeStore()
	store.integration.Provider = ProviderFreshsales
	store.integration.CredentialsRef = "cred_freshsales_1"
	store.integration.Settings = map[string]any{
		"account_domain":      "acme",
		"webhook_route_token": "route_freshsales_1",
		"api_base_url":        srv.URL,
	}
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:     store,
		Profiles: profiles,
		FreshsalesCredentials: fakeFreshsalesCredentialResolver{creds: FreshsalesCredentials{
			APIKey: "fresh_key",
		}},
		Now: func() time.Time { return time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC) },
	}
	router := chi.NewRouter()
	MountPublicRoutes(router, deps)
	body := `{"event":"contact.updated","contact_id":9,"timestamp":"2026-07-02T12:01:02Z"}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/crm-integrations/freshsales/webhooks/route_freshsales_1", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if gotPath != "/crm/sales/api/contacts/9" || gotAuth != "Token token=fresh_key" {
		t.Fatalf("hydrate path/auth=%q/%q", gotPath, gotAuth)
	}
	if len(profiles.contacts) != 1 {
		t.Fatalf("contacts=%+v", profiles.contacts)
	}
	contact := profiles.contacts[0]
	if contact.SourceID != "freshsales://contact/9" || contact.Email != "ada@example.com" || contact.FirstName != "Ada" || contact.Phone != "+15551234567" {
		t.Fatalf("contact=%+v", contact)
	}
	if store.lastWebhookProvider != ProviderFreshsales || store.lastWebhookTopic != "contact.updated" || !strings.Contains(store.lastWebhookID, "freshsales:contact.updated:9") {
		t.Fatalf("webhook provider/topic/id = %q/%q/%q", store.lastWebhookProvider, store.lastWebhookTopic, store.lastWebhookID)
	}
	if !store.webhookProcessed || store.webhookFailed || len(store.runs) != 1 || store.runs[0].RunMode != "webhook" || store.runs[0].ContactsUpserted != 1 {
		t.Fatalf("processed=%v failed=%v runs=%+v", store.webhookProcessed, store.webhookFailed, store.runs)
	}
}

func TestFreshsalesWebhookMapsDirectContactWithoutHydration(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderFreshsales
	store.integration.CredentialsRef = "cred_freshsales_1"
	store.integration.Settings = map[string]any{
		"account_domain":      "acme",
		"webhook_route_token": "route_freshsales_1",
	}
	profiles := &fakeProfileSink{}
	deps := &Deps{Repo: store, Profiles: profiles}
	router := chi.NewRouter()
	MountPublicRoutes(router, deps)
	body := `{
		"event":"contact.created",
		"timestamp":"2026-07-02T12:01:02Z",
		"contact":{"id":10,"email":"Direct@Example.com","first_name":"Direct","last_name":"Payload"}
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/crm-integrations/freshsales/webhooks/route_freshsales_1", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.contacts) != 1 || profiles.contacts[0].SourceID != "freshsales://contact/10" || profiles.contacts[0].Email != "direct@example.com" {
		t.Fatalf("contacts=%+v", profiles.contacts)
	}
	if store.lastWebhookTopic != "contact.created" || !store.webhookProcessed || store.webhookFailed || len(store.runs) != 1 {
		t.Fatalf("topic=%q processed=%v failed=%v runs=%+v", store.lastWebhookTopic, store.webhookProcessed, store.webhookFailed, store.runs)
	}
}

func TestFreshsalesWebhookIgnoresUnsupportedObjectAfterClaim(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderFreshsales
	store.integration.CredentialsRef = "cred_freshsales_1"
	store.integration.Settings = map[string]any{"webhook_route_token": "route_freshsales_1"}
	deps := &Deps{Repo: store, Profiles: &fakeProfileSink{}}
	router := chi.NewRouter()
	MountPublicRoutes(router, deps)
	body := `{"event":"deal.updated","deal":{"id":42,"name":"Expansion"},"timestamp":"2026-07-02T12:01:02Z"}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/crm-integrations/freshsales/webhooks/route_freshsales_1", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.webhookClaimCount != 1 || store.lastWebhookTopic != "deal.updated" || !store.webhookProcessed || store.webhookFailed || len(store.runs) != 0 {
		t.Fatalf("claim=%d topic=%q processed=%v failed=%v runs=%+v", store.webhookClaimCount, store.lastWebhookTopic, store.webhookProcessed, store.webhookFailed, store.runs)
	}
}
