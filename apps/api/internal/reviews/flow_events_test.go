// SPDX-License-Identifier: AGPL-3.0-only
package reviews

import (
	"context"
	"testing"
)

type captureEmitter struct {
	events []FlowEvent
	tenant string
}

func (c *captureEmitter) EmitFlowEvent(_ context.Context, tenantID string, ev FlowEvent) {
	c.tenant = tenantID
	c.events = append(c.events, ev)
}

func TestEmitReviewSubmitted(t *testing.T) {
	cap := &captureEmitter{}
	d := &Deps{FlowEvents: cap}
	d.emitReviewSubmitted(context.Background(), "t1", &Review{
		ID:            "rv1",
		ProductID:     "prod-9",
		ReviewerEmail: "buyer@example.test",
		Rating:        5,
		Status:        "pending",
		ReviewType:    "product",
	})
	if len(cap.events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(cap.events))
	}
	ev := cap.events[0]
	if cap.tenant != "t1" {
		t.Errorf("tenant = %q, want t1", cap.tenant)
	}
	if ev.EventName != EventReviewSubmitted {
		t.Errorf("event name = %q, want %q", ev.EventName, EventReviewSubmitted)
	}
	if ev.Email != "buyer@example.test" {
		t.Errorf("email = %q", ev.Email)
	}
	if ev.Props["product_id"] != "prod-9" || ev.Props["rating"] != 5 || ev.Props["review_id"] != "rv1" {
		t.Errorf("props missing expected fields: %#v", ev.Props)
	}
}

func TestEmitReviewSubmitted_GuardsNilAndNoEmail(t *testing.T) {
	// nil emitter must not panic.
	(&Deps{}).emitReviewSubmitted(context.Background(), "t1", &Review{ReviewerEmail: "a@b.test"})

	// No reviewer email → nothing to resolve a subscriber from → no emit.
	cap := &captureEmitter{}
	(&Deps{FlowEvents: cap}).emitReviewSubmitted(context.Background(), "t1", &Review{ID: "rv2", Rating: 4})
	if len(cap.events) != 0 {
		t.Fatalf("expected no event without reviewer email, got %d", len(cap.events))
	}
}

func TestEmitReviewRequested(t *testing.T) {
	cap := &captureEmitter{}
	d := &Deps{FlowEvents: cap}
	d.emitReviewRequested(context.Background(), "t1", &ReviewRequest{
		ID:           "req1",
		ProductID:    "prod-3",
		OrderID:      "ord-7",
		SubscriberID: "sub-42",
		Channel:      "email",
	})
	if len(cap.events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(cap.events))
	}
	ev := cap.events[0]
	if ev.EventName != EventReviewRequested {
		t.Errorf("event name = %q, want %q", ev.EventName, EventReviewRequested)
	}
	if ev.SubscriberID != "sub-42" {
		t.Errorf("subscriber_id = %q", ev.SubscriberID)
	}
	if ev.Props["request_id"] != "req1" || ev.Props["product_id"] != "prod-3" {
		t.Errorf("props missing expected fields: %#v", ev.Props)
	}
}

func TestEmitReviewRequested_GuardsNoIdentity(t *testing.T) {
	cap := &captureEmitter{}
	// Neither subscriber id nor email → no subscriber to enroll → no emit.
	(&Deps{FlowEvents: cap}).emitReviewRequested(context.Background(), "t1", &ReviewRequest{ID: "req2", ProductID: "p"})
	if len(cap.events) != 0 {
		t.Fatalf("expected no event without identity, got %d", len(cap.events))
	}
}
