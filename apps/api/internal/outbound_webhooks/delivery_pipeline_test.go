// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"encoding/json"
	"testing"
)

func TestPrepareDeliveryFailsClosedWithoutConfig(t *testing.T) {
	if _, err := prepareDelivery(nil, map[string]any{"event": map[string]any{}}); err == nil {
		t.Fatal("prepareDelivery(nil) succeeded; want fail-closed error")
	}
}

func TestPrepareDeliveryUsesTheProductionFilterBeforeSending(t *testing.T) {
	filter, err := ParseFilter("event.type == subscriber.added")
	if err != nil {
		t.Fatalf("ParseFilter: %v", err)
	}
	prepared, err := prepareDelivery(&DeliveryConfig{Filter: filter}, map[string]any{
		"event": map[string]any{"type": "campaign.sent"},
	})
	if err != nil {
		t.Fatalf("prepareDelivery: %v", err)
	}
	if !prepared.Filtered {
		t.Fatal("non-matching payload was prepared for network delivery")
	}
	if len(prepared.Body) != 0 {
		t.Fatalf("filtered body = %q; want no sendable body", prepared.Body)
	}
}

func TestPrepareDeliveryReturnsTheTransformedBodyThatWillBeSigned(t *testing.T) {
	prepared, err := prepareDelivery(&DeliveryConfig{
		Transform: map[string]any{
			"email":       "/event/data/email",
			"delivery_id": "/delivery/id",
		},
	}, map[string]any{
		"event": map[string]any{
			"type": "subscriber.added",
			"data": map[string]any{"email": "person@example.com", "plan": "pro"},
		},
		"delivery": map[string]any{"id": "delivery-123", "attempt": 1},
	})
	if err != nil {
		t.Fatalf("prepareDelivery: %v", err)
	}
	if prepared.Filtered {
		t.Fatal("matching payload was reported as filtered")
	}
	var got map[string]any
	if err := json.Unmarshal(prepared.Body, &got); err != nil {
		t.Fatalf("decode prepared body: %v", err)
	}
	if got["email"] != "person@example.com" || got["delivery_id"] != "delivery-123" {
		t.Fatalf("transformed body = %#v; want projected email and delivery id", got)
	}
	if _, leaked := got["event"]; leaked {
		t.Fatalf("transformed body retained unprojected envelope: %#v", got)
	}
}
