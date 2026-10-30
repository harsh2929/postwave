// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func TestPostscriptWebhookVerifiesSignatureAndTracksPhoneOnlyMessage(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderPostscript
	store.integration.CredentialsRef = "cred_postscript_1"
	store.integration.Settings = map[string]any{"webhook_route_token": "route_ps_1"}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:     store,
		Profiles: profiles,
		Events:   events,
		PostscriptCredentials: fakePostscriptCredentialResolver{creds: PostscriptCredentials{
			APIKey:              "ps_key",
			WebhookSigningToken: "ps_signature",
		}},
		Now: func() time.Time { return time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC) },
	}
	router := chi.NewRouter()
	MountPublicRoutes(router, deps)
	body := `{
		"webhook_id":"wh_1",
		"resource_type":"shop",
		"resource_id":"shop_123",
		"event_time":"2026-07-02T10:11:12.123456",
		"event":"shop.incoming_message",
		"event_data":{
			"id":"im_1",
			"subscriber_id":"sub_1",
			"from_number":"+15551234567",
			"body":"hello"
		}
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/crm-integrations/postscript/webhooks/route_ps_1", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Postscript-Signature", "ps_signature")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.contacts) != 1 || profiles.contacts[0].Phone != "+15551234567" || profiles.contacts[0].Email != "" {
		t.Fatalf("contacts=%+v", profiles.contacts)
	}
	if len(events.events) != 1 || events.events[0].Phone != "+15551234567" || events.events[0].EventName != "sms.inbound_message" {
		t.Fatalf("events=%+v", events.events)
	}
	if store.lastWebhookProvider != ProviderPostscript || store.lastWebhookTopic != "shop.incoming_message" || !store.webhookProcessed || store.webhookFailed {
		t.Fatalf("webhook provider=%q topic=%q processed=%v failed=%v", store.lastWebhookProvider, store.lastWebhookTopic, store.webhookProcessed, store.webhookFailed)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" || store.runs[0].ContactsUpserted != 1 || store.runs[0].EventsTracked != 1 {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestAttentiveWebhookVerifiesHMACAndTracksPhoneOnlyInboundMessage(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderAttentive
	store.integration.CredentialsRef = "cred_attentive_1"
	store.integration.Settings = map[string]any{"attentive_webhook_route_token": "route_att_1"}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:     store,
		Profiles: profiles,
		Events:   events,
		AttentiveCredentials: fakeAttentiveCredentialResolver{creds: AttentiveCredentials{
			APIKey:        "att_key",
			WebhookSecret: "att_secret",
		}},
		Now: func() time.Time { return time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC) },
	}
	router := chi.NewRouter()
	MountPublicRoutes(router, deps)
	body := `{
		"type":"sms.inbound_message",
		"timestamp":1782987072123,
		"company":{"display_name":"Hudson & Ivy","company_id":"company_1"},
		"subscriber":{"phone":"+15559876543","external_id":12345},
		"message":{"type":"TYPE_CONVERSATION","text":"Hello Friends!","to_phone":"+174881"}
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/crm-integrations/attentive/webhooks/route_att_1", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-attentive-hmac-sha256", signAttentiveWebhookTest("att_secret", []byte(body)))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.contacts) != 1 || profiles.contacts[0].Phone != "+15559876543" || profiles.contacts[0].SourceID != "attentive://subscriber/12345" {
		t.Fatalf("contacts=%+v", profiles.contacts)
	}
	if len(events.events) != 1 || events.events[0].Phone != "+15559876543" || events.events[0].EventName != "sms.inbound_message" {
		t.Fatalf("events=%+v", events.events)
	}
	if store.lastWebhookProvider != ProviderAttentive || store.lastWebhookTopic != "sms.inbound_message" || !store.webhookProcessed || store.webhookFailed {
		t.Fatalf("webhook provider=%q topic=%q processed=%v failed=%v", store.lastWebhookProvider, store.lastWebhookTopic, store.webhookProcessed, store.webhookFailed)
	}
}

func TestSMSWebhookRejectsInvalidSignatureBeforeClaim(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderPostscript
	store.integration.CredentialsRef = "cred_postscript_1"
	store.integration.Settings = map[string]any{"webhook_route_token": "route_ps_1"}
	deps := &Deps{
		Repo:     store,
		Profiles: &fakeProfileSink{},
		Events:   &fakeEventSink{},
		PostscriptCredentials: fakePostscriptCredentialResolver{creds: PostscriptCredentials{
			APIKey:              "ps_key",
			WebhookSigningToken: "ps_signature",
		}},
	}
	router := chi.NewRouter()
	MountPublicRoutes(router, deps)
	req := httptest.NewRequest(http.MethodPost, "/api/public/crm-integrations/postscript/webhooks/route_ps_1", strings.NewReader(`{"event":"shop.incoming_message"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Postscript-Signature", "wrong")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.webhookClaimCount != 0 || len(store.runs) != 0 {
		t.Fatalf("claim_count=%d runs=%+v", store.webhookClaimCount, store.runs)
	}
}

func signAttentiveWebhookTest(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}
