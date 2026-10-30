// SPDX-License-Identifier: AGPL-3.0-only

package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/outbox"
	"github.com/postwave/postwave/apps/api/internal/scoring"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
)

type failingLifecycleOutbox struct{ err error }

func (f failingLifecycleOutbox) Append(context.Context, pgx.Tx, outbox.Append) (string, error) {
	return "", f.err
}

type recordingLifecycleForwarder struct {
	called int
	last   LifecycleStageEvent
	err    error
}

func (f *recordingLifecycleForwarder) ForwardLifecycleStageChanged(_ context.Context, event LifecycleStageEvent) error {
	f.called++
	f.last = event
	return f.err
}

func lifecycleTestRepo(t *testing.T) (*Repo, *db.Pool, string, string, string) {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping lifecycle database test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := db.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect lifecycle test database: %v", err)
	}
	t.Cleanup(pool.Close)
	tenantID := uuid.NewString()
	subscriberID := uuid.NewString()
	email := "lifecycle-" + uuid.NewString() + "@example.test"
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open lifecycle seed transaction: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, 'lifecycle-test', 'studio')`, tenantID, "lifecycle-"+strings.ReplaceAll(tenantID, "-", "")); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed lifecycle tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (id, tenant_id, email, primary_email, status, mailchimp_status, consent_source)
VALUES ($1::uuid, $2::uuid, $3, $3, 'unconfirmed', 'pending', 'unknown')`, subscriberID, tenantID, email); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed lifecycle subscriber: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit lifecycle seed: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		cleanup, err := db.WithTenant(cleanupCtx, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = cleanup.Rollback(cleanupCtx) }()
		_, _ = cleanup.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = cleanup.Commit(cleanupCtx)
	})
	return &Repo{Pool: pool, AutomationOutbox: &outbox.Repo{Pool: pool}}, pool, tenantID, subscriberID, email
}

