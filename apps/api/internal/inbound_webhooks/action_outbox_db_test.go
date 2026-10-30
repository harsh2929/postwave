// SPDX-License-Identifier: AGPL-3.0-only
package inbound_webhooks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Records the TENANT alongside each action, because ActionWorker is a real
// worker: RunOnce drains every due intent in the database, not just the one this
// test created. A sibling test that leaves due rows behind therefore reaches
// THIS executor, and summing every id it ever saw counts their work as ours.
//
// That is exactly what happened — the package passed in isolation, passed for
// weeks against a database with residual data, and failed on a freshly migrated
// one where the ordering came out differently. Keying by tenant makes the
// assertions immune to what else is in the table, without weakening them.
type applyThenTimeoutExecutor struct {
	mu      sync.Mutex
	calls   map[string]int
	applied map[string]int
	tenant  map[string]string
}

func (e *applyThenTimeoutExecutor) ExecuteDurableAction(
	_ context.Context,
	actionID, tenantID, _, _, _ string,
) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.calls == nil {
		e.calls = map[string]int{}
		e.applied = map[string]int{}
		e.tenant = map[string]string{}
	}
	e.tenant[actionID] = tenantID
	e.calls[actionID]++
	if e.applied[actionID] == 0 {
		e.applied[actionID] = 1
		return errors.New("simulated response loss after source-of-truth apply")
	}
	return nil
}

// totalsFor sums only the actions belonging to one tenant.
func (e *applyThenTimeoutExecutor) totalsFor(tenantID string) (calls, applies int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for id, n := range e.calls {
		if e.tenant[id] != tenantID {
			continue
		}
		calls += n
		applies += e.applied[id]
	}
	return calls, applies
}

func (*applyThenTimeoutExecutor) AddToSequence(context.Context, string, string, string) error {
	return nil
}
func (*applyThenTimeoutExecutor) AddTag(context.Context, string, string, string) error {
	return nil
}
func (*applyThenTimeoutExecutor) RemoveTag(context.Context, string, string, string) error {
	return nil
}
func (*applyThenTimeoutExecutor) StartAutomation(context.Context, string, string, string) error {
	return nil
}

