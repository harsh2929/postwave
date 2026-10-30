package runtime

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/services/automation/internal/canonical"
)

type lifecycleInboxFunc func(context.Context, EngagementEvent) error

func (f lifecycleInboxFunc) Dispatch(ctx context.Context, ev EngagementEvent) error {
	return f(ctx, ev)
}

const validLifecycleHTTPBody = `{
  "tenant_id":"11111111-1111-4111-8111-111111111111",
  "subscriber_id":"22222222-2222-4222-8222-222222222222",
  "event_type":"subscriber_lifecycle_stage_changed",
  "source_event_id":"lifecycle-outbox:33333333-3333-4333-8333-333333333333",
  "transition_sequence":1,
  "at":"2026-07-19T06:00:00Z",
  "payload":{"from_stage":"subscriber","to_stage":"lead","score":4}
}`

func lifecycleHTTPRequest(body, idempotencyKey string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/v1/automations/event", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if idempotencyKey != "" {
		req.Header.Set("Idempotency-Key", idempotencyKey)
	}
	return req
}

func TestLifecycleHTTPHandlerRequiresDurableInbox(t *testing.T) {
	rec := httptest.NewRecorder()
	(&EventDispatcher{}).HTTPHandler().ServeHTTP(rec, lifecycleHTTPRequest(
		validLifecycleHTTPBody,
		"lifecycle-outbox:33333333-3333-4333-8333-333333333333",
	))
	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "1" {
		t.Fatalf("status/retry-after = %d/%q, body=%s", rec.Code, rec.Header().Get("Retry-After"), rec.Body.String())
	}
}

func TestLifecycleHTTPHandlerRequiresExactIdempotencyKey(t *testing.T) {
	called := false
	dispatcher := &EventDispatcher{LifecycleInbox: lifecycleInboxFunc(func(context.Context, EngagementEvent) error {
		called = true
		return nil
	})}
	rec := httptest.NewRecorder()
	dispatcher.HTTPHandler().ServeHTTP(rec, lifecycleHTTPRequest(validLifecycleHTTPBody, "different-event"))
	if rec.Code != http.StatusBadRequest || called {
		t.Fatalf("status/called = %d/%v, body=%s", rec.Code, called, rec.Body.String())
	}
}

func TestLifecycleHTTPHandlerDoesNotAcknowledgePartialOrOutOfOrderDispatch(t *testing.T) {
	cases := []struct {
		name       string
		err        error
		wantStatus int
	}{
		{name: "partial dispatch", err: ErrLifecycleDispatchFailed, wantStatus: http.StatusServiceUnavailable},
		{name: "out of order", err: ErrLifecycleEventOutOfOrder, wantStatus: http.StatusTooEarly},
		{name: "conflicting replay", err: ErrLifecycleEventConflict, wantStatus: http.StatusConflict},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dispatcher := &EventDispatcher{LifecycleInbox: lifecycleInboxFunc(func(context.Context, EngagementEvent) error {
				return tc.err
			})}
			rec := httptest.NewRecorder()
			dispatcher.HTTPHandler().ServeHTTP(rec, lifecycleHTTPRequest(
				validLifecycleHTTPBody,
				"lifecycle-outbox:33333333-3333-4333-8333-333333333333",
			))
			if rec.Code != tc.wantStatus {
				t.Fatalf("status=%d, want %d; body=%s", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if (errors.Is(tc.err, ErrLifecycleDispatchFailed) || errors.Is(tc.err, ErrLifecycleEventOutOfOrder)) &&
				rec.Header().Get("Retry-After") != "1" {
				t.Fatalf("retry-after=%q", rec.Header().Get("Retry-After"))
			}
		})
	}
}

func TestLifecycleHTTPHandlerAcknowledgesOnlyDurableAcceptance(t *testing.T) {
	var got EngagementEvent
	dispatcher := &EventDispatcher{LifecycleInbox: lifecycleInboxFunc(func(_ context.Context, ev EngagementEvent) error {
		got = ev
		return nil
	})}
	rec := httptest.NewRecorder()
	dispatcher.HTTPHandler().ServeHTTP(rec, lifecycleHTTPRequest(
		validLifecycleHTTPBody,
		"lifecycle-outbox:33333333-3333-4333-8333-333333333333",
	))
	if rec.Code != http.StatusAccepted || got.SubscriberID == "" || got.TransitionSequence != 1 {
		t.Fatalf("status/event = %d/%#v, body=%s", rec.Code, got, rec.Body.String())
	}
}

func TestLifecycleReceiptRejectsAmbiguousCanonicalFields(t *testing.T) {
	base := func() EngagementEvent {
		return EngagementEvent{
			TenantID:           "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
			SubscriberID:       "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB",
			EventType:          canonical.TriggerLifecycleStageChanged,
			SourceEventID:      "lifecycle-outbox:44444444-4444-4444-8444-444444444444",
			TransitionSequence: 7,
			At:                 time.Date(2026, 7, 19, 7, 0, 0, 0, time.UTC),
			Payload: map[string]interface{}{
				"event_name":          canonical.TriggerLifecycleStageChanged,
				"from_stage":          "lead",
				"previous_stage":      "lead",
				"to_stage":            "mql",
				"stage":               "mql",
				"score":               float64(4),
				"transition_sequence": float64(7),
			},
		}
	}

	valid := base()
	receipt, err := receiptFromEngagementEvent(valid)
	if err != nil {
		t.Fatalf("valid canonical receipt: %v", err)
	}
	if receipt.TenantID != strings.ToLower(valid.TenantID) || receipt.SubscriberID != strings.ToLower(valid.SubscriberID) {
		t.Fatalf("UUID identity was not normalized: %#v", receipt)
	}

	tests := []struct {
		name   string
		mutate func(map[string]interface{})
	}{
		{name: "destination aliases disagree", mutate: func(p map[string]interface{}) { p["stage"] = "sql" }},
		{name: "origin aliases disagree", mutate: func(p map[string]interface{}) { p["previous_stage"] = "subscriber" }},
		{name: "event name disagrees", mutate: func(p map[string]interface{}) { p["event_name"] = "product_event" }},
		{name: "sequence disagrees", mutate: func(p map[string]interface{}) { p["transition_sequence"] = float64(8) }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			event := base()
			tc.mutate(event.Payload)
			if _, err := receiptFromEngagementEvent(event); !errors.Is(err, ErrInvalidLifecycleEvent) {
				t.Fatalf("ambiguous receipt error=%v, want ErrInvalidLifecycleEvent", err)
			}
		})
	}
}
