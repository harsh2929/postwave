// SPDX-License-Identifier: AGPL-3.0-only
//
// SUB-118 (webhook coverage gaps) + SUB-119 (SSE bus catalog bridge) unit
// tests. The repo webhook-firing paths (Update/SetStatus/Delete) need a live
// Postgres and are covered by the DB-gated suites; here we exercise the pure
// decision logic that gates which events fire, plus the SSE Bus emission the
// handlers perform (which the desktop's "subscriber.*" wildcard consumes).
package subscribers

import (
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/events"
)

// TestConsentChanged — SUB-118: a PATCH fires subscriber.consent_changed only
// when it explicitly carried consent_source and/or consent_timestamp. Pointer
// fields distinguish "omitted" (no event) from "set" (event).
func TestConsentChanged(t *testing.T) {
	src := "double_optin"
	ts := time.Now().UTC()
	cases := []struct {
		name string
		in   UpdateInput
		want bool
	}{
		{name: "neither set", in: UpdateInput{}, want: false},
		{name: "only status set", in: UpdateInput{Status: ptr("enabled")}, want: false},
		{name: "consent_source set", in: UpdateInput{ConsentSource: &src}, want: true},
		{name: "consent_timestamp set", in: UpdateInput{ConsentTimestamp: &ts}, want: true},
		{name: "both set", in: UpdateInput{ConsentSource: &src, ConsentTimestamp: &ts}, want: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := consentChanged(tc.in); got != tc.want {
				t.Fatalf("consentChanged = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestEventConstants_WireStrings — the subscribers package fires these exact
// topic/event strings on BOTH the outbound-webhook path and the SSE Bus. They
// must match the catalog strings registered in internal/webhooks +
// internal/lists; a drift here breaks delivery silently.
func TestEventConstants_WireStrings(t *testing.T) {
	cases := map[string]string{
		EventSubscriberDeleted:        "subscriber.deleted",
		EventSubscriberStatusChanged:  "subscriber.status_changed",
		EventSubscriberConsentChanged: "subscriber.consent_changed",
		EventSubscriberMerged:         "subscriber.merged",
		EventSubscriberUpdated:        "subscriber.updated",
	}
	for got, want := range cases {
		if got != want {
			t.Errorf("event const = %q, want %q", got, want)
		}
	}
}

// TestEmit_StatusChanged_OnBus — SUB-119: the Update handler bridges a status
// transition to the SSE Bus as subscriber.status_changed. We exercise the
// emit helper directly (the full HTTP path needs a DB) and assert the payload
// shape the desktop wildcard subscription receives. Subscription is via the
// "subscriber.*" wildcard because the Bus topic-pattern regex rejects the
// underscore in an EXACT status_changed pattern — the wildcard is the real
// delivery path the desktop uses (DEFAULT_EVENT_BUS_TOPICS).
func TestEmit_StatusChanged_OnBus(t *testing.T) {
	bus := events.NewBus()
	sub := bus.Subscribe("t1", []string{"subscriber.*"})
	defer bus.Unsubscribe(sub)

	d := &Deps{Bus: bus}
	d.emit("t1", EventSubscriberStatusChanged, map[string]any{
		"id":          "sub-1",
		"email":       "p@x.com",
		"status":      "blocklisted",
		"prev_status": "enabled",
	})

	select {
	case evt := <-sub.Ch:
		if evt.Topic != EventSubscriberStatusChanged {
			t.Fatalf("topic = %q, want %q", evt.Topic, EventSubscriberStatusChanged)
		}
		if evt.TenantID != "t1" {
			t.Fatalf("tenant = %q, want t1", evt.TenantID)
		}
		if evt.Payload["status"] != "blocklisted" || evt.Payload["prev_status"] != "enabled" {
			t.Fatalf("payload = %#v, want status/prev_status set", evt.Payload)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for subscriber.status_changed event")
	}
}

// TestEmit_Deleted_OnBus — SUB-119: the Delete handler emits the
// catalog-aligned subscriber.deleted on the Bus (alongside the legacy
// subscriber.removed). Email is redacted.
func TestEmit_Deleted_OnBus(t *testing.T) {
	bus := events.NewBus()
	sub := bus.Subscribe("t1", []string{EventSubscriberDeleted})
	defer bus.Unsubscribe(sub)

	d := &Deps{Bus: bus}
	d.emit("t1", EventSubscriberDeleted, map[string]any{
		"id":             "sub-9",
		"email_redacted": "p***@x.com",
	})

	select {
	case evt := <-sub.Ch:
		if evt.Topic != EventSubscriberDeleted {
			t.Fatalf("topic = %q, want %q", evt.Topic, EventSubscriberDeleted)
		}
		if _, ok := evt.Payload["email_redacted"]; !ok {
			t.Fatalf("payload missing email_redacted: %#v", evt.Payload)
		}
		if _, leak := evt.Payload["email"]; leak {
			t.Fatalf("delete event leaked raw email: %#v", evt.Payload)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for subscriber.deleted event")
	}
}

// TestEmit_ConsentChanged_OnBus — SUB-119: consent transitions bridge to the
// Bus as subscriber.consent_changed. Subscribed via the "subscriber.*"
// wildcard (the Bus pattern regex rejects underscores in an exact pattern; the
// wildcard is the desktop's real subscription).
func TestEmit_ConsentChanged_OnBus(t *testing.T) {
	bus := events.NewBus()
	sub := bus.Subscribe("t1", []string{"subscriber.*"})
	defer bus.Unsubscribe(sub)

	d := &Deps{Bus: bus}
	d.emit("t1", EventSubscriberConsentChanged, map[string]any{
		"id":             "sub-3",
		"email":          "c@x.com",
		"consent_source": "double_optin",
	})

	select {
	case evt := <-sub.Ch:
		if evt.Topic != EventSubscriberConsentChanged {
			t.Fatalf("topic = %q, want %q", evt.Topic, EventSubscriberConsentChanged)
		}
		if evt.Payload["consent_source"] != "double_optin" {
			t.Fatalf("payload = %#v, want consent_source set", evt.Payload)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for subscriber.consent_changed event")
	}
}

// TestSubscriberWildcardMatchesNewEvents — SUB-119: the desktop subscribes to
// the "subscriber.*" wildcard. Assert the new lifecycle topics are delivered
// to a wildcard subscriber so the client receives them with no code change.
func TestSubscriberWildcardMatchesNewEvents(t *testing.T) {
	bus := events.NewBus()
	sub := bus.Subscribe("t1", []string{"subscriber.*"})
	defer bus.Unsubscribe(sub)

	d := &Deps{Bus: bus}
	for _, topic := range []string{
		EventSubscriberStatusChanged,
		EventSubscriberConsentChanged,
		EventSubscriberDeleted,
	} {
		d.emit("t1", topic, map[string]any{"id": "s"})
		select {
		case evt := <-sub.Ch:
			if evt.Topic != topic {
				t.Fatalf("wildcard delivered %q, want %q", evt.Topic, topic)
			}
		case <-time.After(time.Second):
			t.Fatalf("wildcard did not deliver %q", topic)
		}
	}
}

// TestIsConfirmationTransition — SUB-119: subscriber.confirmed fires exactly on
// the double-opt-in transition unconfirmed → enabled, and on nothing else. This
// is the pure decision the repo's Update/SetStatus paths gate the confirmed
// webhook + Bus emit on.
func TestIsConfirmationTransition(t *testing.T) {
	cases := []struct {
		prev, next string
		want       bool
	}{
		{StatusUnconfirmed, StatusEnabled, true}, // the confirmation
		{StatusEnabled, StatusEnabled, false},    // no transition
		{StatusUnconfirmed, StatusDisabled, false},
		{StatusDisabled, StatusEnabled, false}, // re-enable, not a confirm
		{StatusUnconfirmed, StatusBlocklisted, false},
		{StatusBlocklisted, StatusEnabled, false},
		{"", StatusEnabled, false},
	}
	for _, tc := range cases {
		if got := isConfirmationTransition(tc.prev, tc.next); got != tc.want {
			t.Errorf("isConfirmationTransition(%q,%q) = %v, want %v", tc.prev, tc.next, got, tc.want)
		}
	}
}

// TestConfirmedConstant_WireString — subscriber.confirmed must match the
// webhook catalog string (internal/webhooks EventSubscriberConfirmed). A drift
// silently breaks both the outbound webhook AND the SSE bridge.
func TestConfirmedConstant_WireString(t *testing.T) {
	if EventSubscriberConfirmed != "subscriber.confirmed" {
		t.Fatalf("EventSubscriberConfirmed = %q, want subscriber.confirmed", EventSubscriberConfirmed)
	}
}

// recordingPublisher is a tiny EventPublisher that captures every repo-level
// Bus emit so tests can assert SUB-119 bridging without a live broker.
type recordingPublisher struct {
	events []recordedEvent
}

type recordedEvent struct {
	tenantID string
	topic    string
	payload  map[string]any
}

func (p *recordingPublisher) Publish(tenantID, topic string, payload map[string]any) {
	p.events = append(p.events, recordedEvent{tenantID: tenantID, topic: topic, payload: payload})
}

// TestRepoEmitBus_NilSafe — SUB-119: emitBus is a no-op when the Bus is unset
// or the tenant is empty, and forwards otherwise. The repo calls this after a
// committed confirmation; it must never panic on the (common) nil-Bus path.
func TestRepoEmitBus_NilSafe(t *testing.T) {
	// nil Bus — no panic, no emit.
	(&Repo{}).emitBus("t1", EventSubscriberConfirmed, map[string]any{"id": "s"})

	rec := &recordingPublisher{}
	r := &Repo{Bus: rec}
	// empty tenant — guarded no-op.
	r.emitBus("", EventSubscriberConfirmed, map[string]any{"id": "s"})
	if len(rec.events) != 0 {
		t.Fatalf("empty-tenant emit leaked %d events", len(rec.events))
	}
	// real emit forwards verbatim.
	r.emitBus("t1", EventSubscriberConfirmed, map[string]any{"id": "s", "status": "enabled"})
	if len(rec.events) != 1 {
		t.Fatalf("emit count = %d, want 1", len(rec.events))
	}
	got := rec.events[0]
	if got.tenantID != "t1" || got.topic != EventSubscriberConfirmed {
		t.Fatalf("emit = (%q,%q), want (t1,%s)", got.tenantID, got.topic, EventSubscriberConfirmed)
	}
	if got.payload["status"] != "enabled" {
		t.Fatalf("payload = %#v, want status=enabled", got.payload)
	}
}

// TestNewBusPublisher_NilSafe — the *events.Bus adapter returns nil for a nil
// bus (so the repo's nil-guard keeps holding) and a working publisher for a
// real bus. The wrapped publisher delivers to a "subscriber.*" wildcard
// subscriber, which is the desktop's real subscription.
func TestNewBusPublisher_NilSafe(t *testing.T) {
	if NewBusPublisher(nil) != nil {
		t.Fatal("NewBusPublisher(nil) must be nil so Repo.Bus stays nil-safe")
	}
	bus := events.NewBus()
	sub := bus.Subscribe("t1", []string{"subscriber.*"})
	defer bus.Unsubscribe(sub)
	pub := NewBusPublisher(bus)
	if pub == nil {
		t.Fatal("NewBusPublisher(bus) returned nil for a real bus")
	}
	pub.Publish("t1", EventSubscriberConfirmed, map[string]any{"id": "s", "status": "enabled"})
	select {
	case evt := <-sub.Ch:
		if evt.Topic != EventSubscriberConfirmed {
			t.Fatalf("topic = %q, want %q", evt.Topic, EventSubscriberConfirmed)
		}
		if evt.TenantID != "t1" || evt.Payload["status"] != "enabled" {
			t.Fatalf("evt = %#v, want tenant t1 + status enabled", evt)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for adapter-published subscriber.confirmed")
	}
}

// TestEmit_Confirmed_OnBus — SUB-119: a repo-bridged confirmation reaches the
// desktop "subscriber.*" wildcard as subscriber.confirmed.
func TestEmit_Confirmed_OnBus(t *testing.T) {
	bus := events.NewBus()
	sub := bus.Subscribe("t1", []string{"subscriber.*"})
	defer bus.Unsubscribe(sub)

	r := &Repo{Bus: NewBusPublisher(bus)}
	r.emitBus("t1", EventSubscriberConfirmed, map[string]any{
		"id": "sub-7", "email": "c@x.com", "status": "enabled",
	})
	select {
	case evt := <-sub.Ch:
		if evt.Topic != EventSubscriberConfirmed {
			t.Fatalf("topic = %q, want %q", evt.Topic, EventSubscriberConfirmed)
		}
		if evt.Payload["status"] != "enabled" {
			t.Fatalf("payload = %#v, want status=enabled", evt.Payload)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for subscriber.confirmed event")
	}
}

// TestEmit_Merged_OnBus — SUB-118/119: the merge handlers emit subscriber.merged
// on the SSE Bus (the outbound webhook is fired inside Repo.Merge). Exercise the
// handler-level emit helper directly (the full merge needs a DB) to prove the
// desktop "subscriber.*" wildcard receives the merge with the primary/duplicate
// ids the handler attaches.
func TestEmit_Merged_OnBus(t *testing.T) {
	bus := events.NewBus()
	sub := bus.Subscribe("t1", []string{"subscriber.*"})
	defer bus.Unsubscribe(sub)

	d := &Deps{Bus: bus}
	d.emit("t1", EventSubscriberMerged, map[string]any{
		"primary_id":   "p-1",
		"duplicate_id": "d-1",
	})
	select {
	case evt := <-sub.Ch:
		if evt.Topic != EventSubscriberMerged {
			t.Fatalf("topic = %q, want %q", evt.Topic, EventSubscriberMerged)
		}
		if evt.Payload["primary_id"] != "p-1" || evt.Payload["duplicate_id"] != "d-1" {
			t.Fatalf("payload = %#v, want primary/duplicate ids set", evt.Payload)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for subscriber.merged event")
	}
}

// ptr is a tiny generic helper for building UpdateInput pointer fields.
func ptr[T any](v T) *T { return &v }