func TestInboundActionOutboxResumesExactRetryWithoutDoubleApply(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping inbound action outbox database test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := db.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	var migrationPresent bool
	if err := pool.QueryRow(ctx, `
SELECT to_regclass('public.inbound_webhook_action_intents') IS NOT NULL
   AND to_regclass('public.inbound_webhook_replay_receipts') IS NOT NULL`,
	).Scan(&migrationPresent); err != nil || !migrationPresent {
		t.Fatalf("migration 1790 is not applied")
	}

	tenantID := createInboundWebhookTestTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}
	name := "action-outbox-" + randHex4IW(t)
	created, err := repo.Create(ctx, tenantID, name)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupEndpoints(pool, tenantID, name) })
	expected := "paid"
	trigger, err := repo.CreateTrigger(ctx, tenantID, created.Endpoint.ID, Trigger{
		Name:           "Tag paid customer",
		Active:         true,
		MatchJSONPath:  "$.status",
		MatchOperator:  OpEquals,
		MatchValue:     &expected,
		EmailJSONPath:  "$.email",
		ActionType:     ActionAddTag,
		ActionTargetID: "paid",
	})
	if err != nil {
		t.Fatal(err)
	}

	key, err := inboundWebhookReplayKey(http.Header{
		"X-Postwave-Event-Id": []string{"durable-" + randHex4IW(t)},
	})
	if err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"status":"paid","email":"a@example.com"}`)
	eventID, duplicate, actionCount, err := repo.RecordEventWithActions(
		ctx,
		tenantID,
		created.Endpoint.ID,
		[]byte(`{}`),
		body,
		true,
		key,
		RecordEventOptions{
			QueueAutomationEvent:      true,
			AutomationSubscriberEmail: "a@example.com",
		},
	)
	if err != nil || duplicate || eventID == 0 || actionCount != 2 {
		t.Fatalf("first receipt id=%d duplicate=%v actions=%d err=%v",
			eventID, duplicate, actionCount, err)
	}

	// The automation service stand-in. RunOnce delivers every tenant's due
	// automation intents to it, so it answers them all, but it fails and records
	// only THIS tenant's deliveries. Another tenant's intent must neither absorb
	// the one transient failure this test depends on (this event's automation
	// intent would then succeed at once and the retry below would find one
	// delayed intent, not two) nor be counted as one of this event's deliveries.
	var (
		automationMu   sync.Mutex
		automationKeys []string // Idempotency-Key of each of this tenant's deliveries
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var delivery struct {
			TenantID string `json:"tenant_id"`
		}
		decodeErr := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&delivery)
		if decodeErr != nil || delivery.TenantID != tenantID {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		automationMu.Lock()
		automationKeys = append(automationKeys, r.Header.Get("Idempotency-Key"))
		first := len(automationKeys) == 1
		automationMu.Unlock()
		if first {
			http.Error(w, "transient", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	t.Cleanup(server.Close)
	automationDeliveries := func() []string {
		automationMu.Lock()
		defer automationMu.Unlock()
		return slices.Clone(automationKeys)
	}
	executor := &applyThenTimeoutExecutor{}
	worker := &ActionWorker{
		Repo:                 repo,
		Executor:             executor,
		AutomationServiceURL: server.URL,
		BatchSize:            10,
	}
	// AT LEAST, not exactly. RunOnce is a real worker tick: it drains every due
	// intent in the database, not just this test's, so a sibling test that left
	// rows behind makes an exact count fail here for a reason that has nothing
	// to do with the behaviour under test — which is what happened, and it
	// passed in isolation and failed in the package.
	//
	// Nothing is weakened by the change. The guarantee this test is named for —
	// applied exactly once across a retry — is asserted below against
	// `inbound_webhook_action_intents WHERE inbound_event_id = $1`, scoped to
	// THIS event. The count here only needs to show the tick did not stall.
	if processed, err := worker.RunOnce(ctx); err != nil || processed < 2 {
		t.Fatalf("first worker tick processed=%d err=%v (wanted at least this "+
			"event's 2 intents)", processed, err)
	}

	// An exact provider retry wakes both delayed transient intents immediately.
	_, duplicate, nudged, err := repo.RecordEventWithActions(
		ctx,
		tenantID,
		created.Endpoint.ID,
		[]byte(`{}`),
		body,
		true,
		key,
		RecordEventOptions{
			QueueAutomationEvent:      true,
			AutomationSubscriberEmail: "a@example.com",
		},
	)
	if err != nil || !duplicate || nudged != 2 {
		t.Fatalf("duplicate=%v nudged=%d err=%v", duplicate, nudged, err)
	}
	if processed, err := worker.RunOnce(ctx); err != nil || processed < 2 {
		t.Fatalf("second worker tick processed=%d err=%v (wanted at least this "+
			"event's 2 re-woken intents)", processed, err)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var succeeded, fired int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE state = 'succeeded')
  FROM inbound_webhook_action_intents
 WHERE inbound_event_id = $1`, eventID).Scan(&succeeded); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `
SELECT fired_count
  FROM inbound_webhook_triggers
 WHERE id = $1::uuid`, trigger.ID).Scan(&fired); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if succeeded != 2 || fired != 1 {
		t.Fatalf("succeeded=%d fired_count=%d, want 2/1", succeeded, fired)
	}
	triggerCalls, triggerApplies := executor.totalsFor(tenantID)
	if triggerCalls != 2 || triggerApplies != 1 {
		t.Fatalf("trigger calls/applies=%d/%d, want 2/1", triggerCalls, triggerApplies)
	}
	// Both deliveries are the same intent, retried: one Idempotency-Key.
	if got := automationDeliveries(); len(got) != 2 || got[0] == "" || got[0] != got[1] {
		t.Fatalf("automation deliveries (Idempotency-Key each)=%q, want 2 of one intent", got)
	}

	// Once terminal, another sender retry neither re-creates nor requeues work.
	terminal := eventIntents(t, ctx, pool, tenantID, eventID)
	_, duplicate, nudged, err = repo.RecordEventWithActions(
		ctx, tenantID, created.Endpoint.ID, []byte(`{}`), body, true, key,
		RecordEventOptions{
			QueueAutomationEvent: true, AutomationSubscriberEmail: "a@example.com",
		},
	)
	if err != nil || !duplicate || nudged != 0 {
		t.Fatalf("terminal duplicate=%v nudged=%d err=%v", duplicate, nudged, err)
	}
	// How many intents the tick processed is not this test's to assert: the tick
	// drains every tenant's due intents. What it must not do is touch this
	// event's. They are the same rows in the same states with the same attempt
	// counts, and nothing of this tenant was executed or delivered again.
	if _, err := worker.RunOnce(ctx); err != nil {
		t.Fatalf("terminal tick: %v", err)
	}
	if after := eventIntents(t, ctx, pool, tenantID, eventID); !slices.Equal(after, terminal) {
		t.Fatalf("the terminal retry and tick changed this event's intents:\nbefore %q\nafter  %q",
			terminal, after)
	}
	if calls, applies := executor.totalsFor(tenantID); calls != 2 || applies != 1 {
		t.Fatalf("after the terminal tick, trigger calls/applies=%d/%d, want still 2/1", calls, applies)
	}
	if got := automationDeliveries(); len(got) != 2 {
		t.Fatalf("after the terminal tick, automation deliveries=%d, want still 2", len(got))
	}
}

