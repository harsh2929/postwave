// SPDX-License-Identifier: AGPL-3.0-only
//
// bus_bridge_test.go — SUB-119: engagement webhooks (subscriber.bounced /
// subscriber.complained, plus the other engagement wires) are bridged to the
// in-process SSE Bus so the desktop's "subscriber.*" wildcard sees them. These
// tests exercise the bridge helpers directly (the full Handle path needs a DB
// + HMAC); the Bus is a tiny recorder so no broker is required.
package listmonk_events

import (
	"testing"
	"time"
)

// recordingBus implements EventBus and captures every published event.
type recordingBus struct {
	events []recordedBusEvent
}

type recordedBusEvent struct {
	tenantID string
	topic    string
	payload  map[string]any
}

func (b *recordingBus) Publish(tenantID, topic string, payload map[string]any) {
	b.events = append(b.events, recordedBusEvent{tenantID: tenantID, topic: topic, payload: payload})
}

// TestBusTopicForEvent maps each canonical engagement type to the subscriber.*
// SSE topic the desktop wildcard consumes. The bounce/complaint mappings are
// the load-bearing SUB-119 additions; unknown types map to "" (no bridge).
func TestBusTopicForEvent(t *testing.T) {
	cases := map[CanonicalEventType]string{
		EventBounced:                   WireBounced,
		EventComplained:                WireComplained,
		EventUnsubscribed:              WireUnsubscribed,
		EventOpened:                    WireOpened,
		EventClicked:                   WireClicked,
		EventDelivered:                 WireDelivered,
		CanonicalEventType("nonsense"): "",
	}
	for in, want := range cases {
		if got := busTopicForEvent(in); got != want {
			t.Errorf("busTopicForEvent(%q) = %q, want %q", in, got, want)
		}
	}
	// Spot-check the exact wire strings so a rename on either side is caught.
	if WireBounced != "subscriber.bounced" || WireComplained != "subscriber.complained" {
		t.Fatalf("wire strings drifted: bounced=%q complained=%q", WireBounced, WireComplained)
	}
}

// TestEmitBus_BridgesBounced — SUB-119: a persisted bounce publishes
// subscriber.bounced to the Bus with the email + bounce_type payload the
// timeline needs.
func TestEmitBus_BridgesBounced(t *testing.T) {
	bus := &recordingBus{}
	d := &Deps{Bus: bus}
	d.emitBus(CanonicalEvent{
		TenantID:        "t1",
		SubscriberEmail: "b@x.com",
		EventType:       EventBounced,
		BounceType:      "hard",
		Reason:          "550 mailbox unavailable",
		CampaignID:      "11111111-1111-4111-8111-111111111111",
		At:              time.Now().UTC(),
	})
	if len(bus.events) != 1 {
		t.Fatalf("emit count = %d, want 1", len(bus.events))
	}
	got := bus.events[0]
	if got.tenantID != "t1" || got.topic != WireBounced {
		t.Fatalf("emit = (%q,%q), want (t1,%s)", got.tenantID, got.topic, WireBounced)
	}
	if got.payload["email"] != "b@x.com" {
		t.Fatalf("payload email = %v, want b@x.com", got.payload["email"])
	}
	if got.payload["bounce_type"] != "hard" {
		t.Fatalf("payload bounce_type = %v, want hard", got.payload["bounce_type"])
	}
	if got.payload["campaign_id"] != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("payload campaign_id = %v, want set", got.payload["campaign_id"])
	}
}

// TestEmitBus_BridgesComplained — SUB-119: a persisted complaint publishes
// subscriber.complained to the Bus.
func TestEmitBus_BridgesComplained(t *testing.T) {
	bus := &recordingBus{}
	d := &Deps{Bus: bus}
	d.emitBus(CanonicalEvent{
		TenantID:        "t1",
		SubscriberEmail: "c@x.com",
		EventType:       EventComplained,
		Reason:          "abuse",
		At:              time.Now().UTC(),
	})
	if len(bus.events) != 1 || bus.events[0].topic != WireComplained {
		t.Fatalf("complaint not bridged; events = %v", bus.events)
	}
	if bus.events[0].payload["reason"] != "abuse" {
		t.Fatalf("payload reason = %v, want abuse", bus.events[0].payload["reason"])
	}
}

// TestEmitBus_NilSafe — SUB-119: emitBus never panics and never publishes when
// the Bus is unset or the tenant is empty (the common production path before
// main.go wires a Bus).
func TestEmitBus_NilSafe(t *testing.T) {
	// nil Bus — no panic.
	(&Deps{}).emitBus(CanonicalEvent{TenantID: "t1", EventType: EventBounced, SubscriberEmail: "x@x.com"})

	bus := &recordingBus{}
	d := &Deps{Bus: bus}
	// empty tenant — guarded no-op.
	d.emitBus(CanonicalEvent{EventType: EventBounced, SubscriberEmail: "x@x.com"})
	if len(bus.events) != 0 {
		t.Fatalf("empty-tenant emit leaked %d events", len(bus.events))
	}
}
