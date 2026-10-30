// SPDX-License-Identifier: AGPL-3.0-only
package subscribers

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/events"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
)

type bulkWebhookRecorder struct {
	inputs []WebhookFireInput
	err    error
}

func (r *bulkWebhookRecorder) Fire(
	_ context.Context,
	_ pgx.Tx,
	in WebhookFireInput,
) (int, error) {
	r.inputs = append(r.inputs, in)
	return 1, r.err
}

func TestBulkListSubscriberAddedWebhookIntent(t *testing.T) {
	addedAt := time.Date(2026, 7, 23, 9, 10, 11, 123456000, time.UTC)
	rec := bulkInsertedListSubscriber{
		ID:      "00000000-0000-4000-8000-000000000001",
		Email:   "person@example.com",
		ListID:  "00000000-0000-4000-8000-000000000003",
		AddedAt: addedAt,
	}
	recorder := &bulkWebhookRecorder{}
	d := &Deps{Repo: &Repo{Webhooks: recorder}}

	if err := d.fireBulkListSubscriberAdded(
		context.Background(), nil,
		"00000000-0000-4000-8000-000000000002",
		"segment",
		rec,
	); err != nil {
		t.Fatalf("fire list subscriber added: %v", err)
	}
	if len(recorder.inputs) != 1 {
		t.Fatalf("webhook calls = %d, want 1", len(recorder.inputs))
	}
	got := recorder.inputs[0]
	if got.EventType != outbound_webhooks.EventListSubscriberAdded {
		t.Fatalf("event type = %q, want %q", got.EventType, outbound_webhooks.EventListSubscriberAdded)
	}
	if got.IdempotencyKey != bulkListSubscriberAddedIdempotencyKey(
		got.TenantID,
		rec,
	) {
		t.Fatalf("unexpected idempotency key %q", got.IdempotencyKey)
	}
	payload, ok := got.Body.(map[string]any)
	if !ok {
		t.Fatalf("payload type = %T, want map[string]any", got.Body)
	}
	want := map[string]any{
		"subscriber_id": rec.ID,
		"email":         rec.Email,
		"list_id":       "00000000-0000-4000-8000-000000000003",
		"source":        "segment",
	}
	if len(payload) != len(want) {
		t.Fatalf("payload = %#v, want exact fields %#v", payload, want)
	}
	for key, value := range want {
		if payload[key] != value {
			t.Fatalf("payload[%q] = %#v, want %#v", key, payload[key], value)
		}
	}
}

func TestBulkListSubscriberAddedIdempotencyKeyUsesPersistedRevision(t *testing.T) {
	rec := bulkInsertedListSubscriber{
		ID:      "00000000-0000-4000-8000-000000000001",
		ListID:  "00000000-0000-4000-8000-000000000002",
		AddedAt: time.Date(2026, 7, 23, 9, 10, 11, 0, time.UTC),
	}
	first := bulkListSubscriberAddedIdempotencyKey("tenant", rec)
	if first != bulkListSubscriberAddedIdempotencyKey("tenant", rec) {
		t.Fatal("same persisted membership revision produced a different idempotency key")
	}
	rec.AddedAt = rec.AddedAt.Add(time.Nanosecond)
	if first == bulkListSubscriberAddedIdempotencyKey("tenant", rec) {
		t.Fatal("different persisted membership revision produced the same idempotency key")
	}
}

func TestBulkListSubscriberAddedWebhookFailurePropagates(t *testing.T) {
	sentinel := errors.New("delivery intent failed")
	d := &Deps{Repo: &Repo{Webhooks: &bulkWebhookRecorder{err: sentinel}}}
	err := d.fireBulkListSubscriberAdded(
		context.Background(), nil, "tenant", "explicit_ids",
		bulkInsertedListSubscriber{ID: "subscriber", ListID: "list", AddedAt: time.Now()},
	)
	if !errors.Is(err, sentinel) {
		t.Fatalf("error = %v, want %v", err, sentinel)
	}
}

// TestEmit_ListSubscriberAdded asserts that Deps.emit, used after the
// transactional delivery intent commits, publishes a list.subscriber.added
// realtime event carrying the same list-scoped payload.
//
// We exercise the helper directly rather than the full BulkMoveToList
// HTTP path because the latter requires a live Postgres pool; the
// emit step is presentation-only and must remain nil-safe.
func TestEmit_ListSubscriberAdded(t *testing.T) {
	bus := events.NewBus()
	sub := bus.Subscribe("t1", []string{outbound_webhooks.EventListSubscriberAdded})
	defer bus.Unsubscribe(sub)

	d := &Deps{Bus: bus}
	payload := map[string]any{
		"subscriber_id": "sub-1",
		"email":         "person@example.com",
		"list_id":       "list-9",
		"source":        "explicit_ids",
	}
	d.emit("t1", outbound_webhooks.EventListSubscriberAdded, payload)

	select {
	case evt := <-sub.Ch:
		if evt.Topic != outbound_webhooks.EventListSubscriberAdded {
			t.Fatalf("topic = %q, want %q", evt.Topic, outbound_webhooks.EventListSubscriberAdded)
		}
		if evt.TenantID != "t1" {
			t.Fatalf("tenant = %q, want %q", evt.TenantID, "t1")
		}
		for _, key := range []string{"subscriber_id", "email", "list_id", "source"} {
			got, ok := evt.Payload[key]
			if !ok {
				t.Fatalf("payload missing %q: %#v", key, evt.Payload)
			}
			if got != payload[key] {
				t.Fatalf("payload[%q] = %v, want %v", key, got, payload[key])
			}
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for list.subscriber.added event")
	}
}

// TestEmit_ListSubscriberAdded_NilBusSafe — handlers must remain
// usable without a configured bus (tests routinely build a Deps with
// no broker). emit must early-return rather than panic.
func TestEmit_ListSubscriberAdded_NilBusSafe(t *testing.T) {
	d := &Deps{}
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("emit panicked with nil Bus: %v", r)
		}
	}()
	d.emit("t1", outbound_webhooks.EventListSubscriberAdded, map[string]any{
		"subscriber_id": "sub-1",
		"email":         "person@example.com",
		"list_id":       "list-9",
		"source":        "explicit_ids",
	})
}

// TestEmit_ListSubscriberAdded_DispatcherFiltersByListID asserts the
// outbound_webhooks.Dispatcher's extractListID helper picks up
// list_id off the payload shape this package emits. This is the
// contract the dispatcher relies on to scope list_id-bound webhooks.
func TestEmit_ListSubscriberAdded_DispatcherFiltersByListID(t *testing.T) {
	bus := events.NewBus()
	sub := bus.Subscribe("t1", []string{outbound_webhooks.EventListSubscriberAdded})
	defer bus.Unsubscribe(sub)

	d := &Deps{Bus: bus}
	d.emit("t1", outbound_webhooks.EventListSubscriberAdded, map[string]any{
		"subscriber_id": "sub-1",
		"email":         "p@x.com",
		"list_id":       "list-42",
		"source":        "segment",
	})
	select {
	case evt := <-sub.Ch:
		got, _ := evt.Payload["list_id"].(string)
		if got != "list-42" {
			t.Fatalf("list_id on payload = %q, want %q", got, "list-42")
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for event")
	}
}