// eventIntents describes every action intent of one inbound event, one line
// per intent in id order: id, state, attempts and last update.
func eventIntents(t *testing.T, ctx context.Context, pool *db.Pool, tenantID string, eventID int64) []string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, state, attempts, updated_at
  FROM inbound_webhook_action_intents
 WHERE inbound_event_id = $1
 ORDER BY id`, eventID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var intents []string
	for rows.Next() {
		var (
			id, state string
			attempts  int
			updatedAt time.Time
		)
		if err := rows.Scan(&id, &state, &attempts, &updatedAt); err != nil {
			t.Fatal(err)
		}
		intents = append(intents, fmt.Sprintf("%s %s attempts=%d updated=%s",
			id, state, attempts, updatedAt.UTC().Format(time.RFC3339Nano)))
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(intents) != 2 {
		t.Fatalf("event %d has %d action intents, want its 2: %q", eventID, len(intents), intents)
	}
	return intents
}

func TestInboundReplayReceiptFreezesZeroMatchAttempt(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping inbound replay receipt database test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := db.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	var migrationPresent bool
	if err := pool.QueryRow(ctx,
		`SELECT to_regclass('public.inbound_webhook_replay_receipts') IS NOT NULL`,
	).Scan(&migrationPresent); err != nil || !migrationPresent {
		t.Fatalf("migration 1790 is not applied")
	}
	tenantID := createInboundWebhookTestTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}
	name := "replay-receipt-" + randHex4IW(t)
	created, err := repo.Create(ctx, tenantID, name)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanupEndpoints(pool, tenantID, name) })
	key, _ := inboundWebhookReplayKey(http.Header{
		"X-Postwave-Event-Id": []string{"replay-receipt-" + randHex4IW(t)},
	})
	eventID, _, _, err := repo.RecordEventWithActions(
		ctx,
		tenantID,
		created.Endpoint.ID,
		[]byte(`{}`),
		[]byte(`{"status":"paid","email":"a@example.com"}`),
		true,
		key,
		RecordEventOptions{},
	)
	if err != nil {
		t.Fatal(err)
	}
	// A FRESH id per run, not a fixed one.
	//
	// This was the literal 77777777-7777-4777-8777-777777777777, and the receipt
	// it creates outlives the test: cleaning up the tenant does not remove it, so
	// the id was already taken on the second run and QueueReplayWithID returned
	// no rows. The test could pass exactly once per database, and every run after
	// that reported a product failure ("first zero-match replay ... no rows in
	// result set") that was really its own leftover.
	//
	// The assertion is unchanged in strength: what it proves is that the CALLER'S
	// id is honoured, and a random uuid proves that just as well as a memorable
	// one — while also being true more than once.
	replayID := uuid.NewString()
	if gotReplayID, matches, err := repo.QueueReplayWithID(
		ctx, tenantID, created.Endpoint.ID, eventID, replayID,
	); err != nil || gotReplayID != replayID || len(matches) != 0 {
		t.Fatalf("first zero-match replay id=%q matches=%v err=%v", gotReplayID, matches, err)
	}
	expected := "paid"
	if _, err := repo.CreateTrigger(ctx, tenantID, created.Endpoint.ID, Trigger{
		Name:           "Created after replay",
		Active:         true,
		MatchJSONPath:  "$.status",
		MatchOperator:  OpEquals,
		MatchValue:     &expected,
		EmailJSONPath:  "$.email",
		ActionType:     ActionAddTag,
		ActionTargetID: "paid",
	}); err != nil {
		t.Fatal(err)
	}
	if gotReplayID, matches, err := repo.QueueReplayWithID(
		ctx, tenantID, created.Endpoint.ID, eventID, replayID,
	); err != nil || gotReplayID != replayID || len(matches) != 0 {
		t.Fatalf("same replay receipt changed semantics: id=%q matches=%v err=%v", gotReplayID, matches, err)
	}
	// Fresh per run, for the same reason as replayID above.
	freshReplayID := uuid.NewString()
	if gotReplayID, matches, err := repo.QueueReplayWithID(
		ctx,
		tenantID,
		created.Endpoint.ID,
		eventID,
		freshReplayID,
	); err != nil || gotReplayID != freshReplayID || len(matches) != 1 || !matches[0].Queued {
		t.Fatalf("fresh replay id=%q matches=%v err=%v", gotReplayID, matches, err)
	}
	if gotReplayID, matches, err := repo.QueueReplayWithID(
		ctx,
		tenantID,
		created.Endpoint.ID,
		eventID,
		freshReplayID,
	); err != nil || gotReplayID != freshReplayID || len(matches) != 1 {
		t.Fatalf("same non-empty replay id=%q matches=%v err=%v", gotReplayID, matches, err)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var receiptCount, actionCount int
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM inbound_webhook_replay_receipts
 WHERE tenant_id = $1::uuid
   AND inbound_event_id = $2`, tenantID, eventID).Scan(&receiptCount); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM inbound_webhook_action_intents
 WHERE tenant_id = $1::uuid
   AND inbound_event_id = $2
   AND replay_id = $3::uuid`, tenantID, eventID, freshReplayID).Scan(&actionCount); err != nil {
		t.Fatal(err)
	}
	if receiptCount != 2 || actionCount != 1 {
		t.Fatalf("atomic replay rows = %d receipts / %d actions, want 2 / 1", receiptCount, actionCount)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

// The probes switch to postwave_app with SET LOCAL ROLE, which needs a
// superuser session. This test used DATABASE_URL and skipped unless it was a
// superuser, and CI's DATABASE_URL is postwave_app, so it never ran there; it
// runs on the admin connection CI provides for exactly this.
func TestInboundActionOutboxRLSSeparatesTenantAndWorkerAuthority(t *testing.T) {
	adminURL := os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL")
	if adminURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL not set; skipping inbound outbox RLS database test")
	}
	// db.New refuses a role that can bypass RLS unless told this is deliberate.
	t.Setenv("POSTWAVE_ALLOW_PRIVILEGED_DB_ROLE", "1")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := db.New(ctx, adminURL)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	var (
		migrationPresent bool
		isSuperuser      bool
	)
	if err := pool.QueryRow(ctx, `
