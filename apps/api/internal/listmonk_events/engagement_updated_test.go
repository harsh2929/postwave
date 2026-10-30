// SPDX-License-Identifier: AGPL-3.0-only
//
// engagement_updated_test.go — SUB-096: a newly-persisted open/click emits a
// subscriber.engagement_updated event on the SSE Bus carrying a fresh
// open/click/send rollup so the subscriber detail slideover can update its
// Contact Performance counters live. These tests exercise the emit helper
// directly with a recording Bus + a fake snapshotter (no DB / no HMAC).
package listmonk_events

import (
	"context"
	"errors"
	"testing"
	"time"
)

// fakeSnapshotter implements EngagementSnapshotter with a canned response (or
// error) and records the (tenant, email) it was asked for.
type fakeSnapshotter struct {
	snap      EngagementSnapshot
	err       error
	gotTenant string
	gotEmail  string
	callCount int
}

func (f *fakeSnapshotter) EngagementByEmail(_ context.Context, tenantID, email string) (EngagementSnapshot, error) {
	f.callCount++
	f.gotTenant = tenantID
	f.gotEmail = email
	if f.err != nil {
		return EngagementSnapshot{}, f.err
	}
	return f.snap, nil
}

// TestEmitEngagementUpdated_OnOpen — an open publishes
// subscriber.engagement_updated with the refreshed counters.
func TestEmitEngagementUpdated_OnOpen(t *testing.T) {
	bus := &recordingBus{}
	snap := &fakeSnapshotter{snap: EngagementSnapshot{
		SubscriberID: "sub-1",
		Email:        "a@x.com",
		Sends:        10,
		Opens:        4,
		Clicks:       2,
	}}
	d := &Deps{Bus: bus, EngagementSnapshotter: snap}
	d.emitEngagementUpdated(context.Background(), CanonicalEvent{
		TenantID:        "t1",
		SubscriberEmail: "a@x.com",
		EventType:       EventOpened,
		At:              time.Now().UTC(),
	})
	if snap.callCount != 1 || snap.gotTenant != "t1" || snap.gotEmail != "a@x.com" {
		t.Fatalf("snapshotter called wrong: count=%d tenant=%q email=%q",
			snap.callCount, snap.gotTenant, snap.gotEmail)
	}
	if len(bus.events) != 1 {
		t.Fatalf("emit count = %d, want 1", len(bus.events))
	}
	got := bus.events[0]
	if got.tenantID != "t1" || got.topic != engagementUpdatedTopic {
		t.Fatalf("emit = (%q,%q), want (t1,%s)", got.tenantID, got.topic, engagementUpdatedTopic)
	}
	if got.payload["subscriber_id"] != "sub-1" {
		t.Errorf("payload subscriber_id = %v, want sub-1", got.payload["subscriber_id"])
	}
	if got.payload["event_type"] != "opened" {
		t.Errorf("payload event_type = %v, want opened", got.payload["event_type"])
	}
	if got.payload["opens"] != 4 || got.payload["clicks"] != 2 || got.payload["sends"] != 10 {
		t.Errorf("counter payload wrong: %+v", got.payload)
	}
}

// TestEmitEngagementUpdated_OnClick — a click also emits the event with the
// click event_type tag.
func TestEmitEngagementUpdated_OnClick(t *testing.T) {
	bus := &recordingBus{}
	snap := &fakeSnapshotter{snap: EngagementSnapshot{SubscriberID: "sub-2", Email: "c@x.com", Clicks: 1}}
	d := &Deps{Bus: bus, EngagementSnapshotter: snap}
	d.emitEngagementUpdated(context.Background(), CanonicalEvent{
		TenantID:        "t1",
		SubscriberEmail: "c@x.com",
		EventType:       EventClicked,
	})
	if len(bus.events) != 1 || bus.events[0].topic != engagementUpdatedTopic {
		t.Fatalf("click not emitted; events=%v", bus.events)
	}
	if bus.events[0].payload["event_type"] != "clicked" {
		t.Errorf("event_type = %v, want clicked", bus.events[0].payload["event_type"])
	}
}

