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

func TestHighLevelWebhookHydratesContactAndUpsertsProfile(t *testing.T) {
	var gotPath, gotAuth, gotVersion string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotVersion = r.Header.Get("Version")
		if r.URL.Path != "/contacts/c1" {
			t.Fatalf("unexpected path %q", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"contact": map[string]any{
				"id": "c1", "email": "Buyer@Example.com", "firstName": "Ada", "lastName": "L",
				"phone": "+15551234567", "companyName": "Acme", "locationId": "loc-123",
			},
		})
	}))
	defer srv.Close()

	store := newFakeStore()
	store.integration.Provider = ProviderHighLevel
	store.integration.CredentialsRef = "cred_highlevel_1"
	store.integration.Settings = map[string]any{"webhook_route_token": "route_hl_1", "location_id": "loc-123", "api_base_url": srv.URL}
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:                 store,
		Profiles:             profiles,
		HighLevelCredentials: fakeHighLevelCredentialResolver{creds: HighLevelCredentials{AccessToken: "ghl.at", LocationID: "loc-123"}},
		Now:                  func() time.Time { return time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC) },
	}
	router := chi.NewRouter()
	MountPublicRoutes(router, deps)
	body := `{"type":"ContactUpdate","locationId":"loc-123","id":"c1","dateAdded":"2026-07-02T12:00:00.000Z"}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/crm-integrations/highlevel/webhooks/route_hl_1", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if gotPath != "/contacts/c1" || gotAuth != "Bearer ghl.at" || gotVersion != highLevelAPIVersion {
		t.Fatalf("hydrate request path/auth/version=%q/%q/%q", gotPath, gotAuth, gotVersion)
	}
	if len(profiles.contacts) != 1 {
		t.Fatalf("contacts=%+v", profiles.contacts)
	}
	contact := profiles.contacts[0]
	if contact.SourceID != "highlevel://contact/c1" || contact.Email != "buyer@example.com" || contact.Company != "Acme" || contact.Phone != "+15551234567" {
		t.Fatalf("contact=%+v", contact)
	}
	if contact.Properties["highlevel_webhook_type"] != "ContactUpdate" || contact.Properties["highlevel_webhook_topic"] != "contact.updated" {
		t.Fatalf("contact webhook properties=%+v", contact.Properties)
	}
	if store.lastWebhookProvider != ProviderHighLevel || store.lastWebhookTopic != "contact.updated" || !strings.Contains(store.lastWebhookID, "highlevel:loc-123:contact.updated:c1") {
		t.Fatalf("webhook provider/topic/id = %q/%q/%q", store.lastWebhookProvider, store.lastWebhookTopic, store.lastWebhookID)
	}
	if !store.webhookProcessed || store.webhookFailed || len(store.runs) != 1 || store.runs[0].RunMode != "webhook" || store.runs[0].ContactsUpserted != 1 {
		t.Fatalf("processed=%v failed=%v runs=%+v", store.webhookProcessed, store.webhookFailed, store.runs)
	}
}

func TestHighLevelWebhookHydratesOpportunityAndTracksEvent(t *testing.T) {
	var gotPaths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPaths = append(gotPaths, r.URL.Path)
		switch r.URL.Path {
		case "/opportunities/opp-1":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"opportunity": map[string]any{
					"id": "opp-1", "name": "Expansion", "status": "won", "monetaryValue": 4200,
					"pipelineId": "pipe-1", "pipelineStageId": "stage-2", "contactId": "c1", "updatedAt": "2026-07-02T12:00:00Z",
				},
			})
		case "/contacts/c1":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"contact": map[string]any{"id": "c1", "email": "Buyer@Example.com", "firstName": "Ada", "phone": "+15551234567"},
			})
		default:
			t.Fatalf("unexpected path %q", r.URL.Path)
		}
	}))
	defer srv.Close()

	store := newFakeStore()
	store.integration.Provider = ProviderHighLevel
	store.integration.CredentialsRef = "cred_highlevel_1"
	store.integration.Settings = map[string]any{"webhook_route_token": "route_hl_1", "location_id": "loc-123", "api_base_url": srv.URL}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:                 store,
		Profiles:             &fakeProfileSink{},
		Events:               events,
		HighLevelCredentials: fakeHighLevelCredentialResolver{creds: HighLevelCredentials{AccessToken: "ghl.at", LocationID: "loc-123"}},
		Now:                  func() time.Time { return time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC) },
	}
	router := chi.NewRouter()
	MountPublicRoutes(router, deps)
	body := `{"type":"OpportunityStatusUpdate","locationId":"loc-123","id":"opp-1","contactId":"c1","dateAdded":"2026-07-02T12:00:00.000Z"}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/crm-integrations/highlevel/webhooks/route_hl_1", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if strings.Join(gotPaths, ",") != "/opportunities/opp-1,/contacts/c1" {
		t.Fatalf("paths=%+v", gotPaths)
	}
	if len(events.events) != 1 {
		t.Fatalf("events=%+v", events.events)
	}
	event := events.events[0]
	if event.SourceID != "highlevel://opportunity/opp-1/contact/c1" || event.Email != "buyer@example.com" || event.EventName != "crm.deal.won" {
		t.Fatalf("event=%+v", event)
	}
	if event.Properties["highlevel_webhook_type"] != "OpportunityStatusUpdate" || event.Properties["highlevel_webhook_topic"] != "opportunity.updated" {
		t.Fatalf("event webhook properties=%+v", event.Properties)
	}
	if store.webhookClaimCount != 1 || store.lastWebhookTopic != "opportunity.updated" || !store.webhookProcessed || store.webhookFailed || len(store.runs) != 1 || store.runs[0].EventsTracked != 1 {
		t.Fatalf("claim=%d topic=%q processed=%v failed=%v runs=%+v", store.webhookClaimCount, store.lastWebhookTopic, store.webhookProcessed, store.webhookFailed, store.runs)
	}
}

