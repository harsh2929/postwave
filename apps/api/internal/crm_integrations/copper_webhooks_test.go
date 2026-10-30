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

func TestCopperWebhookHydratesPersonAndUpsertsContact(t *testing.T) {
	var gotPath, gotToken, gotEmail string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotToken = r.Header.Get("X-PW-AccessToken")
		gotEmail = r.Header.Get("X-PW-UserEmail")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id":           55,
			"name":         "Ada Lovelace",
			"title":        "Buyer",
			"company_name": "Analytical Engines",
			"emails":       []map[string]any{{"email": "Ada@Example.com"}},
			"phone_numbers": []map[string]any{{
				"number": "+15551234567",
			}},
		})
	}))
	defer srv.Close()

	store := newFakeStore()
	store.integration.Provider = ProviderCopper
	store.integration.CredentialsRef = "cred_copper_1"
	store.integration.Settings = map[string]any{
		"account_id":                     "copper-account-1",
		"webhook_route_token":            "route_copper_1",
		"copper_webhook_subscription_id": "123",
		"api_base_url":                   srv.URL,
	}
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:     store,
		Profiles: profiles,
		CopperCredentials: fakeCopperCredentialResolver{creds: CopperCredentials{
			APIKey: "copper_key",
			Email:  "ops@example.com",
		}},
		Now: func() time.Time { return time.Date(2026, 7, 2, 11, 0, 0, 0, time.UTC) },
	}
	router := chi.NewRouter()
	MountPublicRoutes(router, deps)
	body := `{
		"ids":[55],
		"type":"person",
		"event":"update",
		"subscription_id":123,
		"timestamp":"2026-07-02T11:12:13.000Z"
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/crm-integrations/copper/webhooks/route_copper_1", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if gotPath != "/people/55" || gotToken != "copper_key" || gotEmail != "ops@example.com" {
		t.Fatalf("hydrate request path/token/email=%q/%q/%q", gotPath, gotToken, gotEmail)
	}
	if len(profiles.contacts) != 1 {
		t.Fatalf("contacts=%+v", profiles.contacts)
	}
	contact := profiles.contacts[0]
	if contact.SourceID != "copper://person/55" || contact.Email != "ada@example.com" || contact.Company != "Analytical Engines" || contact.Phone != "+15551234567" {
		t.Fatalf("contact=%+v", contact)
	}
	if store.lastWebhookProvider != ProviderCopper || store.lastWebhookTopic != "person.updated" || !strings.Contains(store.lastWebhookID, "copper:123:person.updated:55") {
		t.Fatalf("webhook provider/topic/id = %q/%q/%q", store.lastWebhookProvider, store.lastWebhookTopic, store.lastWebhookID)
	}
	if !store.webhookProcessed || store.webhookFailed || len(store.runs) != 1 || store.runs[0].RunMode != "webhook" || store.runs[0].ContactsUpserted != 1 {
		t.Fatalf("processed=%v failed=%v runs=%+v", store.webhookProcessed, store.webhookFailed, store.runs)
	}
}

func TestCopperWebhookRejectsSubscriptionMismatchBeforeClaim(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderCopper
	store.integration.CredentialsRef = "cred_copper_1"
	store.integration.Settings = map[string]any{"webhook_route_token": "route_copper_1", "copper_webhook_subscription_id": "123"}
	deps := &Deps{
		Repo:     store,
		Profiles: &fakeProfileSink{},
		CopperCredentials: fakeCopperCredentialResolver{creds: CopperCredentials{
			APIKey: "copper_key",
			Email:  "ops@example.com",
		}},
	}
	router := chi.NewRouter()
	MountPublicRoutes(router, deps)
	body := `{"ids":[55],"type":"person","event":"update","subscription_id":999,"timestamp":"2026-07-02T11:12:13.000Z"}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/crm-integrations/copper/webhooks/route_copper_1", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.webhookClaimCount != 0 || len(store.runs) != 0 || store.webhookProcessed || store.webhookFailed {
		t.Fatalf("claim=%d runs=%+v processed=%v failed=%v", store.webhookClaimCount, store.runs, store.webhookProcessed, store.webhookFailed)
	}
}

func TestCopperWebhookHydratesOpportunityAndTracksEvent(t *testing.T) {
	var gotPaths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPaths = append(gotPaths, r.URL.Path)
		switch r.URL.Path {
		case "/opportunities/42":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": 42, "name": "Expansion", "primary_contact_id": 55, "company_name": "Globex", "status": "Won", "monetary_value": 4200,
			})
		case "/people/55":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": 55, "name": "Ada Lovelace", "title": "Buyer", "company_name": "Globex",
				"emails": []map[string]any{{"email": "Ada@Example.com"}},
			})
		default:
			t.Fatalf("unexpected path %q", r.URL.Path)
		}
	}))
	defer srv.Close()

	store := newFakeStore()
	store.integration.Provider = ProviderCopper
	store.integration.CredentialsRef = "cred_copper_1"
	store.integration.Settings = map[string]any{"webhook_route_token": "route_copper_1", "api_base_url": srv.URL}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:     store,
		Profiles: &fakeProfileSink{},
		Events:   events,
		CopperCredentials: fakeCopperCredentialResolver{creds: CopperCredentials{
			APIKey: "copper_key",
			Email:  "ops@example.com",
		}},
		Now: func() time.Time { return time.Date(2026, 7, 2, 11, 0, 0, 0, time.UTC) },
	}
	router := chi.NewRouter()
	MountPublicRoutes(router, deps)
	body := `{"ids":[42],"type":"opportunity","event":"update","subscription_id":123,"timestamp":"2026-07-02T11:12:13.000Z"}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/crm-integrations/copper/webhooks/route_copper_1", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if strings.Join(gotPaths, ",") != "/opportunities/42,/people/55" {
		t.Fatalf("paths=%+v", gotPaths)
	}
	if len(events.events) != 1 {
		t.Fatalf("events=%+v", events.events)
	}
	event := events.events[0]
	if event.SourceID != "copper://opportunity/42/person/55" || event.Email != "ada@example.com" || event.EventName != "crm.deal.won" {
		t.Fatalf("event=%+v", event)
	}
	if event.Properties["copper_webhook_event"] != "update" || event.Properties["copper_webhook_subscription_id"] != "123" {
		t.Fatalf("webhook properties=%+v", event.Properties)
	}
	if store.webhookClaimCount != 1 || store.lastWebhookTopic != "opportunity.updated" || !store.webhookProcessed || store.webhookFailed || len(store.runs) != 1 || store.runs[0].EventsTracked != 1 {
		t.Fatalf("claim=%d topic=%q processed=%v failed=%v runs=%+v", store.webhookClaimCount, store.lastWebhookTopic, store.webhookProcessed, store.webhookFailed, store.runs)
	}
}
