// SPDX-License-Identifier: AGPL-3.0-only
package events

import (
	"testing"
	"time"
)

// Per-entity presence (SHELL-036): subscribing with an EntityRef publishes a
// PresenceEntityTopic event scoped to that record; distinct records track
// independently; unsubscribe decrements the right record.
func TestPresenceEntityScoping(t *testing.T) {
	bus := NewBus()
	// Observer subscribes to the entity topic BEFORE the tracker is wired, so
	// its own subscription generates no presence event.
	observer := bus.Subscribe("tenant-1", []string{PresenceEntityTopic})
	defer bus.Unsubscribe(observer)
	_ = NewPresence(bus)

	readEntity := func() map[string]any {
		t.Helper()
		select {
		case ev := <-observer.Ch:
			if ev.Topic != PresenceEntityTopic {
				t.Fatalf("topic = %q, want %q", ev.Topic, PresenceEntityTopic)
			}
			return ev.Payload
		case <-time.After(time.Second):
			t.Fatal("timed out waiting for entity presence event")
			return nil
		}
	}
	refOf := func(p map[string]any) string { s, _ := p["entity_ref"].(string); return s }
	countOf := func(p map[string]any) int { n, _ := p["count"].(int); return n }

	// viewer1 opens campaign:1.
	v1 := bus.SubscribeAsEntity("tenant-1", "u1", "alice", "campaign:1", nil)
	p := readEntity()
	if refOf(p) != "campaign:1" || countOf(p) != 1 {
		t.Fatalf("after v1: ref=%q count=%d, want campaign:1/1", refOf(p), countOf(p))
	}

	// viewer2 opens the SAME record → count 2.
	v2 := bus.SubscribeAsEntity("tenant-1", "u2", "bob", "campaign:1", nil)
	p = readEntity()
	if refOf(p) != "campaign:1" || countOf(p) != 2 {
		t.Fatalf("after v2: ref=%q count=%d, want campaign:1/2", refOf(p), countOf(p))
	}

	// viewer3 opens a DIFFERENT record → independent count 1.
	v3 := bus.SubscribeAsEntity("tenant-1", "u3", "carol", "campaign:2", nil)
	p = readEntity()
	if refOf(p) != "campaign:2" || countOf(p) != 1 {
		t.Fatalf("after v3: ref=%q count=%d, want campaign:2/1", refOf(p), countOf(p))
	}

	// viewer1 leaves campaign:1 → back to 1 for that record only.
	bus.Unsubscribe(v1)
	p = readEntity()
	if refOf(p) != "campaign:1" || countOf(p) != 1 {
		t.Fatalf("after v1 leave: ref=%q count=%d, want campaign:1/1", refOf(p), countOf(p))
	}

	// Draining the last viewer of a record emits a count:0 event (so its other
	// viewers learn nobody's left) — drain both before the next assertion.
	bus.Unsubscribe(v2)
	if p = readEntity(); refOf(p) != "campaign:1" || countOf(p) != 0 {
		t.Fatalf("after v2 leave: ref=%q count=%d, want campaign:1/0", refOf(p), countOf(p))
	}
	bus.Unsubscribe(v3)
	if p = readEntity(); refOf(p) != "campaign:2" || countOf(p) != 0 {
		t.Fatalf("after v3 leave: ref=%q count=%d, want campaign:2/0", refOf(p), countOf(p))
	}

	// A plain (entity-less) subscription must NOT emit an entity event.
	plain := bus.SubscribeAs("tenant-1", "u4", "dave", nil)
	defer bus.Unsubscribe(plain)
	select {
	case ev := <-observer.Ch:
		if ev.Topic == PresenceEntityTopic {
			t.Fatalf("plain subscribe wrongly emitted an entity presence event: %+v", ev.Payload)
		}
	case <-time.After(150 * time.Millisecond):
		// expected: no entity event
	}
}