SELECT to_regclass('public.inbound_webhook_action_intents') IS NOT NULL,
       rolsuper
  FROM pg_roles
 WHERE rolname = current_user`,
	).Scan(&migrationPresent, &isSuperuser); err != nil || !migrationPresent {
		t.Fatalf("migration 1790 is not applied")
	}
	if !isSuperuser {
		t.Fatal("POSTWAVE_TEST_ADMIN_DATABASE_URL is not a superuser connection; " +
			"the SET LOCAL ROLE probes below need one")
	}
	type seeded struct {
		tenantID   string
		eventID    int64
		endpointID string
	}
	seeds := make([]seeded, 0, 2)
	for i := 0; i < 2; i++ {
		tenantID := createInboundWebhookTestTenant(t, ctx, pool)
		repo := &Repo{Pool: pool}
		name := "rls-action-" + randHex4IW(t)
		created, err := repo.Create(ctx, tenantID, name)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { cleanupEndpoints(pool, tenantID, name) })
		key, _ := inboundWebhookReplayKey(http.Header{
			"X-Postwave-Event-Id": []string{"rls-" + randHex4IW(t)},
		})
		eventID, _, _, err := repo.RecordEventWithActions(
			ctx,
			tenantID,
			created.Endpoint.ID,
			[]byte(`{}`),
			[]byte(`{"email":"a@example.com"}`),
			true,
			key,
			RecordEventOptions{
				QueueAutomationEvent: true, AutomationSubscriberEmail: "a@example.com",
			},
		)
		if err != nil {
			t.Fatal(err)
		}
		seeds = append(seeds, seeded{
			tenantID: tenantID, eventID: eventID, endpointID: created.Endpoint.ID,
		})
	}

	tenantTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tenantTx.Rollback(ctx) }()
	if _, err := tenantTx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
		t.Fatal(err)
	}
	if _, err := tenantTx.Exec(ctx,
		`SELECT set_config('app.tenant_id', $1, true)`, seeds[0].tenantID,
	); err != nil {
		t.Fatal(err)
	}
	var tenantVisible int
	if err := tenantTx.QueryRow(ctx,
		`SELECT count(*) FROM inbound_webhook_action_intents`,
	).Scan(&tenantVisible); err != nil {
		t.Fatal(err)
	}
	if tenantVisible != 1 {
		t.Fatalf("tenant-visible actions=%d, want 1", tenantVisible)
	}
	if err := tenantTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	crossTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = crossTx.Rollback(ctx) }()
	if _, err := crossTx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
		t.Fatal(err)
	}
	if _, err := crossTx.Exec(ctx,
		`SELECT set_config('app.tenant_id', $1, true)`, seeds[0].tenantID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := crossTx.Exec(ctx, `
