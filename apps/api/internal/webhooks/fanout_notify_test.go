// SPDX-License-Identifier: AGPL-3.0-only

package webhooks

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/outbox"
)

// AUTOMATION#41 — the cross-service fanout seam.
//
// services/voice is a separate Go module, so its stuck scanner announces by
// writing a `webhook.fanout` outbox row and FanoutHandler expands it here. Two
// things were wrong and this file pins both:
//
//  1. `sequence.participants.stuck` was not in AllEvents, so every one of those
//     rows failed IsValidEvent, errored, retried and DLQ'd. The scanner had been
//     detecting stuck participants and dead-ending every alert — silently,
//     because a DLQ row is exactly as quiet as the condition it reports.
//  2. Even once it dispatched, it only reached destinations the TENANT had
//     configured. `OperatorNotify` is the first-party half, and it must run
//     AFTER the tenant tx commits — a notification about a fanout that rolled
//     back is a lie.

type recordingCrossServiceNotifier struct {
	calls []struct {
		tenantID  string
		eventType string
		body      string
	}
}

func (r *recordingCrossServiceNotifier) NotifyCrossServiceEvent(
	_ context.Context, tenantID, eventType string, body json.RawMessage,
) {
	r.calls = append(r.calls, struct {
		tenantID  string
		eventType string
		body      string
	}{tenantID, eventType, string(body)})
}

// A row that never reaches the tenant tx must never reach the notifier either.
// Both cases below return an error, which is how the outbox retries and then
// DLQs the row — announcing a delivery that did not happen would be worse than
// the silence this whole finding is about.
func TestFanoutDoesNotNotifyForARowThatWillDLQ(t *testing.T) {
	t.Parallel()
	notifier := &recordingCrossServiceNotifier{}
	h := &FanoutHandler{
		// Pool/Dispatcher are non-nil-checked before anything else; supplying
		// them as zero values is enough to get past the configuration guard and
		// into the payload/event checks, which is where these rows die.
		Pool:           &db.Pool{},
		Dispatcher:     &Dispatcher{},
		OperatorNotify: notifier,
	}

	if err := h.Handle(context.Background(), outbox.Event{
		TenantID: "11111111-1111-4111-8111-111111111111",
		Kind:     FanoutKind,
		Payload:  json.RawMessage(`{"event_type": "sequence.participants.stuck"`),
	}); err == nil {
		t.Fatal("malformed payload should error so the outbox retries")
	}

	if err := h.Handle(context.Background(), outbox.Event{
		TenantID: "11111111-1111-4111-8111-111111111111",
		Kind:     FanoutKind,
		Payload:  json.RawMessage(`{"event_type":"nonsense.invented","body":{}}`),
	}); err == nil {
		t.Fatal("unknown event should error so the outbox retries")
	}

	if len(notifier.calls) != 0 {
		t.Fatalf("notified for a row that never dispatched: %+v", notifier.calls)
	}
}

// The regression that WAS the finding: the scanner's event type has to survive
// the catalog gate, or the row dies before any channel sees it.
func TestStuckEventPassesTheFanoutCatalogGate(t *testing.T) {
	t.Parallel()
	if !IsValidEvent(string(EventSequenceParticipantsStuck)) {
		t.Fatal("sequence.participants.stuck fails IsValidEvent — FanoutHandler will DLQ " +
			"every alert the voice stuck scanner emits")
	}
	if !isDispatchableEventType(string(EventSequenceParticipantsStuck)) {
		t.Fatal("sequence.participants.stuck is not dispatchable — Dispatcher.Fire will reject it")
	}
}

