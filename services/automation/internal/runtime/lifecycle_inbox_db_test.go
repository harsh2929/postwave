package runtime

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/services/automation/internal/canonical"
)

type lifecycleRecordingQueue struct {
	mu                      sync.Mutex
	executions              []Execution
	seen                    map[string]struct{}
	failRemaining           map[string]int
	acceptThenFailRemaining map[string]int
}

func newLifecycleRecordingQueue() *lifecycleRecordingQueue {
	return &lifecycleRecordingQueue{
		seen:                    make(map[string]struct{}),
		failRemaining:           make(map[string]int),
		acceptThenFailRemaining: make(map[string]int),
	}
}

func (q *lifecycleRecordingQueue) Enqueue(_ context.Context, exec Execution, _ time.Time) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.failRemaining[exec.AutomationID] > 0 {
		q.failRemaining[exec.AutomationID]--
		return errors.New("forced queue rejection")
	}
	if _, duplicate := q.seen[exec.ID]; duplicate {
		return nil
	}
	q.seen[exec.ID] = struct{}{}
	q.executions = append(q.executions, exec)
	if q.acceptThenFailRemaining[exec.AutomationID] > 0 {
		q.acceptThenFailRemaining[exec.AutomationID]--
		return errors.New("forced timeout after queue acceptance")
	}
	return nil
}

func (q *lifecycleRecordingQueue) Pop(context.Context) (Execution, error) {
	return Execution{}, ErrPopUnsupported
}

func (q *lifecycleRecordingQueue) Ack(context.Context, Execution) error { return nil }

func (q *lifecycleRecordingQueue) Depth(context.Context) (int, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.executions), nil
}

func (q *lifecycleRecordingQueue) snapshot() []Execution {
	q.mu.Lock()
	defer q.mu.Unlock()
	return append([]Execution(nil), q.executions...)
}

func lifecycleInboxTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping lifecycle inbox database test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect lifecycle inbox database: %v", err)
	}
	t.Cleanup(pool.Close)
	var migrationPresent bool
	if err := pool.QueryRow(ctx, `
SELECT to_regclass('public.automation_lifecycle_event_inbox') IS NOT NULL`).Scan(&migrationPresent); err != nil {
		t.Fatalf("check lifecycle inbox migration: %v", err)
	}
	if !migrationPresent {
		t.Fatal("DATABASE_URL is configured but migration 1770 is not applied")
	}
	return pool
}

func beginLifecycleInboxTestTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) pgx.Tx {
	t.Helper()
	tx, err := pool.Begin(context.Background())
	if err != nil {
		t.Fatalf("begin tenant transaction: %v", err)
	}
	if _, err := tx.Exec(context.Background(), `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		_ = tx.Rollback(context.Background())
		t.Fatalf("bind tenant transaction: %v", err)
	}
	return tx
}

func seedLifecycleInboxSubscriber(t *testing.T, pool *pgxpool.Pool) (tenantID, subscriberID, email string) {
	t.Helper()
	tenantID = uuid.NewString()
	subscriberID = uuid.NewString()
	email = "automation-lifecycle-" + uuid.NewString() + "@example.test"
	tx := beginLifecycleInboxTestTenant(t, pool, tenantID)
	if _, err := tx.Exec(context.Background(), `
INSERT INTO public.tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, 'automation-lifecycle-inbox-test', 'studio')`,
		tenantID, "automation-lifecycle-"+strings.ReplaceAll(tenantID, "-", "")); err != nil {
		_ = tx.Rollback(context.Background())
		t.Fatalf("seed lifecycle inbox tenant: %v", err)
	}
	if _, err := tx.Exec(context.Background(), `
INSERT INTO public.subscribers
    (id, tenant_id, email, primary_email, status, mailchimp_status, consent_source)
VALUES ($1::uuid, $2::uuid, $3, $3, 'unconfirmed', 'pending', 'unknown')`,
		subscriberID, tenantID, email); err != nil {
		_ = tx.Rollback(context.Background())
		t.Fatalf("seed lifecycle inbox subscriber: %v", err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatalf("commit lifecycle inbox seed: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		tx, err := pool.Begin(cleanupCtx)
		if err != nil {
			return
		}
		defer func() { _ = tx.Rollback(cleanupCtx) }()
		_, _ = tx.Exec(cleanupCtx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID)
		_, _ = tx.Exec(cleanupCtx, `DELETE FROM public.tenants WHERE id = $1::uuid`, tenantID)
		_ = tx.Commit(cleanupCtx)
	})
	return tenantID, subscriberID, email
}

func lifecycleAutomation(id, tenantID, fromStage, toStage string) *canonical.Automation {
	return &canonical.Automation{
		ID:           id,
		TenantID:     tenantID,
		Name:         "Lifecycle test",
		Status:       "active",
		ReEnrollment: canonical.ReEnrollAlways,
		Triggers: []canonical.AutomationTrigger{{
			Type:      canonical.TriggerLifecycleStageChanged,
			FromStage: fromStage,
			ToStage:   toStage,
		}},
		Nodes:   []canonical.AutomationNode{{ID: "entry", Type: "wait"}},
		EntryID: "entry",
	}
}

func lifecycleInboxEvent(tenantID, subscriberID, sourceID string, sequence int64, fromStage, toStage string) EngagementEvent {
	return EngagementEvent{
		TenantID:           tenantID,
		SubscriberID:       subscriberID,
		EventType:          canonical.TriggerLifecycleStageChanged,
		SourceEventID:      sourceID,
		TransitionSequence: sequence,
		At:                 time.Date(2026, 7, 19, 6, 0, int(sequence), 0, time.UTC),
		Payload: map[string]interface{}{
			"event_name": canonical.TriggerLifecycleStageChanged,
			"from_stage": fromStage,
			"to_stage":   toStage,
			"score":      float64(4),
		},
	}
}

func newLifecycleInboxHarness(
	t *testing.T,
	pool *pgxpool.Pool,
	automations ...*canonical.Automation,
) (*PgxLifecycleEventInbox, *lifecycleRecordingQueue) {
	t.Helper()
	resolver := NewMemoryResolver()
	store := NewMemoryStore()
	queue := newLifecycleRecordingQueue()
	for _, automation := range automations {
		resolver.PutAutomation(automation)
		store.RegisterTenant(automation.ID, automation.TenantID)
	}
	engine := &Engine{Resolver: resolver, Store: store, Queue: queue}
	inbox, err := NewPgxLifecycleEventInbox(pool, resolver, engine)
	if err != nil {
		t.Fatalf("construct lifecycle inbox: %v", err)
	}
	return inbox, queue
}

func TestPgxLifecycleInboxPersistsPartialOutcomesAndReplaysOnlyPendingTargets(t *testing.T) {
	pool := lifecycleInboxTestPool(t)
	tenantID, subscriberID, originalEmail := seedLifecycleInboxSubscriber(t, pool)
	autoA := "10000000-0000-4000-8000-000000000001"
	autoB := "10000000-0000-4000-8000-000000000002"
	inbox, queue := newLifecycleInboxHarness(t, pool,
		lifecycleAutomation(autoA, tenantID, "subscriber", "lead"),
		lifecycleAutomation(autoB, tenantID, "subscriber", "lead"),
	)
	queue.failRemaining[autoB] = 1
	event := lifecycleInboxEvent(tenantID, subscriberID,
		"lifecycle-outbox:10000000-0000-4000-8000-000000000099", 1, "subscriber", "lead")

	if err := inbox.Dispatch(context.Background(), event); !errors.Is(err, ErrLifecycleDispatchFailed) {
		t.Fatalf("first dispatch error=%v, want durable partial failure", err)
	}
	if got := queue.snapshot(); len(got) != 1 || got[0].AutomationID != autoA || got[0].SubscriberEmail != originalEmail {
		t.Fatalf("first queue snapshot=%#v", got)
	}
	tx := beginLifecycleInboxTestTenant(t, pool, tenantID)
	var accepted, pending int
	var cursor int64
	if err := tx.QueryRow(context.Background(), `
SELECT count(*) FILTER (WHERE state='accepted')::int,
       count(*) FILTER (WHERE state='pending')::int
  FROM public.automation_lifecycle_event_dispatches
 WHERE tenant_id=$1::uuid AND source_event_id=$2`,
		tenantID, event.SourceEventID).Scan(&accepted, &pending); err != nil {
		t.Fatalf("read partial outcomes: %v", err)
	}
	if err := tx.QueryRow(context.Background(), `
SELECT last_accepted_sequence
  FROM public.automation_lifecycle_subscriber_cursors
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid`, tenantID, subscriberID).Scan(&cursor); err != nil {
		t.Fatalf("read partial cursor: %v", err)
	}
	_ = tx.Commit(context.Background())
	if accepted != 1 || pending != 1 || cursor != 0 {
		t.Fatalf("accepted/pending/cursor=%d/%d/%d, want 1/1/0", accepted, pending, cursor)
	}

	currentEmail := "automation-lifecycle-current-" + uuid.NewString() + "@example.test"
	tx = beginLifecycleInboxTestTenant(t, pool, tenantID)
	if _, err := tx.Exec(context.Background(), `
UPDATE public.subscribers SET email=$3, primary_email=$3
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, subscriberID, currentEmail); err != nil {
		t.Fatalf("change current lifecycle email: %v", err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatalf("commit lifecycle email change: %v", err)
	}

	if err := inbox.Dispatch(context.Background(), event); err != nil {
		t.Fatalf("retry pending lifecycle target: %v", err)
	}
	queued := queue.snapshot()
	if len(queued) != 2 || queued[1].AutomationID != autoB || queued[1].SubscriberEmail != currentEmail {
		t.Fatalf("retry queue snapshot=%#v", queued)
	}
	// Simulate timeout-after-accept: the gateway replays the exact event after
	// the service already committed its 202 outcome. No task or attempt repeats.
	if err := inbox.Dispatch(context.Background(), event); err != nil {
		t.Fatalf("duplicate accepted lifecycle event: %v", err)
	}
	if got := len(queue.snapshot()); got != 2 {
		t.Fatalf("accepted replay enqueued %d tasks, want 2 total", got)
	}

	tx = beginLifecycleInboxTestTenant(t, pool, tenantID)
	var state string
	var body string
	if err := tx.QueryRow(context.Background(), `
SELECT state, row_to_json(inbox)::text
  FROM public.automation_lifecycle_event_inbox AS inbox
 WHERE tenant_id=$1::uuid AND source_event_id=$2`, tenantID, event.SourceEventID).
		Scan(&state, &body); err != nil {
		t.Fatalf("read accepted inbox: %v", err)
	}
	_ = tx.Commit(context.Background())
	if state != "accepted" || strings.Contains(body, originalEmail) || strings.Contains(body, currentEmail) {
		t.Fatalf("accepted inbox state/body=%q/%s", state, body)
	}
}

