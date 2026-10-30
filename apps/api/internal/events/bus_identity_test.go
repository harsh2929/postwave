// SPDX-License-Identifier: AGPL-3.0-only
package events

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestPublishAssignsOneStableEventIDBeforeFanout(t *testing.T) {
	bus := NewBus()
	first := bus.Subscribe("tenant-1", []string{"campaign.sent"})
	second := bus.Subscribe("tenant-1", []string{"campaign.sent"})
	defer bus.Unsubscribe(first)
	defer bus.Unsubscribe(second)

	bus.Publish(Event{TenantID: "tenant-1", Topic: "campaign.sent"})

	read := func(ch <-chan Event) Event {
		t.Helper()
		select {
		case event := <-ch:
			return event
		case <-time.After(time.Second):
			t.Fatal("timed out waiting for event")
			return Event{}
		}
	}
	a := read(first.Ch)
	b := read(second.Ch)
	if a.ID == "" || a.ID != b.ID {
		t.Fatalf("fanout ids = %q and %q; want one shared non-empty id", a.ID, b.ID)
	}
	if _, err := uuid.Parse(a.ID); err != nil {
		t.Fatalf("event id %q is not a UUID: %v", a.ID, err)
	}
}

func TestRedisBackendRecognizesOnlyItsOwnEcho(t *testing.T) {
	backend := &RedisBackend{origin: "replica-a"}
	if !backend.isSelfEcho(redisEventEnvelope{Origin: "replica-a"}) {
		t.Fatal("own Redis echo was not suppressed")
	}
	if backend.isSelfEcho(redisEventEnvelope{Origin: "replica-b"}) {
		t.Fatal("remote replica event was suppressed")
	}
	if backend.isSelfEcho(redisEventEnvelope{}) {
		t.Fatal("legacy envelope without origin was suppressed")
	}
}