func TestLifecycleMutationIsRevisionBoundAuditedAndAutomationDurable(t *testing.T) {
	repo, pool, tenantID, subscriberID, email := lifecycleTestRepo(t)
	ctx := context.Background()
	initial, err := repo.Get(ctx, tenantID, subscriberID)
	if err != nil {
		t.Fatalf("get default lifecycle: %v", err)
	}
	if initial.Stage != StageSubscriber || initial.Score != 3 || initial.SubscriberVersion == "" {
		t.Fatalf("default lifecycle = %#v", initial)
	}
	if initial.UpdatedAt.IsZero() {
		t.Fatalf("implicit lifecycle returned an unusable zero updated_at: %#v", initial)
	}
	distribution, err := repo.Distribution(ctx, tenantID)
	if err != nil {
		t.Fatalf("read implicit lifecycle distribution: %v", err)
	}
	if len(distribution) != 1 || distribution[0].Stage != StageSubscriber || distribution[0].Count != 1 {
		t.Fatalf("implicit lifecycle distribution = %#v, want subscriber=1", distribution)
	}
	meta := db.AuditMeta{ActorType: "human", ActorLabel: "lifecycle-db-test"}
	lead, err := repo.Upsert(ctx, tenantID, subscriberID, UpsertInput{
		Stage: "lead", Score: intPointer(4), Source: "desktop", Reason: "reviewed transition",
	}, initial.SubscriberVersion, meta)
	if err != nil {
		t.Fatalf("transition to lead: %v", err)
	}
	if !lead.Transitioned || lead.PreviousStage == nil || *lead.PreviousStage != StageSubscriber || lead.TransitionSequence != 1 || lead.SubscriberVersion == initial.SubscriberVersion {
		t.Fatalf("lead transition = %#v", lead)
	}
	if _, err := repo.Upsert(ctx, tenantID, subscriberID, UpsertInput{Stage: "customer", Score: intPointer(4)}, initial.SubscriberVersion, meta); !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("stale lifecycle transition error=%v, want ErrPreconditionFailed", err)
	}
	scored, err := repo.Upsert(ctx, tenantID, subscriberID, UpsertInput{
		Stage: "lead", Score: intPointer(5), Source: "desktop",
	}, lead.SubscriberVersion, meta)
	if err != nil {
		t.Fatalf("update lifecycle score: %v", err)
	}
	if scored.Transitioned || scored.Score != 5 || scored.TransitionSequence != 1 || scored.SubscriberVersion == lead.SubscriberVersion {
		t.Fatalf("score-only lifecycle change = %#v", scored)
	}
	noOp, err := repo.Upsert(ctx, tenantID, subscriberID, UpsertInput{
		Stage: "lead", Score: intPointer(5), Source: "desktop",
	}, scored.SubscriberVersion, meta)
	if err != nil {
		t.Fatalf("repeat lifecycle state: %v", err)
	}
	if noOp.SubscriberVersion != scored.SubscriberVersion || noOp.Transitioned || noOp.TransitionSequence != 1 {
		t.Fatalf("no-op lifecycle write advanced state: before=%#v after=%#v", scored, noOp)
	}

	verify, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open lifecycle verification: %v", err)
	}
	var audits, transitions, intents, canonicalEvents int
	var transitionSequence, sidecarSequence int64
	var payload string
	if err := verify.QueryRow(ctx, `
SELECT count(*) FROM audit_log
 WHERE tenant_id = $1::uuid AND resource_id = $2
   AND action = 'subscriber.lifecycle_changed'`, tenantID, subscriberID).Scan(&audits); err != nil {
		_ = verify.Rollback(ctx)
		t.Fatalf("read lifecycle audits: %v", err)
	}
	if err := verify.QueryRow(ctx, `
SELECT count(*) FROM subscriber_lifecycle_events
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid`, tenantID, subscriberID).Scan(&transitions); err != nil {
		_ = verify.Rollback(ctx)
		t.Fatalf("read lifecycle transitions: %v", err)
	}
	if err := verify.QueryRow(ctx, `
SELECT transition_sequence
  FROM subscriber_lifecycle_events
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid`, tenantID, subscriberID).Scan(&transitionSequence); err != nil {
		_ = verify.Rollback(ctx)
		t.Fatalf("read lifecycle transition sequence: %v", err)
	}
	if err := verify.QueryRow(ctx, `
SELECT transition_sequence
  FROM subscriber_lifecycle
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid`, tenantID, subscriberID).Scan(&sidecarSequence); err != nil {
		_ = verify.Rollback(ctx)
		t.Fatalf("read lifecycle sidecar sequence: %v", err)
	}
	if err := verify.QueryRow(ctx, `
SELECT count(*)
  FROM outbox_events
 WHERE tenant_id = $1::uuid AND kind = $2`, tenantID, AutomationOutboxKind).Scan(&intents); err != nil {
		_ = verify.Rollback(ctx)
		t.Fatalf("count lifecycle automation intents: %v", err)
	}
	if err := verify.QueryRow(ctx, `
SELECT count(*)
  FROM subscriber_events
 WHERE tenant_id = $1::uuid
   AND subscriber_email = $2
   AND event_type = 'lifecycle_stage_changed'
   AND source = 'lifecycle'
   AND metadata ->> 'previous_stage' = 'subscriber'
   AND metadata ->> 'stage' = 'lead'
   AND metadata ->> 'score' = '4'
   AND metadata ->> 'transition_sequence' = '1'`, tenantID, email).Scan(&canonicalEvents); err != nil {
		_ = verify.Rollback(ctx)
		t.Fatalf("count canonical lifecycle events: %v", err)
	}
	if err := verify.QueryRow(ctx, `
SELECT payload::text
  FROM outbox_events
 WHERE tenant_id = $1::uuid AND kind = $2
 ORDER BY created_at DESC
 LIMIT 1`, tenantID, AutomationOutboxKind).Scan(&payload); err != nil {
		_ = verify.Rollback(ctx)
		t.Fatalf("read lifecycle automation intent: %v", err)
	}
	if err := verify.Commit(ctx); err != nil {
		t.Fatalf("commit lifecycle verification: %v", err)
	}
	if audits != 2 || transitions != 1 || intents != 1 || canonicalEvents != 1 {
		t.Fatalf("lifecycle side effects audits/transitions/intents/events=%d/%d/%d/%d, want 2/1/1/1", audits, transitions, intents, canonicalEvents)
	}
	if transitionSequence != 1 || sidecarSequence != 1 {
		t.Fatalf("lifecycle ordered sequences event/sidecar=%d/%d, want 1/1", transitionSequence, sidecarSequence)
	}
	if strings.Contains(strings.ToLower(payload), "example.test") || !strings.Contains(payload, subscriberID) || !strings.Contains(payload, `"transition_sequence": 1`) {
		t.Fatalf("lifecycle outbox payload retained PII or lost opaque identity: %s", payload)
	}

	repo.AutomationOutbox = failingLifecycleOutbox{err: errors.New("forced lifecycle outbox failure")}
	if _, err := repo.Upsert(ctx, tenantID, subscriberID, UpsertInput{
		Stage: "customer", Score: intPointer(5), Source: "desktop",
	}, scored.SubscriberVersion, meta); !errors.Is(err, ErrAutomationOutboxRequired) {
		t.Fatalf("lifecycle outbox failure=%v", err)
	}
	afterFailure, err := repo.Get(ctx, tenantID, subscriberID)
	if err != nil {
		t.Fatalf("read lifecycle rollback: %v", err)
	}
	if afterFailure.Stage != StageLead || afterFailure.Score != 5 || afterFailure.TransitionSequence != 1 || afterFailure.SubscriberVersion != scored.SubscriberVersion {
		t.Fatalf("failed transition escaped rollback: before=%#v after=%#v", scored, afterFailure)
	}

	timeline, err := (&subscribers.Repo{Pool: pool}).GetTimeline(
		ctx, tenantID, subscriberID, nil, 50,
	)
	if err != nil {
		t.Fatalf("read lifecycle event from canonical timeline: %v", err)
	}
	foundTimelineEvent := false
	for _, event := range timeline.Events {
		if event.Type != "lifecycle_stage_changed" {
			continue
		}
		foundTimelineEvent = true
		if event.Source != "subscriber_events" || event.Detail["previous_stage"] != "subscriber" || event.Detail["stage"] != "lead" {
			t.Fatalf("canonical lifecycle timeline event = %#v", event)
		}
	}
	if !foundTimelineEvent {
		t.Fatalf("canonical lifecycle event missing from timeline: %#v", timeline.Events)
	}
	if timeline.Stats.LastActiveAt != nil {
		t.Fatalf("operator lifecycle change incorrectly counted as subscriber engagement: %#v", timeline.Stats)
	}

	ruleTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open lifecycle scoring rule transaction: %v", err)
	}
	if _, err := ruleTx.Exec(ctx, `
INSERT INTO scoring_rules (tenant_id, event_type, weight, note)
VALUES ($1::uuid, 'lifecycle_stage_changed', 7, 'lifecycle integration proof')`, tenantID); err != nil {
		_ = ruleTx.Rollback(ctx)
		t.Fatalf("seed lifecycle scoring rule: %v", err)
	}
	if err := ruleTx.Commit(ctx); err != nil {
		t.Fatalf("commit lifecycle scoring rule: %v", err)
	}
	if _, err := scoring.RecomputeTenant(ctx, pool, tenantID); err != nil {
		t.Fatalf("recompute score from lifecycle event: %v", err)
	}
	scoreTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open lifecycle score verification: %v", err)
	}
	var engagementScore int
	if err := scoreTx.QueryRow(ctx, `
SELECT engagement_score
  FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriberID).Scan(&engagementScore); err != nil {
		_ = scoreTx.Rollback(ctx)
		t.Fatalf("read lifecycle-derived score: %v", err)
	}
	if err := scoreTx.Commit(ctx); err != nil {
		t.Fatalf("commit lifecycle score verification: %v", err)
	}
	if engagementScore != 7 {
		t.Fatalf("lifecycle-derived engagement score=%d, want 7", engagementScore)
	}
}

func TestMigration1770KeepsPreSequenceLifecycleWriterCompatible(t *testing.T) {
	_, pool, tenantID, subscriberID, _ := lifecycleTestRepo(t)
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open legacy lifecycle writer transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// This is the exact pre-1770 write shape: the sidecar and history INSERTs
	// omit transition_sequence. The compatibility trigger must allocate it
	// under the sidecar-row lock before the new NOT NULL constraint is checked.
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_lifecycle (subscriber_id, tenant_id, stage, score)
VALUES ($1::uuid, $2::uuid, 'lead', 4)`, subscriberID, tenantID); err != nil {
		t.Fatalf("legacy sidecar insert: %v", err)
	}
	var firstSequence int64
	if err := tx.QueryRow(ctx, `
INSERT INTO subscriber_lifecycle_events
    (tenant_id, subscriber_id, previous_stage, next_stage, score, source, reason)
VALUES ($1::uuid, $2::uuid, 'subscriber', 'lead', 4, 'legacy-api', '')
RETURNING transition_sequence`, tenantID, subscriberID).Scan(&firstSequence); err != nil {
		t.Fatalf("legacy history insert: %v", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE subscriber_lifecycle SET stage='customer', score=5
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid`, tenantID, subscriberID); err != nil {
		t.Fatalf("legacy sidecar update: %v", err)
	}
	var secondSequence, sidecarSequence int64
	if err := tx.QueryRow(ctx, `
INSERT INTO subscriber_lifecycle_events
    (tenant_id, subscriber_id, previous_stage, next_stage, score, source, reason)
VALUES ($1::uuid, $2::uuid, 'lead', 'customer', 5, 'legacy-api', '')
RETURNING transition_sequence`, tenantID, subscriberID).Scan(&secondSequence); err != nil {
		t.Fatalf("second legacy history insert: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT transition_sequence FROM subscriber_lifecycle
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid`, tenantID, subscriberID).Scan(&sidecarSequence); err != nil {
		t.Fatalf("read legacy-compatible high-water: %v", err)
	}
	if firstSequence != 1 || secondSequence != 2 || sidecarSequence != 2 {
		t.Fatalf("legacy sequences first/second/sidecar=%d/%d/%d, want 1/2/2",
			firstSequence, secondSequence, sidecarSequence)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit legacy lifecycle writer proof: %v", err)
	}
}