func TestHighLevelWebhookHydratesAppointmentAndConversationEvents(t *testing.T) {
	var gotPaths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPaths = append(gotPaths, r.URL.Path)
		switch r.URL.Path {
		case "/calendars/events/appointments/appt-1":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"appointment": map[string]any{
					"id": "appt-1", "title": "Demo", "calendarId": "cal-1", "contactId": "c1",
					"appointmentStatus": "confirmed", "startTime": "2026-07-03T12:00:00Z",
				},
			})
		case "/conversations/conv-1":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"conversation": map[string]any{
					"id": "conv-1", "contactId": "c1", "channel": "SMS", "lastMessageDate": "2026-07-04T09:00:00Z",
				},
			})
		case "/contacts/c1":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"contact": map[string]any{"id": "c1", "email": "Buyer@Example.com", "firstName": "Ada", "phone": "+15551234567"},
			})
		default:
			t.Fatalf("unexpected path %q", r.URL.Path)
		}
	}))
	defer srv.Close()

	store := newFakeStore()
	store.integration.Provider = ProviderHighLevel
	store.integration.CredentialsRef = "cred_highlevel_1"
	store.integration.Settings = map[string]any{"webhook_route_token": "route_hl_1", "location_id": "loc-123", "api_base_url": srv.URL}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:                 store,
		Profiles:             &fakeProfileSink{},
		Events:               events,
		HighLevelCredentials: fakeHighLevelCredentialResolver{creds: HighLevelCredentials{AccessToken: "ghl.at", LocationID: "loc-123"}},
		Now:                  func() time.Time { return time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC) },
	}
	router := chi.NewRouter()
	MountPublicRoutes(router, deps)

	appointmentBody := `{"type":"AppointmentUpdate","locationId":"loc-123","appointment":{"id":"appt-1","contactId":"c1","dateUpdated":"2026-07-02T12:00:00.000Z"}}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/crm-integrations/highlevel/webhooks/route_hl_1", strings.NewReader(appointmentBody))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("appointment status=%d body=%s", rec.Code, rec.Body.String())
	}

	conversationBody := `{"type":"InboundMessage","locationId":"loc-123","conversationId":"conv-1","contactId":"c1","messageId":"msg-1","dateAdded":"2026-07-02T12:05:00.000Z"}`
	req = httptest.NewRequest(http.MethodPost, "/api/public/crm-integrations/highlevel/webhooks/route_hl_1", strings.NewReader(conversationBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("conversation status=%d body=%s", rec.Code, rec.Body.String())
	}

	if strings.Join(gotPaths, ",") != "/calendars/events/appointments/appt-1,/contacts/c1,/conversations/conv-1,/contacts/c1" {
		t.Fatalf("paths=%+v", gotPaths)
	}
	if len(events.events) != 2 {
		t.Fatalf("events=%+v", events.events)
	}
	appointment := events.events[0]
	if appointment.SourceID != "highlevel://appointment/appt-1/contact/c1" || appointment.Email != "buyer@example.com" || appointment.EventName != "crm.appointment.updated" {
		t.Fatalf("appointment=%+v", appointment)
	}
	conversation := events.events[1]
	if conversation.SourceID != "highlevel://conversation/conv-1/contact/c1" || conversation.Email != "buyer@example.com" || conversation.EventName != "crm.conversation.updated" {
		t.Fatalf("conversation=%+v", conversation)
	}
	if conversation.Properties["highlevel_webhook_topic"] != "message.created" || conversation.Properties["highlevel_webhook_message_id"] != "msg-1" {
		t.Fatalf("conversation properties=%+v", conversation.Properties)
	}
	if store.webhookClaimCount != 2 || !store.webhookProcessed || store.webhookFailed || len(store.runs) != 2 || store.runs[0].EventsTracked != 1 || store.runs[1].EventsTracked != 1 {
		t.Fatalf("claim=%d processed=%v failed=%v runs=%+v", store.webhookClaimCount, store.webhookProcessed, store.webhookFailed, store.runs)
	}
}

func TestHighLevelWebhookRejectsLocationMismatchBeforeClaim(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderHighLevel
	store.integration.CredentialsRef = "cred_highlevel_1"
	store.integration.Settings = map[string]any{"webhook_route_token": "route_hl_1", "location_id": "loc-123"}
	deps := &Deps{
		Repo:                 store,
		Profiles:             &fakeProfileSink{},
		Events:               &fakeEventSink{},
		HighLevelCredentials: fakeHighLevelCredentialResolver{creds: HighLevelCredentials{AccessToken: "ghl.at", LocationID: "loc-123"}},
	}
	router := chi.NewRouter()
	MountPublicRoutes(router, deps)
	body := `{"type":"ContactUpdate","locationId":"wrong-location","id":"c1","dateAdded":"2026-07-02T12:00:00.000Z"}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/crm-integrations/highlevel/webhooks/route_hl_1", strings.NewReader(body))
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
