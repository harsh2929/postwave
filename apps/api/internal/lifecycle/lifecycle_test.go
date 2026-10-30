// SPDX-License-Identifier: AGPL-3.0-only
//
// lifecycle_test.go — SUB-136 lifecycle-stage automation forwarding.
//
// Covers the HTTPAutomationForwarder envelope contract (the wire shape the
// automation runtime's EventDispatcher decodes) and fail-closed behaviour when
// the automation service is unavailable. These are pure HTTP-roundtrip tests
// with no DB dependency.
package lifecycle

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/outbox"
)

// TestHTTPAutomationForwarder_Envelope pins the wire contract: the forwarder
// POSTs to {base}/v1/automations/event with the canonical event_type, the
// subscriber email as the runtime join key, and the transition stages on the
// payload under both naming conventions.
func TestHTTPAutomationForwarder_Envelope(t *testing.T) {
	var gotPath, gotAuth, gotIdempotency string
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotIdempotency = r.Header.Get("Idempotency-Key")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	f := &HTTPAutomationForwarder{
		BaseURL:          srv.URL,
		InternalAPIToken: "secret-token",
		HTTPClient:       srv.Client(),
	}
	err := f.ForwardLifecycleStageChanged(context.Background(), LifecycleStageEvent{
		TenantID:           "11111111-1111-4111-8111-111111111111",
		SubscriberID:       "22222222-2222-4222-8222-222222222222",
		SubscriberEmail:    "user@example.com",
		FromStage:          "opportunity",
		ToStage:            "customer",
		Score:              4,
		At:                 time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC),
		SourceEventID:      "lifecycle-outbox:event-1",
		TransitionSequence: 7,
	})
	if err != nil {
		t.Fatalf("ForwardLifecycleStageChanged: %v", err)
	}
	if gotPath != "/v1/automations/event" {
		t.Errorf("path = %q; want /v1/automations/event", gotPath)
	}
	if gotAuth != "Bearer secret-token" {
		t.Errorf("auth header = %q; want Bearer secret-token", gotAuth)
	}
	if gotIdempotency != "lifecycle-outbox:event-1" || body["source_event_id"] != "lifecycle-outbox:event-1" {
		t.Errorf("idempotency header/body = %q/%v", gotIdempotency, body["source_event_id"])
	}
	if body["tenant_id"] != "11111111-1111-4111-8111-111111111111" {
		t.Errorf("tenant_id = %v", body["tenant_id"])
	}
	if body["subscriber_id"] != "22222222-2222-4222-8222-222222222222" {
		t.Errorf("subscriber_id = %v", body["subscriber_id"])
	}
	if body["transition_sequence"] != float64(7) {
		t.Errorf("transition_sequence = %v; want 7", body["transition_sequence"])
	}
	if body["subscriber_email"] != "user@example.com" {
		t.Errorf("subscriber_email = %v; want user@example.com", body["subscriber_email"])
	}
	if body["event_type"] != LifecycleStageChangedEvent {
		t.Errorf("event_type = %v; want %s", body["event_type"], LifecycleStageChangedEvent)
	}
	payload, ok := body["payload"].(map[string]any)
	if !ok {
		t.Fatalf("payload missing or wrong type: %v", body["payload"])
	}
	if payload["to_stage"] != "customer" || payload["stage"] != "customer" {
		t.Errorf("to_stage/stage = %v/%v; want customer", payload["to_stage"], payload["stage"])
	}
	if payload["from_stage"] != "opportunity" || payload["previous_stage"] != "opportunity" {
		t.Errorf("from_stage/previous_stage = %v/%v; want opportunity", payload["from_stage"], payload["previous_stage"])
	}
	if payload["event_name"] != LifecycleStageChangedEvent {
		t.Errorf("event_name = %v; want %s", payload["event_name"], LifecycleStageChangedEvent)
	}
}

// TestHTTPAutomationForwarder_NoBaseURLFailsClosed pins that an unconfigured
// service cannot silently consume and discard a durable lifecycle intent.
func TestHTTPAutomationForwarder_NoBaseURLFailsClosed(t *testing.T) {
	f := &HTTPAutomationForwarder{}
	if err := f.ForwardLifecycleStageChanged(context.Background(), LifecycleStageEvent{
		TenantID:        "t-1",
		SubscriberEmail: "user@example.com",
		ToStage:         "customer",
	}); err == nil {
		t.Fatal("empty BaseURL silently acknowledged a durable intent")
	}
}

// An environment that runs no automation service says so
// (AUTOMATION_SERVICE_URL=disabled). The intent is acknowledged without a
// request: failing it walked every stage change through ten logged attempts
// into the dead-letter queue, for a service that is not there to receive it.
func TestHTTPAutomationForwarder_NotDeployedAcknowledgesWithoutDelivery(t *testing.T) {
	f := &HTTPAutomationForwarder{NotDeployed: true}
	if err := f.ForwardLifecycleStageChanged(context.Background(), LifecycleStageEvent{
		TenantID:        "t-1",
		SubscriberEmail: "user@example.com",
		ToStage:         "customer",
	}); err != nil {
		t.Fatalf("a not-deployed automation service left the intent to retry: %v", err)
	}
}

func TestAutomationOutboxHandlerFailsClosedWhenUnconfigured(t *testing.T) {
	h := &AutomationOutboxHandler{}
	err := h.Handle(context.Background(), outbox.Event{Kind: AutomationOutboxKind})
	if err == nil {
		t.Fatal("unconfigured lifecycle automation handler unexpectedly succeeded")
	}
}

func TestHTTPAutomationForwarderRetriesNonSuccessResponses(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	f := &HTTPAutomationForwarder{BaseURL: srv.URL, HTTPClient: srv.Client()}
	if err := f.ForwardLifecycleStageChanged(context.Background(), LifecycleStageEvent{
		TenantID:        "11111111-1111-4111-8111-111111111111",
		SubscriberID:    "22222222-2222-4222-8222-222222222222",
		SubscriberEmail: "user@example.test", FromStage: "lead", ToStage: "customer",
		Score: 3, At: time.Now().UTC(), SourceEventID: "lifecycle-outbox:event-2",
		TransitionSequence: 2,
	}); err == nil {
		t.Fatal("non-success automation response was incorrectly acknowledged")
	}
}
