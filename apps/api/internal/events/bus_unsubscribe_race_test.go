// SPDX-License-Identifier: AGPL-3.0-only
package events

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestBusPublishDuringUnsubscribeNeverSendsOnClosedChannel reproduces the
// staging panic "send on closed channel" in GET /api/v1/events (request
// 5WGU6YIUVSGY-008170): Bus.Unsubscribe → Presence.OnUnsubscribe →
// Bus.Publish → deliverLocal. The publisher snapshots its targets, another
// connection's Unsubscribe closes one of those targets' channels, and the
// publisher then sends into it.
//
// Every churning connection here is wired exactly like production: a real
// Presence tracker publishes presence.update on each subscribe/unsubscribe,
// so Unsubscribe itself publishes into subscribers other goroutines are
// closing — the path from the staging stack. Independent publishers add
// pressure on the same window. A send on a closed channel panics in a
// non-test goroutine, which aborts the whole test binary.
//
// Delivery must stay correct while that happens: a subscriber that stays
// connected throughout accounts for every event published to its topic,
// either received or counted as dropped. Nothing is silently lost.
func TestBusPublishDuringUnsubscribeNeverSendsOnClosedChannel(t *testing.T) {
	const tenant = "tenant-race"
	bus := NewBus()
	NewPresence(bus)

	// The stable subscriber listens only to the publishers' topic so the
	// presence traffic does not crowd its buffer.
	stable := bus.Subscribe(tenant, []string{"campaign.updated"})
	var received atomic.Uint64
	stableDone := make(chan struct{})
	go func() {
		defer close(stableDone)
		for range stable.Ch {
			received.Add(1)
		}
	}()

	const (
		churners     = 16
		publishers   = 4
		churnPerGoro = 400
	)
	var published atomic.Uint64
	stop := make(chan struct{})
	var pubWG sync.WaitGroup
	for i := 0; i < publishers; i++ {
		pubWG.Add(1)
		go func() {
			defer pubWG.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				bus.Publish(Event{Topic: "campaign.updated", TenantID: tenant})
				published.Add(1)
			}
		}()
	}

	var churnWG sync.WaitGroup
	for i := 0; i < churners; i++ {
		churnWG.Add(1)
		go func() {
			defer churnWG.Done()
			for j := 0; j < churnPerGoro; j++ {
				// "*" makes every churner a target of every publish, so the
				// window between a publisher choosing it and sending to it is
				// always open while another goroutine unsubscribes it.
				s := bus.Subscribe(tenant, []string{"*"})
				bus.Unsubscribe(s)
			}
		}()
	}
	churnWG.Wait()
	close(stop)
	pubWG.Wait()

	// Every churner is gone; presence must agree and only the stable
	// subscriber remains on the bus.
	if got := bus.SubscriberCount(tenant); got != 1 {
		t.Fatalf("SubscriberCount after churn = %d, want 1 (only the stable subscriber)", got)
	}

	bus.Unsubscribe(stable)
	select {
	case <-stableDone:
	case <-time.After(5 * time.Second):
		t.Fatal("stable subscriber channel was never closed by Unsubscribe")
	}
	want := published.Load()
	if want == 0 {
		t.Fatal("publishers never ran; the test proved nothing")
	}
	if got := received.Load() + stable.Dropped.Load(); got != want {
		t.Fatalf("stable subscriber accounted for %d events (received %d + dropped %d), published %d",
			got, received.Load(), stable.Dropped.Load(), want)
	}
	if received.Load() == 0 {
		t.Fatal("stable subscriber received nothing; delivery is broken")
	}
}

// panickingHook stands in for any SubscriberHook that fails. It runs before
// the presence tracker so a failure that aborted the hook chain would leave
// presence counting a connection that is gone.
type panickingHook struct{ calls atomic.Int32 }

func (h *panickingHook) OnSubscribe(*Subscriber) {}

func (h *panickingHook) OnUnsubscribe(*Subscriber) {
	h.calls.Add(1)
	panic("hook exploded")
}

// TestBusUnsubscribeRunsEveryHookWhenOneFails pins the second half of the
// staging incident: the panic happened inside Unsubscribe's hook chain, so the
// hooks after the failing one never ran. Every hook is cleanup for a
// connection that is already gone; one failing must not skip the others, and
// must not escape into the request goroutine that deferred Unsubscribe.
func TestBusUnsubscribeRunsEveryHookWhenOneFails(t *testing.T) {
	const tenant = "tenant-hooks"
	bus := NewBus()
	bad := &panickingHook{}
	bus.AddHook(bad)
	presence := NewPresence(bus)

	observer := bus.Subscribe(tenant, []string{"presence.update"})
	leaving := bus.Subscribe(tenant, nil)
	if got := presence.Count(tenant); got != 2 {
		t.Fatalf("presence count before unsubscribe = %d, want 2", got)
	}
	drain(observer)

	func() {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("Unsubscribe let a hook panic escape: %v", r)
			}
		}()
		bus.Unsubscribe(leaving)
	}()

	if got := bad.calls.Load(); got != 1 {
		t.Fatalf("failing hook ran %d times, want 1", got)
	}
	if got := presence.Count(tenant); got != 1 {
		t.Fatalf("presence count after unsubscribe = %d, want 1: the hook after the failing one was skipped", got)
	}
	select {
	case ev := <-observer.Ch:
		if ev.Topic != "presence.update" || ev.Payload["count"] != 1 {
			t.Fatalf("observer got %s %v, want presence.update with count 1", ev.Topic, ev.Payload)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("observer never saw the presence.update for the departed connection")
	}
	// The departed connection may still hold buffered events; after those
	// the channel must read as closed, or its SSE loop would never exit.
	closed := make(chan struct{})
	go func() {
		for range leaving.Ch {
		}
		close(closed)
	}()
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("departed subscriber's channel was never closed")
	}
}

func drain(s *Subscriber) {
	for {
		select {
		case <-s.Ch:
		default:
			return
		}
	}
}