// End to end against the real database: a fanout row for the stuck event
// expands into a deliver row for a subscribed webhook AND reaches the
// first-party notifier, with the body forwarded verbatim.
func TestFanoutHandlerDispatchesAndNotifies_DB(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping cross-service fanout database test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := db.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	// The test role is deliberately the non-privileged `postwave_app`, so RLS
	// is genuinely in force. `tenants` has no worker-scope INSERT policy — only
	// `tenant_isolation_insert`, WITH CHECK (id = app.tenant_id) — so the row
	// has to be created under a tx already scoped to the id being inserted.
	// That is a real property of the schema, not a workaround: nothing may
	// create a tenant it is not already acting as.
	tenantID := uuid.NewString()
	seedTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	if _, err := seedTx.Exec(ctx,
		`INSERT INTO tenants (id, name, slug, tier) VALUES ($1::uuid, $2, $3, 'studio')`,
		tenantID, "AUTOMATION#41 test", "wh-automation41-"+randHex4WH(t)); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
	t.Cleanup(func() { deleteWebhookTestTenant(t, pool, tenantID) })

	repo := &Repo{Pool: pool}
	if _, err := repo.Create(ctx, tenantID, CreateInput{
		URL:    "https://consumer.example/stuck",
		Events: []EventType{EventSequenceParticipantsStuck},
	}, "sha256:deadbeef", nil); err != nil {
		// A pre-change tree cannot even SUBSCRIBE to this event, which is the
		// other half of the dead end.
		t.Fatalf("subscribe to %s: %v", EventSequenceParticipantsStuck, err)
	}

	notifier := &recordingCrossServiceNotifier{}
	h := &FanoutHandler{
		Pool:           pool,
		Dispatcher:     &Dispatcher{Outbox: &outbox.Repo{Pool: pool}},
		OperatorNotify: notifier,
	}
	body := `{"sequence_id":"seq_abc123","sequence_name":"Winback","stuck_count":4}`
	payload, err := json.Marshal(FanoutPayload{
		EventType: string(EventSequenceParticipantsStuck),
		Body:      json.RawMessage(body),
	})
	if err != nil {
		t.Fatalf("marshal fanout payload: %v", err)
	}

	if err := h.Handle(ctx, outbox.Event{
		TenantID: tenantID, Kind: FanoutKind, Payload: payload,
	}); err != nil {
		t.Fatalf("fanout handle: %v", err)
	}

	// The customer-webhook half: a deliver row was enqueued for the
	// subscription. This is what the DLQ was swallowing.
	// Counted through a tenant-scoped tx — a bare pool query would read zero
	// rows here for the RLS reason, not the behavioural one, and pass or fail
	// for the wrong cause.
	countTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx for count: %v", err)
	}
	defer func() { _ = countTx.Rollback(ctx) }()
	var delivers int
	if err := countTx.QueryRow(ctx, `
SELECT count(*) FROM outbox_events
 WHERE tenant_id = $1::uuid AND kind = $2`, tenantID, OutboxKind).Scan(&delivers); err != nil {
		t.Fatalf("count deliver rows: %v", err)
	}
	if delivers != 1 {
		t.Fatalf("deliver rows = %d, want 1", delivers)
	}

	// The first-party half.
	if len(notifier.calls) != 1 {
		t.Fatalf("operator notifier calls = %d, want 1", len(notifier.calls))
	}
	got := notifier.calls[0]
	if got.tenantID != tenantID {
		t.Fatalf("notified for tenant %q, want %q", got.tenantID, tenantID)
	}
	if got.eventType != string(EventSequenceParticipantsStuck) {
		t.Fatalf("notified event = %q", got.eventType)
	}
	if got.body != body {
		t.Fatalf("body was not forwarded verbatim:\n got %s\nwant %s", got.body, body)
	}
}

// A deployment without the first-party hook wired keeps working exactly as it
// did — nil is a no-op, not a panic in the outbox worker.
func TestFanoutHandlerToleratesANilOperatorNotifier(t *testing.T) {
	t.Parallel()
	h := &FanoutHandler{Pool: &db.Pool{}, Dispatcher: &Dispatcher{}}
	if err := h.Handle(context.Background(), outbox.Event{
		TenantID: "11111111-1111-4111-8111-111111111111",
		Kind:     FanoutKind,
		Payload:  json.RawMessage(`{"event_type":"nonsense.invented","body":{}}`),
	}); err == nil {
		t.Fatal("expected the unknown-event error")
	}
}