func TestLifecycleDistributionExcludesArchivedProfiles(t *testing.T) {
	repo, pool, tenantID, subscriberID, _ := lifecycleTestRepo(t)
	ctx := context.Background()
	before, err := repo.Distribution(ctx, tenantID)
	if err != nil {
		t.Fatalf("read active lifecycle distribution: %v", err)
	}
	if len(before) != 1 || before[0].Count != 1 {
		t.Fatalf("active lifecycle distribution = %#v, want one subscriber", before)
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open lifecycle archive transaction: %v", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE subscribers
   SET archived_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriberID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("archive lifecycle subscriber: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit lifecycle archive: %v", err)
	}
	after, err := repo.Distribution(ctx, tenantID)
	if err != nil {
		t.Fatalf("read archived lifecycle distribution: %v", err)
	}
	if len(after) != 0 {
		t.Fatalf("archived profile leaked into lifecycle distribution: %#v", after)
	}
}

func TestSubscriberRevisionCannotMoveBackwardWhenAnOlderTransactionWaits(t *testing.T) {
	_, pool, tenantID, subscriberID, _ := lifecycleTestRepo(t)
	ctx := context.Background()
	older, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open older subscriber transaction: %v", err)
	}
	defer func() { _ = older.Rollback(ctx) }()
	// Establish the older transaction timestamp before the competing writer.
	var olderStartedAt time.Time
	if err := older.QueryRow(ctx, `SELECT now()`).Scan(&olderStartedAt); err != nil {
		t.Fatalf("read older transaction timestamp: %v", err)
	}
	time.Sleep(5 * time.Millisecond)

	newer, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open newer subscriber transaction: %v", err)
	}
	var newerRevision time.Time
	if err := newer.QueryRow(ctx, `
UPDATE subscribers
   SET custom_fields = custom_fields || '{"revision_probe":"newer"}'::jsonb
 WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING updated_at`, tenantID, subscriberID).Scan(&newerRevision); err != nil {
		_ = newer.Rollback(ctx)
		t.Fatalf("write newer subscriber revision: %v", err)
	}
	if err := newer.Commit(ctx); err != nil {
		t.Fatalf("commit newer subscriber revision: %v", err)
	}
	if !newerRevision.After(olderStartedAt) {
		t.Fatalf("test did not establish ordered transaction timestamps: older=%s newer=%s", olderStartedAt, newerRevision)
	}

	var finalRevision time.Time
	if err := older.QueryRow(ctx, `
UPDATE subscribers
   SET custom_fields = custom_fields || '{"revision_probe":"older"}'::jsonb
 WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING updated_at`, tenantID, subscriberID).Scan(&finalRevision); err != nil {
		t.Fatalf("write from older subscriber transaction: %v", err)
	}
	if err := older.Commit(ctx); err != nil {
		t.Fatalf("commit older subscriber transaction: %v", err)
	}
	if !finalRevision.After(newerRevision) {
		t.Fatalf("subscriber revision moved backward: newer=%s final=%s", newerRevision, finalRevision)
	}
}