INSERT INTO inbound_webhook_action_intents
       (tenant_id, inbound_event_id, endpoint_id, intent_kind, subscriber_email)
VALUES ($1::uuid, $2, $3::uuid, 'automation_event', 'a@example.com')`,
		seeds[0].tenantID, seeds[1].eventID, seeds[1].endpointID,
	); err == nil {
		t.Fatal("tenant action linked to another tenant's event")
	}
	_ = crossTx.Rollback(ctx)

	workerTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = workerTx.Rollback(ctx) }()
	if _, err := workerTx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
		t.Fatal(err)
	}
	if _, err := workerTx.Exec(ctx,
		`SELECT set_config('app.outbox_worker', 'true', true)`,
	); err != nil {
		t.Fatal(err)
	}
	// Counted over this test's two events only: worker scope sees every
	// tenant's intents, and the shared test database holds other tests' too.
	var workerVisible int
	if err := workerTx.QueryRow(ctx,
		`SELECT count(*) FROM inbound_webhook_action_intents WHERE inbound_event_id = ANY ($1::bigint[])`,
		[]int64{seeds[0].eventID, seeds[1].eventID},
	).Scan(&workerVisible); err != nil {
		t.Fatal(err)
	}
	if workerVisible != 2 {
		t.Fatalf("worker discovery sees %d of the two tenants' actions, want both", workerVisible)
	}
	// RLS FILTERS, it does not raise.
	//
	// This asserted that the UPDATE returns an ERROR. It does not and should
	// not: a policy that excludes a row makes the statement match nothing, so
	// the correct outcome is success affecting ZERO rows. The authority boundary
	// is real — verified directly: worker scope with no tenant GUC touches no
	// rows — but the assertion was checking for the wrong symptom, and since the
	// whole test only runs on a superuser connection it had never been exercised.
	tag, err := workerTx.Exec(ctx, `
UPDATE inbound_webhook_action_intents
   SET next_attempt_at = now()
 WHERE inbound_event_id = $1`, seeds[0].eventID)
	if err != nil {
		t.Fatalf("worker discovery UPDATE errored rather than being filtered: %v", err)
	}
	if tag.RowsAffected() != 0 {
		t.Fatalf("worker discovery scope mutated %d action(s) without tenant scope; "+
			"a cross-tenant worker can rewrite one tenant's retry schedule",
			tag.RowsAffected())
	}
}
