// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

const closeWebhookTestSignatureKey = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"

func TestCloseWebhookVerifiesSignatureAndUpsertsContact(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderClose
	store.integration.CredentialsRef = "cred_close_1"
	store.integration.Settings = map[string]any{"organization_id": "orga_1", "webhook_route_token": "route_close_1"}
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:     store,
		Profiles: profiles,
		CloseCredentials: fakeCloseCredentialResolver{creds: CloseCredentials{
			APIKey:              "close_key",
			WebhookSignatureKey: closeWebhookTestSignatureKey,
		}},
		Now: func() time.Time { return time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC) },
	}
	router := chi.NewRouter()
	MountPublicRoutes(router, deps)
	body := `{
		"subscription_id":"whsub_1",
		"event":{
			"id":"ev_1",
			"action":"updated",
			"object_type":"contact",
			"object_id":"cont_1",
			"organization_id":"orga_1",
			"date_updated":"2026-07-02T10:11:12.000000+00:00",
			"data":{
				"id":"cont_1",
				"name":"Ada Lovelace",
				"title":"Buyer",
				"lead_id":"lead_1",
				"emails":[{"email":"Ada@Example.com"}],
				"phones":[{"phone":"+15551234567"}]
			}
		}
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/crm-integrations/close/webhooks/route_close_1", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	signCloseWebhookRequest(req, closeWebhookTestSignatureKey, body)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.contacts) != 1 {
		t.Fatalf("contacts=%+v", profiles.contacts)
	}
	contact := profiles.contacts[0]
	if contact.SourceID != "close://contact/cont_1" || contact.Email != "ada@example.com" || contact.Phone != "+15551234567" {
		t.Fatalf("contact=%+v", contact)
	}
	if store.lastWebhookProvider != ProviderClose || store.lastWebhookTopic != "contact.updated" || store.lastWebhookID != "close:whsub_1:ev_1" {
		t.Fatalf("webhook provider/topic/id = %q/%q/%q", store.lastWebhookProvider, store.lastWebhookTopic, store.lastWebhookID)
	}
	if !store.webhookProcessed || store.webhookFailed || len(store.runs) != 1 || store.runs[0].RunMode != "webhook" || store.runs[0].ContactsUpserted != 1 {
		t.Fatalf("processed=%v failed=%v runs=%+v", store.webhookProcessed, store.webhookFailed, store.runs)
	}
}

func TestCloseWebhookRejectsInvalidSignatureBeforeClaim(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderClose
	store.integration.CredentialsRef = "cred_close_1"
	store.integration.Settings = map[string]any{"webhook_route_token": "route_close_1"}
	deps := &Deps{
		Repo:     store,
		Profiles: &fakeProfileSink{},
		CloseCredentials: fakeCloseCredentialResolver{creds: CloseCredentials{
			APIKey:              "close_key",
			WebhookSignatureKey: closeWebhookTestSignatureKey,
		}},
	}
	router := chi.NewRouter()
	MountPublicRoutes(router, deps)
	body := `{"subscription_id":"whsub_1","event":{"id":"ev_1","action":"updated","object_type":"contact","data":{"email":"ada@example.com"}}}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/crm-integrations/close/webhooks/route_close_1", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("close-sig-timestamp", "1782987072")
	req.Header.Set("close-sig-hash", strings.Repeat("0", 64))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.webhookClaimCount != 0 || len(store.runs) != 0 || store.webhookProcessed || store.webhookFailed {
		t.Fatalf("claim=%d runs=%+v processed=%v failed=%v", store.webhookClaimCount, store.runs, store.webhookProcessed, store.webhookFailed)
	}
}

func TestCloseWebhookRejectsOrganizationMismatchBeforeClaim(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderClose
	store.integration.CredentialsRef = "cred_close_1"
	store.integration.Settings = map[string]any{"organization_id": "orga_expected", "webhook_route_token": "route_close_1"}
	deps := &Deps{
		Repo:     store,
		Profiles: &fakeProfileSink{},
		CloseCredentials: fakeCloseCredentialResolver{creds: CloseCredentials{
			APIKey:              "close_key",
			WebhookSignatureKey: closeWebhookTestSignatureKey,
		}},
	}
	router := chi.NewRouter()
	MountPublicRoutes(router, deps)
	body := `{"subscription_id":"whsub_1","event":{"id":"ev_1","action":"updated","object_type":"contact","organization_id":"orga_other","data":{"email":"ada@example.com"}}}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/crm-integrations/close/webhooks/route_close_1", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	signCloseWebhookRequest(req, closeWebhookTestSignatureKey, body)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.webhookClaimCount != 0 || len(store.runs) != 0 {
		t.Fatalf("claim=%d runs=%+v", store.webhookClaimCount, store.runs)
	}
}

func TestCloseWebhookHydratesContactForOpportunityEvent(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id":      "cont_1",
			"name":    "Ada Lovelace",
			"emails":  []map[string]any{{"email": "Ada@Example.com"}},
			"phones":  []map[string]any{{"phone": "+15551234567"}},
			"lead_id": "lead_1",
		})
	}))
	defer srv.Close()

	store := newFakeStore()
	store.integration.Provider = ProviderClose
	store.integration.CredentialsRef = "cred_close_1"
	store.integration.Settings = map[string]any{"organization_id": "orga_1", "webhook_route_token": "route_close_1", "api_base_url": srv.URL}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:     store,
		Profiles: profiles,
		Events:   events,
		CloseCredentials: fakeCloseCredentialResolver{creds: CloseCredentials{
			APIKey:              "close_key",
			WebhookSignatureKey: closeWebhookTestSignatureKey,
		}},
		Now: func() time.Time { return time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC) },
	}
	router := chi.NewRouter()
	MountPublicRoutes(router, deps)
	body := `{
		"subscription_id":"whsub_1",
		"event":{
			"id":"ev_2",
			"action":"updated",
			"object_type":"opportunity",
			"object_id":"oppo_1",
			"organization_id":"orga_1",
			"data":{
				"id":"oppo_1",
				"title":"Enterprise Expansion",
				"status_type":"won",
				"contact_id":"cont_1",
				"value":100000
			}
		}
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/crm-integrations/close/webhooks/route_close_1", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	signCloseWebhookRequest(req, closeWebhookTestSignatureKey, body)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if gotPath != "/api/v1/contact/cont_1/" {
		t.Fatalf("got contact hydrate path %q", gotPath)
	}
	if len(profiles.contacts) != 1 || profiles.contacts[0].Email != "ada@example.com" {
		t.Fatalf("contacts=%+v", profiles.contacts)
	}
	if len(events.events) != 1 {
		t.Fatalf("events=%+v", events.events)
	}
	event := events.events[0]
	if event.SourceID != "close://opportunity/oppo_1" || event.Email != "ada@example.com" || event.EventName != "crm.opportunity.won" {
		t.Fatalf("event=%+v", event)
	}
	if store.lastWebhookTopic != "opportunity.updated" || !store.webhookProcessed || store.webhookFailed {
		t.Fatalf("topic=%q processed=%v failed=%v", store.lastWebhookTopic, store.webhookProcessed, store.webhookFailed)
	}
}

func signCloseWebhookRequest(req *http.Request, signatureKey, body string) {
	timestamp := "1782987072"
	key, _ := hex.DecodeString(signatureKey)
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(timestamp))
	_, _ = mac.Write([]byte(body))
	req.Header.Set("close-sig-timestamp", timestamp)
	req.Header.Set("close-sig-hash", hex.EncodeToString(mac.Sum(nil)))
}