func TestLifecycleAutomationOutboxResolvesCurrentAddressAndUsesStableIdempotency(t *testing.T) {
	repo, pool, tenantID, subscriberID, originalEmail := lifecycleTestRepo(t)
	forwarder := &recordingLifecycleForwarder{}
	handler := &AutomationOutboxHandler{Repo: repo, Forwarder: forwarder}
	currentEmail := "lifecycle-current-" + uuid.NewString() + "@example.test"
	update, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("open lifecycle address update: %v", err)
	}
	if _, err := update.Exec(context.Background(), `
UPDATE subscribers
   SET email = $3, primary_email = $3
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriberID, currentEmail); err != nil {
		_ = update.Rollback(context.Background())
		t.Fatalf("change lifecycle subscriber address: %v", err)
	}
	if err := update.Commit(context.Background()); err != nil {
		t.Fatalf("commit lifecycle address update: %v", err)
	}
	at := time.Date(2026, 7, 19, 6, 0, 0, 0, time.UTC)
	payload, _ := json.Marshal(lifecycleAutomationPayload{
		SubscriberID:       subscriberID,
		FromStage:          "subscriber",
		ToStage:            "lead",
		Score:              4,
		At:                 at,
		TransitionSequence: 1,
	})
	eventID := uuid.NewString()
	event := outbox.Event{
		ID: eventID, TenantID: tenantID, Kind: AutomationOutboxKind, Payload: payload,
	}
	if err := handler.Handle(context.Background(), event); err != nil {
		t.Fatalf("deliver lifecycle automation outbox: %v", err)
	}
	if forwarder.called != 1 || forwarder.last.SubscriberID != subscriberID || forwarder.last.SubscriberEmail != currentEmail || forwarder.last.SubscriberEmail == originalEmail || forwarder.last.SourceEventID != "lifecycle-outbox:"+eventID || forwarder.last.TransitionSequence != 1 || !forwarder.last.At.Equal(at) {
		t.Fatalf("forwarded lifecycle event = %#v", forwarder)
	}
}

func TestLifecycleAutomationOutboxTreatsErasedSubscriberAsTerminal(t *testing.T) {
	repo, pool, tenantID, subscriberID, _ := lifecycleTestRepo(t)
	remove, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("open lifecycle erasure transaction: %v", err)
	}
	if _, err := remove.Exec(context.Background(), `
DELETE FROM subscribers WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriberID); err != nil {
		_ = remove.Rollback(context.Background())
		t.Fatalf("erase lifecycle subscriber: %v", err)
	}
	if err := remove.Commit(context.Background()); err != nil {
		t.Fatalf("commit lifecycle subscriber erasure: %v", err)
	}
	payload, _ := json.Marshal(lifecycleAutomationPayload{
		SubscriberID:       subscriberID,
		FromStage:          "lead",
		ToStage:            "customer",
		Score:              5,
		At:                 time.Now().UTC(),
		TransitionSequence: 2,
	})
	forwarder := &recordingLifecycleForwarder{}
	err = (&AutomationOutboxHandler{Repo: repo, Forwarder: forwarder}).Handle(
		context.Background(),
		outbox.Event{ID: uuid.NewString(), TenantID: tenantID, Kind: AutomationOutboxKind, Payload: payload},
	)
	if err != nil || forwarder.called != 0 {
		t.Fatalf("erased subscriber delivery err/calls=%v/%d, want terminal no-op", err, forwarder.called)
	}
}

