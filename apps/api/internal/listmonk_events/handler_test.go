package listmonk_events

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestDispatchForwardsInternalBearer(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if r.URL.Path != "/v1/automations/event" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	d := &Deps{
		AutomationServiceURL: srv.URL,
		InternalAPIToken:     "secret",
		HTTPClient:           srv.Client(),
	}
	if err := d.dispatch(t.Context(), CanonicalEvent{
		TenantID:        "00000000-0000-0000-0000-000000000001",
		SubscriberEmail: "reader@example.com",
		EventType:       EventOpened,
		At:              time.Now().UTC(),
	}); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if gotAuth != "Bearer secret" {
		t.Fatalf("Authorization = %q, want bearer token", gotAuth)
	}
}

func TestHandleRejectsOversizedBody(t *testing.T) {
	d := &Deps{}
	req := httptest.NewRequest(http.MethodPost, "/api/internal/listmonk/events",
		strings.NewReader(strings.Repeat("x", int(listmonkEventMaxBodyBytes)+1)))
	rec := httptest.NewRecorder()

	d.Handle(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413; body=%s", rec.Code, rec.Body.String())
	}
}

func TestHandleWithMembershipsRejectsOversizedBodyBeforeBaseDispatch(t *testing.T) {
	d := &Deps{}
	req := httptest.NewRequest(http.MethodPost, "/api/internal/listmonk/events",
		strings.NewReader(strings.Repeat("x", int(listmonkEventMaxBodyBytes)+1)))
	rec := httptest.NewRecorder()

	d.HandleWithMemberships(nil)(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"payload_too_large"`) {
		t.Fatalf("body = %s, want stable payload_too_large code", rec.Body.String())
	}
}

func TestHandleReturnsRetryablePartialFailureWithoutStarvingBatch(t *testing.T) {
	sentinel := errors.New("injected persistence failure")
	calls := 0
	failSecondOnce := true
	inserted := map[string]int{}
	bus := &recordingBus{}
	d := &Deps{
		AllowUnsignedDevBypass: true,
		Bus:                    bus,
		persistEvent: func(_ context.Context, ev CanonicalEvent) (canonicalPersistResult, error) {
			calls++
			if ev.ProviderEventID == "evt-2" && failSecondOnce {
				failSecondOnce = false
				return canonicalPersistResult{}, sentinel
			}
			if inserted[ev.ProviderEventID] != 0 {
				return canonicalPersistResult{}, nil
			}
			inserted[ev.ProviderEventID]++
			return canonicalPersistResult{Inserted: true}, nil
		},
	}

	data, err := json.Marshal(OpenedEventData{
		Subscriber: SubscriberRef{Email: "reader@example.test"},
	})
	if err != nil {
		t.Fatalf("marshal data: %v", err)
	}
	envelopes := []WebhookEnvelope{
		{
			ProviderEventMetadata: ProviderEventMetadata{ID: "evt-1"},
			Type:                  WireOpened,
			TenantID:              "00000000-0000-0000-0000-000000000001",
			Data:                  data,
		},
		{
			ProviderEventMetadata: ProviderEventMetadata{ID: "evt-2"},
			Type:                  WireOpened,
			TenantID:              "00000000-0000-0000-0000-000000000001",
			Data:                  data,
		},
		{
			ProviderEventMetadata: ProviderEventMetadata{ID: "evt-3"},
			Type:                  WireOpened,
			TenantID:              "00000000-0000-0000-0000-000000000001",
			Data:                  data,
		},
	}
	body, err := json.Marshal(envelopes)
	if err != nil {
		t.Fatalf("marshal envelopes: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/internal/listmonk/events", strings.NewReader(string(body)))
	rec := httptest.NewRecorder()

	d.Handle(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body=%s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Retry-After") != "1" {
		t.Fatalf("Retry-After = %q, want 1", rec.Header().Get("Retry-After"))
	}
	if !strings.Contains(rec.Body.String(), `"code":"event_persist_failed"`) {
		t.Fatalf("body = %s, want event_persist_failed", rec.Body.String())
	}
	if calls != 3 {
		t.Fatalf("persist calls = %d, want all 3 envelopes attempted", calls)
	}
	if len(bus.events) != 2 {
		t.Fatalf("first-attempt bus events = %d, want 2 durable successes", len(bus.events))
	}

	retryReq := httptest.NewRequest(http.MethodPost, "/api/internal/listmonk/events", strings.NewReader(string(body)))
	retryRec := httptest.NewRecorder()
	d.Handle(retryRec, retryReq)

	if retryRec.Code != http.StatusOK {
		t.Fatalf("retry status = %d, want 200; body=%s", retryRec.Code, retryRec.Body.String())
	}
	if calls != 6 {
		t.Fatalf("persist calls after retry = %d, want 6", calls)
	}
	if len(bus.events) != 3 {
		t.Fatalf("bus events after retry = %d, want exactly one per logical event", len(bus.events))
	}
	for _, id := range []string{"evt-1", "evt-2", "evt-3"} {
		if inserted[id] != 1 {
			t.Fatalf("logical insert count for %s = %d, want 1", id, inserted[id])
		}
	}
}

func TestHandleControlledSeedKeepsEvidenceButSuppressesEngagementFanout(t *testing.T) {
	dispatches := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		dispatches++
		w.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()
	bus := &recordingBus{}
	d := &Deps{
		AllowUnsignedDevBypass: true,
		AutomationServiceURL:   server.URL,
		HTTPClient:             server.Client(),
		Bus:                    bus,
		persistEvent: func(context.Context, CanonicalEvent) (canonicalPersistResult, error) {
			return canonicalPersistResult{
				Inserted: true, ControlledSeed: true,
				SeedTestID: "00000000-0000-0000-0000-000000000099",
			}, nil
		},
	}
	data, err := json.Marshal(OpenedEventData{Subscriber: SubscriberRef{Email: "seed@example.test"}})
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(WebhookEnvelope{
		Type: WireOpened, TenantID: "00000000-0000-0000-0000-000000000001", Data: data,
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/internal/listmonk/events", strings.NewReader(string(body)))
	response := httptest.NewRecorder()
	d.Handle(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"accepted":1`) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if dispatches != 0 || len(bus.events) != 0 {
		t.Fatalf("controlled seed produced automation=%d bus=%d", dispatches, len(bus.events))
	}
}