// TestEmitEngagementUpdated_IgnoresNonEngagement — delivered/bounced/etc. must
// NOT emit the live-counter event (they don't move opens/clicks).
func TestEmitEngagementUpdated_IgnoresNonEngagement(t *testing.T) {
	for _, et := range []CanonicalEventType{EventDelivered, EventBounced, EventComplained, EventUnsubscribed} {
		bus := &recordingBus{}
		snap := &fakeSnapshotter{snap: EngagementSnapshot{SubscriberID: "s"}}
		d := &Deps{Bus: bus, EngagementSnapshotter: snap}
		d.emitEngagementUpdated(context.Background(), CanonicalEvent{
			TenantID: "t1", SubscriberEmail: "x@x.com", EventType: et,
		})
		if len(bus.events) != 0 {
			t.Fatalf("event_type %q leaked %d events", et, len(bus.events))
		}
		if snap.callCount != 0 {
			t.Fatalf("event_type %q queried snapshotter %d times, want 0", et, snap.callCount)
		}
	}
}

// TestEmitEngagementUpdated_NilSafe — never panics + never emits when the Bus
// or snapshotter is unset (the production default before main.go wires them),
// or when the tenant is empty.
func TestEmitEngagementUpdated_NilSafe(t *testing.T) {
	// nil Bus + nil snapshotter — no panic.
	(&Deps{}).emitEngagementUpdated(context.Background(), CanonicalEvent{
		TenantID: "t1", SubscriberEmail: "x@x.com", EventType: EventOpened,
	})

	// Bus set, snapshotter nil — guarded no-op.
	bus := &recordingBus{}
	(&Deps{Bus: bus}).emitEngagementUpdated(context.Background(), CanonicalEvent{
		TenantID: "t1", SubscriberEmail: "x@x.com", EventType: EventOpened,
	})
	if len(bus.events) != 0 {
		t.Fatalf("nil snapshotter leaked %d events", len(bus.events))
	}

	// Both set, empty tenant — guarded no-op.
	snap := &fakeSnapshotter{snap: EngagementSnapshot{SubscriberID: "s"}}
	d := &Deps{Bus: bus, EngagementSnapshotter: snap}
	d.emitEngagementUpdated(context.Background(), CanonicalEvent{
		SubscriberEmail: "x@x.com", EventType: EventOpened,
	})
	if len(bus.events) != 0 {
		t.Fatalf("empty-tenant leaked %d events", len(bus.events))
	}
}

// TestEmitEngagementUpdated_SwallowsSnapshotError — a snapshot lookup failure
// must NOT emit a partial event and must NOT panic (durable ingest is
// unaffected; this is a best-effort UI affordance).
func TestEmitEngagementUpdated_SwallowsSnapshotError(t *testing.T) {
	bus := &recordingBus{}
	snap := &fakeSnapshotter{err: errors.New("boom")}
	d := &Deps{Bus: bus, EngagementSnapshotter: snap}
	d.emitEngagementUpdated(context.Background(), CanonicalEvent{
		TenantID: "t1", SubscriberEmail: "x@x.com", EventType: EventOpened,
	})
	if len(bus.events) != 0 {
		t.Fatalf("snapshot error still emitted %d events", len(bus.events))
	}
}

// TestEngagementUpdatedTopic_MatchesContract pins the SSE topic string so a
// rename here (or in the subscribers package constant) is caught — the
// frontend's CONCRETE_EVENT_BUS_TOPICS + the subscribers constant both depend
// on this exact value.
func TestEngagementUpdatedTopic_MatchesContract(t *testing.T) {
	if engagementUpdatedTopic != "subscriber.engagement_updated" {
		t.Fatalf("engagementUpdatedTopic = %q, want subscriber.engagement_updated", engagementUpdatedTopic)
	}
}