func TestLifecycleAutomationOutboxTreatsArchivedSubscriberAsTerminal(t *testing.T) {
	repo, pool, tenantID, subscriberID, _ := lifecycleTestRepo(t)
	archive, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("open lifecycle archive transaction: %v", err)
	}
	if _, err := archive.Exec(context.Background(), `
UPDATE subscribers SET archived_at=clock_timestamp()
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, subscriberID); err != nil {
		_ = archive.Rollback(context.Background())
		t.Fatalf("archive lifecycle subscriber: %v", err)
	}
	if err := archive.Commit(context.Background()); err != nil {
		t.Fatalf("commit lifecycle subscriber archive: %v", err)
	}
	payload, _ := json.Marshal(lifecycleAutomationPayload{
		SubscriberID:       subscriberID,
		FromStage:          "lead",
		ToStage:            "customer",
		Score:              5,
		At:                 time.Now().UTC(),
		TransitionSequence: 2,
	})
	forwarder := &recordingLifecycleForwarder{}
	err = (&AutomationOutboxHandler{Repo: repo, Forwarder: forwarder}).Handle(
		context.Background(),
		outbox.Event{ID: uuid.NewString(), TenantID: tenantID, Kind: AutomationOutboxKind, Payload: payload},
	)
	if err != nil || forwarder.called != 0 {
		t.Fatalf("archived subscriber delivery err/calls=%v/%d, want terminal no-op", err, forwarder.called)
	}
}

func TestLifecycleConcurrentEditsHaveExactlyOneWinner(t *testing.T) {
	repo, _, tenantID, subscriberID, _ := lifecycleTestRepo(t)
	ctx := context.Background()
	initial, err := repo.Get(ctx, tenantID, subscriberID)
	if err != nil {
		t.Fatalf("read initial lifecycle: %v", err)
	}
	start := make(chan struct{})
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for _, stage := range []string{"lead", "customer"} {
		stage := stage
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, writeErr := repo.Upsert(ctx, tenantID, subscriberID, UpsertInput{
				Stage: stage, Score: intPointer(4), Source: "concurrency-test",
			}, initial.SubscriberVersion, db.AuditMeta{ActorType: "system", ActorLabel: "concurrency-test"})
			errs <- writeErr
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	winners, stale := 0, 0
	for writeErr := range errs {
		switch {
		case writeErr == nil:
			winners++
		case errors.Is(writeErr, ErrPreconditionFailed):
			stale++
		default:
			t.Fatalf("concurrent lifecycle write failed unexpectedly: %v", writeErr)
		}
	}
	if winners != 1 || stale != 1 {
		t.Fatalf("concurrent outcomes winners/stale=%d/%d, want 1/1", winners, stale)
	}
}

func intPointer(value int) *int { return &value }