func TestSuppressionMapping(t *testing.T) {
	cases := []struct {
		name             string
		event            CanonicalEvent
		reason           string
		subscriberStatus string
		mailchimpStatus  string
	}{
		{
			name: "hard bounce cleans contact",
			event: CanonicalEvent{
				EventType:  EventBounced,
				BounceType: "hard",
			},
			reason:           "hard_bounce",
			subscriberStatus: "blocklisted",
			mailchimpStatus:  "cleaned",
		},
		{
			name: "soft bounce remains observable only",
			event: CanonicalEvent{
				EventType:  EventBounced,
				BounceType: "soft",
			},
		},
		{
			name: "complaint cleans contact",
			event: CanonicalEvent{
				EventType: EventComplained,
			},
			reason:           "complaint",
			subscriberStatus: "blocklisted",
			mailchimpStatus:  "cleaned",
		},
		{
			name: "unsubscribe disables contact",
			event: CanonicalEvent{
				EventType: EventUnsubscribed,
			},
			reason:           "unsubscribe",
			subscriberStatus: "disabled",
			mailchimpStatus:  "unsubscribed",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reason, sub, mc := suppressionMapping(tc.event)
			if reason != tc.reason || sub != tc.subscriberStatus || mc != tc.mailchimpStatus {
				t.Fatalf("mapping = (%q,%q,%q), want (%q,%q,%q)", reason, sub, mc, tc.reason, tc.subscriberStatus, tc.mailchimpStatus)
			}
		})
	}
}

func TestTranslatePreservesEventMetadata(t *testing.T) {
	body, _ := json.Marshal(BouncedEventData{
		ProviderEventMetadata: ProviderEventMetadata{MessageID: "msg_123"},
		Subscriber:            SubscriberRef{Email: "Reader@Example.com"},
		Campaign:              CampaignRef{UUID: "00000000-0000-0000-0000-000000000123"},
		Type:                  "hard",
		Reason:                "mailbox unavailable",
	})
	ev, err := Translate(WebhookEnvelope{
		ProviderEventMetadata: ProviderEventMetadata{ID: "evt_123"},
		Type:                  WireBounced,
		TenantID:              "00000000-0000-0000-0000-000000000001",
		Data:                  body,
	})
	if err != nil {
		t.Fatalf("Translate: %v", err)
	}
	if ev.Source != "listmonk" || ev.ProviderEventID != "evt_123" || ev.MessageID != "msg_123" {
		t.Fatalf("metadata fields not preserved: %#v", ev)
	}
	if ev.SubscriberEmail != "reader@example.com" {
		t.Fatalf("email = %q", ev.SubscriberEmail)
	}
	if got, _ := ev.Metadata["bounce_type"].(string); got != "hard" {
		t.Fatalf("bounce_type = %q", got)
	}
	if ev.BounceType != "hard" || ev.Reason != "mailbox unavailable" {
		t.Fatalf("deliverability details not preserved: %#v", ev)
	}
}

func TestEventPersistenceHelpersAvoidUnsafeCasts(t *testing.T) {
	const campaignID = "00000000-0000-0000-0000-000000000123"
	if got := nullableUUID(campaignID); got != campaignID {
		t.Fatalf("nullableUUID(valid) = %#v", got)
	}
	if got := nullableUUID("42"); got != nil {
		t.Fatalf("nullableUUID(numeric listmonk id) = %#v, want nil", got)
	}
	if got := nullableIP("203.0.113.10"); got != "203.0.113.10" {
		t.Fatalf("nullableIP(valid) = %#v", got)
	}
	if got := nullableIP("203.0.113.10:25"); got != nil {
		t.Fatalf("nullableIP(with port) = %#v, want nil", got)
	}

	meta := eventMetadata(CanonicalEvent{
		CampaignID:      "42",
		Source:          "",
		ProviderEventID: "evt_123",
		MessageID:       "msg_123",
		EventType:       EventClicked,
	})
	if meta["source"] != "listmonk" {
		t.Fatalf("source metadata = %#v", meta["source"])
	}
	if meta["campaign_id_raw"] != "42" {
		t.Fatalf("campaign_id_raw = %#v", meta["campaign_id_raw"])
	}
	if meta["provider_event_id"] != "evt_123" || meta["message_id"] != "msg_123" {
		t.Fatalf("provider metadata missing: %#v", meta)
	}
}

func TestDecodeEnvelopesAcceptsArrayAndSingle(t *testing.T) {
	body, _ := json.Marshal(WebhookEnvelope{Type: "open"})
	one, err := decodeEnvelopes(body)
	if err != nil || len(one) != 1 {
		t.Fatalf("single len=%d err=%v", len(one), err)
	}
	arr, err := decodeEnvelopes([]byte(`[{"type":"open"},{"type":"click"}]`))
	if err != nil || len(arr) != 2 {
		t.Fatalf("array len=%d err=%v", len(arr), err)
	}
}