func TestPgxLifecycleInboxRefusesReceiptWithOutcomeOutsideFrozenTargetSet(t *testing.T) {
	pool := lifecycleInboxTestPool(t)
	tenantID, subscriberID, _ := seedLifecycleInboxSubscriber(t, pool)
	automationID := "10000000-0000-4000-8000-000000000011"
	inbox, queue := newLifecycleInboxHarness(t, pool,
		lifecycleAutomation(automationID, tenantID, "subscriber", "lead"),
	)
	queue.failRemaining[automationID] = 1
	event := lifecycleInboxEvent(tenantID, subscriberID,
		"lifecycle-outbox:10000000-0000-4000-8000-000000000111", 1, "subscriber", "lead")
	if err := inbox.Dispatch(context.Background(), event); !errors.Is(err, ErrLifecycleDispatchFailed) {
		t.Fatalf("first dispatch error=%v, want durable failure", err)
	}

	tx := beginLifecycleInboxTestTenant(t, pool, tenantID)
	if _, err := tx.Exec(context.Background(), `
UPDATE public.automation_lifecycle_event_dispatches
   SET state='accepted', result='queued', accepted_at=clock_timestamp(),
       updated_at=clock_timestamp()
	WHERE tenant_id=$1::uuid AND source_event_id=$2 AND automation_id=$3::uuid`,
		tenantID, event.SourceEventID, automationID); err != nil {
		_ = tx.Rollback(context.Background())
		t.Fatalf("accept intended outcome: %v", err)
	}
	if _, err := tx.Exec(context.Background(), `
INSERT INTO public.automation_lifecycle_event_dispatches
    (tenant_id, source_event_id, automation_id, trigger_type)
VALUES ($1::uuid, $2, $3::uuid, 'subscriber_lifecycle_stage_changed')`,
		tenantID, event.SourceEventID,
		"10000000-0000-4000-8000-000000000012"); err != nil {
		_ = tx.Rollback(context.Background())
		t.Fatalf("seed outcome outside frozen target set: %v", err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatalf("commit adversarial outcome: %v", err)
	}

	receipt, err := receiptFromEngagementEvent(event)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := pool.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	if err := inbox.finalizeReceipt(context.Background(), conn, receipt); !errors.Is(err, ErrLifecycleDispatchFailed) {
		t.Fatalf("finalize error=%v, want target-set cardinality failure", err)
	}

	tx = beginLifecycleInboxTestTenant(t, pool, tenantID)
	defer func() { _ = tx.Rollback(context.Background()) }()
	var cursor int64
	var state string
	if err := tx.QueryRow(context.Background(), `
SELECT c.last_accepted_sequence, i.state
  FROM public.automation_lifecycle_subscriber_cursors AS c
  JOIN public.automation_lifecycle_event_inbox AS i
    ON i.tenant_id=c.tenant_id AND i.subscriber_key=c.subscriber_id
 WHERE c.tenant_id=$1::uuid AND c.subscriber_id=$2::uuid
   AND i.source_event_id=$3`, tenantID, subscriberID, event.SourceEventID).Scan(&cursor, &state); err != nil {
		t.Fatalf("read receipt after cardinality rejection: %v", err)
	}
	if cursor != 0 || state != "received" {
		t.Fatalf("cursor/state=%d/%s, want 0/received", cursor, state)
	}
}

func TestPgxLifecycleInboxRecoversFromTimeoutAfterQueueAcceptance(t *testing.T) {
	pool := lifecycleInboxTestPool(t)
	tenantID, subscriberID, _ := seedLifecycleInboxSubscriber(t, pool)
	automationID := "11000000-0000-4000-8000-000000000001"
	inbox, queue := newLifecycleInboxHarness(t, pool,
		lifecycleAutomation(automationID, tenantID, "subscriber", "lead"),
	)
	queue.acceptThenFailRemaining[automationID] = 1
	event := lifecycleInboxEvent(tenantID, subscriberID,
		"lifecycle-outbox:11000000-0000-4000-8000-000000000099", 1, "subscriber", "lead")

	if err := inbox.Dispatch(context.Background(), event); !errors.Is(err, ErrLifecycleDispatchFailed) {
		t.Fatalf("timeout-after-accept error=%v, want retry-visible failure", err)
	}
	if got := len(queue.snapshot()); got != 1 {
		t.Fatalf("queue accepted %d tasks before timeout, want exactly one", got)
	}
	// The first enqueue did happen. Its stable task id makes the retry a queue
	// no-op, after which the per-target outcome and subscriber cursor can commit.
	if err := inbox.Dispatch(context.Background(), event); err != nil {
		t.Fatalf("retry timeout-after-accept event: %v", err)
	}
	if got := len(queue.snapshot()); got != 1 {
		t.Fatalf("timeout replay created %d tasks, want exactly one", got)
	}

	tx := beginLifecycleInboxTestTenant(t, pool, tenantID)
	defer func() { _ = tx.Rollback(context.Background()) }()
	var eventState, dispatchState string
	var attempts int
	var cursor int64
	if err := tx.QueryRow(context.Background(), `
SELECT i.state, d.state, d.attempt_count, c.last_accepted_sequence
  FROM public.automation_lifecycle_event_inbox AS i
  JOIN public.automation_lifecycle_event_dispatches AS d
    ON d.tenant_id=i.tenant_id AND d.source_event_id=i.source_event_id
  JOIN public.automation_lifecycle_subscriber_cursors AS c
    ON c.tenant_id=i.tenant_id AND c.subscriber_id=i.subscriber_key
 WHERE i.tenant_id=$1::uuid AND i.source_event_id=$2`, tenantID, event.SourceEventID).
		Scan(&eventState, &dispatchState, &attempts, &cursor); err != nil {
		t.Fatalf("read timeout recovery outcome: %v", err)
	}
	if eventState != "accepted" || dispatchState != "accepted" || attempts != 2 || cursor != 1 {
		t.Fatalf("timeout recovery state/dispatch/attempts/cursor=%q/%q/%d/%d", eventState, dispatchState, attempts, cursor)
	}
}

func TestPgxLifecycleInboxOrdersRapidTransitionsAndIsolatesTenants(t *testing.T) {
	pool := lifecycleInboxTestPool(t)
	tenantA, subscriberA, _ := seedLifecycleInboxSubscriber(t, pool)
	tenantB, subscriberB, _ := seedLifecycleInboxSubscriber(t, pool)
	autoA := "20000000-0000-4000-8000-000000000001"
	autoB := "20000000-0000-4000-8000-000000000002"
	inbox, queue := newLifecycleInboxHarness(t, pool,
		lifecycleAutomation(autoA, tenantA, "", ""),
		lifecycleAutomation(autoB, tenantB, "", ""),
	)
	sharedSource := "lifecycle-outbox:20000000-0000-4000-8000-000000000099"
	a2 := lifecycleInboxEvent(tenantA, subscriberA,
		"lifecycle-outbox:20000000-0000-4000-8000-000000000098", 2, "lead", "mql")
	if err := inbox.Dispatch(context.Background(), a2); !errors.Is(err, ErrLifecycleEventOutOfOrder) {
		t.Fatalf("sequence 2 before 1 error=%v", err)
	}
	if len(queue.snapshot()) != 0 {
		t.Fatal("out-of-order transition reached the execution queue")
	}
	a1 := lifecycleInboxEvent(tenantA, subscriberA, sharedSource, 1, "subscriber", "lead")
	if err := inbox.Dispatch(context.Background(), a1); err != nil {
		t.Fatalf("dispatch sequence 1: %v", err)
	}
	conflictingReplay := a1
	conflictingReplay.Payload = map[string]interface{}{
		"event_name": canonical.TriggerLifecycleStageChanged,
		"from_stage": "subscriber",
		"to_stage":   "mql",
		"score":      float64(4),
	}
	if err := inbox.Dispatch(context.Background(), conflictingReplay); !errors.Is(err, ErrLifecycleEventConflict) {
		t.Fatalf("altered duplicate source error=%v, want conflict", err)
	}
	if err := inbox.Dispatch(context.Background(), a2); err != nil {
		t.Fatalf("retry sequence 2: %v", err)
	}
	b1 := lifecycleInboxEvent(tenantB, subscriberB, sharedSource, 1, "subscriber", "lead")
	if err := inbox.Dispatch(context.Background(), b1); err != nil {
		t.Fatalf("same source id in second tenant: %v", err)
	}
	queued := queue.snapshot()
	if len(queued) != 3 ||
		queued[0].RunID != durableRunID(autoA, tenantA+"\x00"+a1.SourceEventID) ||
		queued[1].RunID != durableRunID(autoA, tenantA+"\x00"+a2.SourceEventID) ||
		queued[2].AutomationID != autoB {
		t.Fatalf("ordered/cross-tenant queue=%#v", queued)
	}

	// A tenant cannot bind an event to another tenant's subscriber identity.
	crossed := lifecycleInboxEvent(tenantA, subscriberB,
		"lifecycle-outbox:20000000-0000-4000-8000-000000000097", 3, "mql", "sql")
	if err := inbox.Dispatch(context.Background(), crossed); !errors.Is(err, ErrLifecycleSubscriberAbsent) {
		t.Fatalf("cross-tenant subscriber error=%v", err)
	}
	tx := beginLifecycleInboxTestTenant(t, pool, tenantA)
	var visibleShared int
	if err := tx.QueryRow(context.Background(), `
SELECT count(*) FROM public.automation_lifecycle_event_inbox
 WHERE source_event_id=$1`, sharedSource).Scan(&visibleShared); err != nil {
		t.Fatalf("read tenant-isolated shared source: %v", err)
	}
	_ = tx.Commit(context.Background())
	if visibleShared != 1 {
		t.Fatalf("tenant A sees %d shared-source receipts, want only its own", visibleShared)
	}
}

func TestPgxLifecycleInboxRejectsInvalidStagesAndRetainsErasureTombstone(t *testing.T) {
	pool := lifecycleInboxTestPool(t)
	tenantID, subscriberID, _ := seedLifecycleInboxSubscriber(t, pool)
	invalid := lifecycleInboxEvent(tenantID, subscriberID,
		"lifecycle-outbox:30000000-0000-4000-8000-000000000099", 1, "engaged", "at_risk")
	if _, err := receiptFromEngagementEvent(invalid); !errors.Is(err, ErrInvalidLifecycleEvent) {
		t.Fatalf("invalid event stage error=%v", err)
	}

	invalidAuto := lifecycleAutomation(
		"30000000-0000-4000-8000-000000000001", tenantID, "engaged", "at_risk")
	inbox, queue := newLifecycleInboxHarness(t, pool, invalidAuto)
	valid := lifecycleInboxEvent(tenantID, subscriberID,
		"lifecycle-outbox:30000000-0000-4000-8000-000000000098", 1, "subscriber", "lead")
	if err := inbox.Dispatch(context.Background(), valid); !errors.Is(err, ErrLifecycleDispatchFailed) {
		t.Fatalf("invalid automation definition error=%v", err)
	}
	if len(queue.snapshot()) != 0 {
		t.Fatal("invalid lifecycle definition reached the execution queue")
	}
	// The runtime role may advance delivery state but cannot rewrite immutable
	// event semantics after receipt. Column-level grants make the evidence
	// tamper-resistant even if an unrelated app path is compromised.
	tx := beginLifecycleInboxTestTenant(t, pool, tenantID)
	if _, err := tx.Exec(context.Background(), `
UPDATE public.automation_lifecycle_event_inbox SET next_stage='customer'
 WHERE tenant_id=$1::uuid AND source_event_id=$2`, tenantID, valid.SourceEventID); err == nil {
		_ = tx.Rollback(context.Background())
		t.Fatal("application role rewrote immutable lifecycle inbox semantics")
	}
	_ = tx.Rollback(context.Background())

	// Deleting the subscriber must proceed without cascading away the receipt.
	// The migration trigger converts it to a PII-free terminal tombstone.
	tx = beginLifecycleInboxTestTenant(t, pool, tenantID)
	if _, err := tx.Exec(context.Background(), `
DELETE FROM public.subscribers WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, subscriberID); err != nil {
		t.Fatalf("erase subscriber with lifecycle receipt: %v", err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatalf("commit subscriber erasure: %v", err)
	}
	tx = beginLifecycleInboxTestTenant(t, pool, tenantID)
	var state string
	var liveID *string
	var key string
	if err := tx.QueryRow(context.Background(), `
SELECT state, subscriber_id::text, subscriber_key::text
  FROM public.automation_lifecycle_event_inbox
 WHERE tenant_id=$1::uuid AND source_event_id=$2`, tenantID, valid.SourceEventID).
		Scan(&state, &liveID, &key); err != nil {
		t.Fatalf("read lifecycle erasure tombstone: %v", err)
	}
	_ = tx.Commit(context.Background())
	if state != "subscriber_erased" || liveID != nil || key != subscriberID {
		t.Fatalf("erasure tombstone state/live/key=%q/%v/%q", state, liveID, key)
	}
}
