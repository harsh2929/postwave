// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// stageTwoFixture is a single MESSAGE with a machine-shaped event burst.
//
// The shape is the whole point of Stage 2. One open, alone, carries no evidence
// at all — the classifier scores it 0.50 and calls it unknown. The same open
// sitting inside a delivery followed one second later by eight opens two hundred
// milliseconds apart is a prefetch inside a burst. Nothing about the second
// reading is available when the first event is classified on arrival.
type stageTwoFixture struct {
	TenantID        string
	ForeignTenantID string
	CampaignID      string
	MessageHash     string
	Suffix          string
	Delivered       EventRef
	Opens           []EventRef
	// FirstIngested is the occurred_at of the first observation written for this
	// message; the delayed evaluation is due exactly StageTwoDelay after it.
	FirstIngested time.Time
}

func seedStageTwoFixture(
	t *testing.T,
	ctx context.Context,
	admin *pgxpool.Pool,
	openCount int,
	openSpacing time.Duration,
) stageTwoFixture {
	t.Helper()
	return seedStageTwoFixtureForTenant(t, ctx, admin, uuid.NewString(), openCount, openSpacing)
}

// seedStageTwoFixtureForTenant is seedStageTwoFixture with the tenant id chosen
// by the caller. Only the sweep-ordering proof needs that: SweepOnce pages
// tenants by id, so a test about WHICH page a tenant lands on has to be able to
// place it.
func seedStageTwoFixtureForTenant(
	t *testing.T,
	ctx context.Context,
	admin *pgxpool.Pool,
	tenantID string,
	openCount int,
	openSpacing time.Duration,
) stageTwoFixture {
	t.Helper()
	fixture := stageTwoFixture{
		TenantID: tenantID, ForeignTenantID: uuid.NewString(),
		CampaignID: uuid.NewString(),
	}
	// The suffix only has to be UNIQUE — it namespaces slugs, addresses, provider
	// event ids and the message identity. It is drawn independently of the tenant
	// id so that a caller which chooses tenant ids for their ORDER (see
	// seedStageTwoFixtureForTenant's callers) does not thereby collide two
	// fixtures onto one slug.
	fixture.Suffix = strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	digest := sha256.Sum256([]byte("stage-two-message-" + fixture.Suffix))
	fixture.MessageHash = hex.EncodeToString(digest[:])
	base := time.Now().UTC().Truncate(time.Microsecond)

	tx, err := admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier) VALUES
    ($1::uuid, $2, 'F01 stage two tenant', 'studio'),
    ($3::uuid, $4, 'F01 stage two foreign tenant', 'studio')`,
		fixture.TenantID, "f01-s2-"+fixture.Suffix,
		fixture.ForeignTenantID, "f01-s2f-"+fixture.Suffix); err != nil {
		t.Fatalf("seed stage two tenants: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO campaigns (id, tenant_id, name, subject, body_html)
VALUES ($1::uuid, $2::uuid, 'F01 stage two campaign', 'F01', '<p>F01</p>')`,
		fixture.CampaignID, fixture.TenantID); err != nil {
		t.Fatalf("seed stage two campaign: %v", err)
	}

	insert := func(eventType string, at time.Time, index int) EventRef {
		var event EventRef
		if err := tx.QueryRow(ctx, `
INSERT INTO subscriber_events (
    tenant_id, subscriber_email, event_type, campaign_id, source,
    provider_event_id, source_event_id, message_id, metadata, at
) VALUES (
    $1::uuid, $2, $3, $4::uuid, 'f01-stage-two', $5, $5, $6, '{}'::jsonb, $7
)
RETURNING id, at`, fixture.TenantID,
			fmt.Sprintf("s2-%s@example.test", fixture.Suffix), eventType,
			fixture.CampaignID,
			fmt.Sprintf("s2-%s-%s-%d", fixture.Suffix, eventType, index),
			fmt.Sprintf("<s2-%s@example.test>", fixture.Suffix), at,
		).Scan(&event.ID, &event.At); err != nil {
			t.Fatalf("seed stage two %s event %d: %v", eventType, index, err)
		}
		return event
	}

	// Delivery first in TIME, ingested last, so the opens are classified on
	// arrival without ever seeing it.
	fixture.Delivered = insert("delivered", base, 0)
	for index := 0; index < openCount; index++ {
		at := base.Add(time.Second + time.Duration(index)*openSpacing)
		fixture.Opens = append(fixture.Opens, insert("opened", at, index))
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit stage two fixture: %v", err)
	}
	fixture.FirstIngested = fixture.Opens[0].At
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_, _ = admin.Exec(cleanupCtx,
			`DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
			fixture.TenantID, fixture.ForeignTenantID)
	})
	return fixture
}

func stageTwoObservation(fixture stageTwoFixture, event EventRef, key string) ObservationInput {
	return ObservationInput{
		EventRef: event, Source: "f01-stage-two",
		SourceEventID:      "stage-two-" + key,
		IdempotencyKey:     fmt.Sprintf("f01-stage-two-%s-%s", fixture.Suffix, key),
		EventSchemaVersion: ObservationSchemaV1,
		// Replaced from the canonical subscriber_events row by the ingest path.
		EventType: "opened", OccurredAt: event.At, IngestedAt: event.At,
		MessageIdentityHash: fixture.MessageHash,
		OrderedHeaders:      []Header{{Name: "Accept-Language", Value: "en-US"}},
		ProviderSignals:     map[string]any{},
		PrivacyExpiryAt:     event.At.Add(365 * 24 * time.Hour),
	}
}

// stageTwoIngest writes one observation exactly the way production does: through
// IngestHook with the real aggregate builder, inside one tenant-worker
// transaction. Stage 1 therefore sees precisely the evidence that exists at that
// moment and nothing more.
func stageTwoIngest(
	t *testing.T,
	ctx context.Context,
	repo *Repo,
	classifier *Classifier,
	tenantID string,
	observation ObservationInput,
) RecordReceipt {
	t.Helper()
	hook := &IngestHook{
		Repo: repo, Classifier: classifier,
		AggregateBuilder: AggregateBuilderFunc(loadMessageAggregate),
	}
	tx, err := db.WithTenantWorker(ctx, repo.Pool, tenantID)
	if err != nil {
		t.Fatalf("open stage two ingest transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	receipt, err := hook.Record(ctx, tx, tenantID, observation)
	if err != nil {
		t.Fatalf("stage two ingest: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit stage two ingest: %v", err)
	}
	return receipt
}

// stageTwoIngestAll writes the eight opens and then the delivery.
func stageTwoIngestAll(
	t *testing.T,
	ctx context.Context,
	repo *Repo,
	classifier *Classifier,
	fixture stageTwoFixture,
) {
	t.Helper()
	for index, event := range fixture.Opens {
		stageTwoIngest(t, ctx, repo, classifier, fixture.TenantID,
			stageTwoObservation(fixture, event, fmt.Sprintf("open-%d", index)))
	}
	stageTwoIngest(t, ctx, repo, classifier, fixture.TenantID,
		stageTwoObservation(fixture, fixture.Delivered, "delivered"))
}

func stageTwoRepo(t *testing.T, app *pgxpool.Pool, workerID string) *Repo {
	t.Helper()
	return &Repo{
		Pool: (*db.Pool)(app), ReclassificationWorkerID: workerID,
		ReclassificationLeaseTTL: 2 * time.Minute,
	}
}

func stageTwoWorkerAt(repo *Repo, classifier *Classifier, now time.Time) *StageTwoWorker {
	return &StageTwoWorker{
		Repo: repo, Classifier: classifier, Interval: time.Minute,
		TenantBatchSize: 10, MessageBatchSize: 50,
		Now: func() time.Time { return now },
	}
}

func stageTwoBootstrapClassifier(t *testing.T, ctx context.Context, repo *Repo) *Classifier {
	t.Helper()
	registry, err := repo.LoadRegistry(ctx, CurrentRegistryV2)
	if err != nil || len(registry) == 0 {
		t.Fatalf("load bootstrap registry count=%d err=%v", len(registry), err)
	}
	classifier, err := NewClassifier(DefaultConfig(), registry)
	if err != nil {
		t.Fatalf("compile bootstrap classifier: %v", err)
	}
	return classifier
}

type stageTwoVerdict struct {
	ID                 string
	Classification     string
	MachineSubtype     string
	MethodologyVersion string
	Supersedes         string
	ClassifiedAt       time.Time
}

func stageTwoVerdicts(
	t *testing.T,
	ctx context.Context,
	admin *pgxpool.Pool,
	tenantID string,
	event EventRef,
) []stageTwoVerdict {
	t.Helper()
	rows, err := admin.Query(ctx, `
SELECT id::text, classification, COALESCE(machine_subtype, ''),
       methodology_version, COALESCE(supersedes_id::text, ''), classified_at
  FROM event_classifications
 WHERE tenant_id = $1::uuid
   AND subscriber_event_id = $2 AND subscriber_event_at = $3
 ORDER BY classified_at, id`, tenantID, event.ID, event.At)
	if err != nil {
		t.Fatalf("read verdict lineage: %v", err)
	}
	defer rows.Close()
	out := make([]stageTwoVerdict, 0, 4)
	for rows.Next() {
		var verdict stageTwoVerdict
		if err := rows.Scan(&verdict.ID, &verdict.Classification,
			&verdict.MachineSubtype, &verdict.MethodologyVersion,
			&verdict.Supersedes, &verdict.ClassifiedAt); err != nil {
			t.Fatalf("scan verdict lineage: %v", err)
		}
		out = append(out, verdict)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func stageTwoClassificationCount(
	t *testing.T,
	ctx context.Context,
	admin *pgxpool.Pool,
	tenantID string,
) int {
	t.Helper()
	var count int
	if err := admin.QueryRow(ctx,
		`SELECT count(*) FROM event_classifications WHERE tenant_id = $1::uuid`,
		tenantID).Scan(&count); err != nil {
		t.Fatalf("count classifications: %v", err)
	}
	return count
}

// ---------------------------------------------------------------------------
// 1. The delay itself.
// ---------------------------------------------------------------------------

func TestStageTwoIsDueSixtySecondsAfterTheFirstEventAndOnlyOncePerMessage(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedStageTwoFixture(t, ctx, admin, 4, 10*time.Second)
	repo := stageTwoRepo(t, app, "stage-two-delay")
	classifier := stageTwoBootstrapClassifier(t, ctx, repo)
	stageTwoIngestAll(t, ctx, repo, classifier, fixture)

	first := fixture.FirstIngested
	// Four opens ten seconds apart plus a delivery: five observations, one
	// schedule per stage. If the schedule were re-armed per event the delayed
	// row would be due sixty seconds after the LAST open and a message under
	// continuous traffic would never settle.
	rows, err := admin.Query(ctx, `
SELECT stage, first_event_at, due_at, state
  FROM engagement_stage_two_evaluations
 WHERE tenant_id = $1::uuid AND message_identity_hash = $2
 ORDER BY due_at`, fixture.TenantID, fixture.MessageHash)
	if err != nil {
		t.Fatalf("read stage two schedule: %v", err)
	}
	type scheduled struct {
		stage      string
		firstEvent time.Time
		due        time.Time
		state      string
	}
	schedule := make([]scheduled, 0, 2)
	for rows.Next() {
		var row scheduled
		if err := rows.Scan(&row.stage, &row.firstEvent, &row.due, &row.state); err != nil {
			t.Fatal(err)
		}
		schedule = append(schedule, row)
	}
	rows.Close()
	if len(schedule) != 2 {
		t.Fatalf("stage two schedule rows = %d, want exactly 2 (one per stage); got %+v", len(schedule), schedule)
	}
	if schedule[0].stage != string(StageTwoDelayed) ||
		!schedule[0].firstEvent.Equal(first) ||
		!schedule[0].due.Equal(first.Add(StageTwoDelay)) {
		t.Fatalf("delayed schedule = %+v, want stage=delayed first_event=%s due=%s",
			schedule[0], first, first.Add(StageTwoDelay))
	}
	if schedule[1].stage != string(StageTwoConversionWindowClose) ||
		!schedule[1].due.Equal(first.Add(DefaultStageTwoConversionWindow)) {
		t.Fatalf("conversion-window schedule = %+v, want due=%s",
			schedule[1], first.Add(DefaultStageTwoConversionWindow))
	}

	// Nothing is due before the delay elapses.
	for _, early := range []time.Duration{0, time.Second, StageTwoDelay - time.Second} {
		due, err := repo.DueStageTwoEvaluations(ctx, fixture.TenantID, first.Add(early), 50)
		if err != nil {
			t.Fatalf("due query at +%s: %v", early, err)
		}
		if len(due) != 0 {
			t.Fatalf("at first_event+%s the schedule reported %d due evaluations; the 60s delay is not being honoured", early, len(due))
		}
	}
	due, err := repo.DueStageTwoEvaluations(ctx, fixture.TenantID, first.Add(StageTwoDelay), 50)
	if err != nil {
		t.Fatalf("due query at the delay boundary: %v", err)
	}
	if len(due) != 1 || due[0].Stage != StageTwoDelayed {
		t.Fatalf("at first_event+60s due = %+v, want exactly the delayed stage", due)
	}

	// And the evaluator itself refuses to run early: no stage-two verdict may
	// exist while the message is still settling.
	baselineClassifications := stageTwoClassificationCount(t, ctx, admin, fixture.TenantID)
	early, err := stageTwoWorkerAt(repo, classifier, first.Add(StageTwoDelay-time.Second)).
		EvaluateTenantOnce(ctx, fixture.TenantID)
	if err != nil {
		t.Fatalf("early stage two sweep: %v", err)
	}
	if early.Due != 0 || early.Evaluated != 0 {
		t.Fatalf("stage two ran %d/%d evaluations one second before it was due", early.Evaluated, early.Due)
	}
	if got := stageTwoClassificationCount(t, ctx, admin, fixture.TenantID); got != baselineClassifications {
		t.Fatalf("classifications moved from %d to %d before the delay elapsed", baselineClassifications, got)
	}

	ready, err := stageTwoWorkerAt(repo, classifier, first.Add(StageTwoDelay)).
		EvaluateTenantOnce(ctx, fixture.TenantID)
	if err != nil {
		t.Fatalf("due stage two sweep: %v", err)
	}
	if ready.Due != 1 || ready.Evaluated != 1 || ready.EventsSuperseded != 5 {
		t.Fatalf("stage two at the delay boundary = %+v, want due=1 evaluated=1 superseded=5", ready)
	}

	// The due time is durable, not advisory: nothing may push a scheduled
	// message further out once it is armed.
	workerTx, err := db.WithTenantWorker(ctx, repo.Pool, fixture.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = workerTx.Rollback(ctx) }()
	if err := bindClassifierScope(ctx, workerTx); err != nil {
		t.Fatal(err)
	}
	_, err = workerTx.Exec(ctx, `
UPDATE engagement_stage_two_evaluations
   SET due_at = due_at + interval '1 hour'
 WHERE tenant_id = $1::uuid AND message_identity_hash = $2
   AND stage = 'conversion_window_close'`, fixture.TenantID, fixture.MessageHash)
	if classifierSQLState(err) != "55000" {
		t.Fatalf("moving a scheduled due time error=%v state=%q, want 55000", err, classifierSQLState(err))
	}
	_ = workerTx.Rollback(ctx)
}

// ---------------------------------------------------------------------------
// 2. The verdict change, its lineage, and idempotence.
// ---------------------------------------------------------------------------

func TestStageTwoUpgradesTheVerdictWithSupersedesLineageAndIsIdempotent(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedStageTwoFixture(t, ctx, admin, 8, 200*time.Millisecond)
	repo := stageTwoRepo(t, app, "stage-two-lineage")
	classifier := stageTwoBootstrapClassifier(t, ctx, repo)
	stageTwoIngestAll(t, ctx, repo, classifier, fixture)

	firstOpen := fixture.Opens[0]
	stageOne := stageTwoVerdicts(t, ctx, admin, fixture.TenantID, firstOpen)
	if len(stageOne) != 1 {
		t.Fatalf("stage one verdicts for the first open = %d, want 1", len(stageOne))
	}
	// The premise. Alone, the first open of the message is not machine evidence.
	if stageOne[0].Classification != string(Unknown) || stageOne[0].Supersedes != "" {
		t.Fatalf("stage one verdict = %+v, want an unknown root verdict", stageOne[0])
	}
	stageOneID := stageOne[0].ID
	stageOneMethodology := stageOne[0].MethodologyVersion
	beforeCount := stageTwoClassificationCount(t, ctx, admin, fixture.TenantID)
	if beforeCount != 9 {
		t.Fatalf("stage one classification count = %d, want 9 (8 opens + 1 delivery)", beforeCount)
	}

	worker := stageTwoWorkerAt(repo, classifier, fixture.FirstIngested.Add(StageTwoDelay))
	result, err := worker.EvaluateTenantOnce(ctx, fixture.TenantID)
	if err != nil {
		t.Fatalf("stage two evaluation: %v", err)
	}
	if result.Evaluated != 1 || result.EventsSuperseded != 9 {
		t.Fatalf("stage two result = %+v, want evaluated=1 superseded=9", result)
	}

	lineage := stageTwoVerdicts(t, ctx, admin, fixture.TenantID, firstOpen)
	if len(lineage) != 2 {
		t.Fatalf("verdict lineage = %d rows, want 2 (original + stage two)", len(lineage))
	}
	// The original verdict is untouched. This is the "never an in-place
	// overwrite" half: yesterday's engagement number stays readable and stays
	// attributable to the evidence that produced it.
	if lineage[0].ID != stageOneID || lineage[0].Classification != string(Unknown) ||
		lineage[0].MethodologyVersion != stageOneMethodology || lineage[0].Supersedes != "" {
		t.Fatalf("the original verdict was mutated: %+v", lineage[0])
	}
	// The shape of the traffic downgraded it: a delivery one second before the
	// open, inside a nine-event burst, is a prefetch.
	if lineage[1].Classification != string(Machine) ||
		lineage[1].MachineSubtype != string(SubtypePrefetcher) {
		t.Fatalf("stage two verdict = %+v, want machine/prefetcher", lineage[1])
	}
	if lineage[1].Supersedes != stageOneID {
		t.Fatalf("stage two supersedes_id = %q, want the original verdict %q", lineage[1].Supersedes, stageOneID)
	}
	expectedMethodology, err := stageTwoMethodologyVersion(stageOneMethodology, StageTwoDelayed)
	if err != nil {
		t.Fatal(err)
	}
	if lineage[1].MethodologyVersion != expectedMethodology {
		t.Fatalf("stage two methodology = %q, want %q", lineage[1].MethodologyVersion, expectedMethodology)
	}

	// The customer-facing projection follows the newest verdict.
	tenantTx, err := db.WithTenant(ctx, (*db.Pool)(app), fixture.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	var projected string
	var humanSignal, machineSignal bool
	if err := tenantTx.QueryRow(ctx, `
SELECT classification, human_signal, machine_signal
  FROM subscriber_event_classification_shadow_v1
 WHERE subscriber_event_id = $1 AND subscriber_event_at = $2`,
		firstOpen.ID, firstOpen.At).Scan(&projected, &humanSignal, &machineSignal); err != nil {
		t.Fatalf("read shadow projection: %v", err)
	}
	_ = tenantTx.Rollback(ctx)
	if projected != string(Machine) || humanSignal || !machineSignal {
		t.Fatalf("shadow projection class=%q human=%v machine=%v, want the stage two verdict",
			projected, humanSignal, machineSignal)
	}

	afterFirstPass := stageTwoClassificationCount(t, ctx, admin, fixture.TenantID)
	if afterFirstPass != beforeCount+9 {
		t.Fatalf("stage two appended %d verdicts, want exactly 9 (one per event)", afterFirstPass-beforeCount)
	}

	// IDEMPOTENCE, layer one: the schedule is closed, so the next sweep finds
	// nothing due at all.
	second, err := worker.EvaluateTenantOnce(ctx, fixture.TenantID)
	if err != nil {
		t.Fatalf("second stage two sweep: %v", err)
	}
	if second.Due != 0 || second.Evaluated != 0 || second.AlreadyEvaluated != 0 {
		t.Fatalf("second sweep = %+v, want an entirely empty pass", second)
	}

	// IDEMPOTENCE, layer two: force the evaluation to be attempted again even
	// though its schedule row is closed. The fenced run reports itself already
	// completed and NOT ONE additional verdict is written. Two verdicts here
	// instead of one lineage entry would be a rewritten history.
	replayed, err := worker.evaluate(ctx, StageTwoEvaluation{
		TenantID: fixture.TenantID, MessageIdentityHash: fixture.MessageHash,
		Stage: StageTwoDelayed, FirstEventAt: fixture.FirstIngested,
		DueAt: fixture.FirstIngested.Add(StageTwoDelay), State: "pending",
	})
	if err != nil {
		t.Fatalf("forced stage two replay: %v", err)
	}
	if replayed.AlreadyEvaluated != 1 || replayed.Evaluated != 0 {
		t.Fatalf("forced replay = %+v, want already_evaluated=1 evaluated=0", replayed)
	}
	if got := stageTwoClassificationCount(t, ctx, admin, fixture.TenantID); got != afterFirstPass {
		t.Fatalf("forced replay appended %d extra verdicts; re-running stage two must add none", got-afterFirstPass)
	}
	if again := stageTwoVerdicts(t, ctx, admin, fixture.TenantID, firstOpen); len(again) != 2 {
		t.Fatalf("verdict lineage after replay = %d rows, want 2", len(again))
	}
}

// ---------------------------------------------------------------------------
// 3. Conversion-window close: the second look.
// ---------------------------------------------------------------------------

func TestStageTwoReEvaluatesAgainAtConversionWindowClose(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedStageTwoFixture(t, ctx, admin, 8, 200*time.Millisecond)
	repo := stageTwoRepo(t, app, "stage-two-window")
	classifier := stageTwoBootstrapClassifier(t, ctx, repo)
	stageTwoIngestAll(t, ctx, repo, classifier, fixture)

	delayed, err := stageTwoWorkerAt(repo, classifier, fixture.FirstIngested.Add(StageTwoDelay)).
		EvaluateTenantOnce(ctx, fixture.TenantID)
	if err != nil || delayed.Evaluated != 1 {
		t.Fatalf("delayed pass = %+v err=%v", delayed, err)
	}

	// Nothing more is due until the attribution window closes.
	between, err := repo.DueStageTwoEvaluations(ctx, fixture.TenantID,
		fixture.FirstIngested.Add(DefaultStageTwoConversionWindow-time.Hour), 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(between) != 0 {
		t.Fatalf("between the two moments %d evaluations were due, want 0", len(between))
	}

	closed, err := stageTwoWorkerAt(repo, classifier,
		fixture.FirstIngested.Add(DefaultStageTwoConversionWindow)).
		EvaluateTenantOnce(ctx, fixture.TenantID)
	if err != nil {
		t.Fatalf("conversion-window pass: %v", err)
	}
	if closed.Due != 1 || closed.Evaluated != 1 || closed.EventsSuperseded != 9 {
		t.Fatalf("conversion-window pass = %+v, want due=1 evaluated=1 superseded=9", closed)
	}

	lineage := stageTwoVerdicts(t, ctx, admin, fixture.TenantID, fixture.Opens[0])
	if len(lineage) != 3 {
		t.Fatalf("verdict lineage = %d rows, want 3 (stage one, delayed, window close)", len(lineage))
	}
	windowVersion, err := stageTwoMethodologyVersion(MethodologyV2, StageTwoConversionWindowClose)
	if err != nil {
		t.Fatal(err)
	}
	if lineage[2].MethodologyVersion != windowVersion {
		t.Fatalf("newest verdict methodology = %q, want %q", lineage[2].MethodologyVersion, windowVersion)
	}
	// The chain is unbroken: window close supersedes the delayed verdict, which
	// supersedes the original.
	if lineage[2].Supersedes != lineage[1].ID || lineage[1].Supersedes != lineage[0].ID {
		t.Fatalf("supersedes chain is broken: %+v", lineage)
	}
	var state string
	var evaluated, superseded int64
	if err := admin.QueryRow(ctx, `
SELECT state, evaluated_event_count, superseded_count
  FROM engagement_stage_two_evaluations
 WHERE tenant_id = $1::uuid AND message_identity_hash = $2
   AND stage = 'conversion_window_close'`,
		fixture.TenantID, fixture.MessageHash).Scan(&state, &evaluated, &superseded); err != nil {
		t.Fatal(err)
	}
	if state != "completed" || evaluated != 9 || superseded != 9 {
		t.Fatalf("window-close schedule state=%q evaluated=%d superseded=%d", state, evaluated, superseded)
	}
}

// ---------------------------------------------------------------------------
// 4. The lease.
// ---------------------------------------------------------------------------

func TestStageTwoRefusesToEvaluateAMessageAnotherWorkerHasLeased(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedStageTwoFixture(t, ctx, admin, 8, 200*time.Millisecond)
	repo := stageTwoRepo(t, app, "stage-two-owner")
	classifier := stageTwoBootstrapClassifier(t, ctx, repo)
	stageTwoIngestAll(t, ctx, repo, classifier, fixture)
	beforeCount := stageTwoClassificationCount(t, ctx, admin, fixture.TenantID)

	evaluation := StageTwoEvaluation{
		TenantID: fixture.TenantID, MessageIdentityHash: fixture.MessageHash,
		Stage: StageTwoDelayed, FirstEventAt: fixture.FirstIngested,
		DueAt: fixture.FirstIngested.Add(StageTwoDelay), State: "pending",
	}
	// A rival worker takes the lease for exactly this message and stage, and
	// keeps it: it never completes the run.
	rival := stageTwoRepo(t, app, "stage-two-rival")
	rivalClassifier, err := stageTwoClassifier(classifier, StageTwoDelayed)
	if err != nil {
		t.Fatal(err)
	}
	rivalRun, err := rival.claimStageTwoRun(ctx, evaluation, rivalClassifier)
	if err != nil {
		t.Fatalf("rival lease claim: %v", err)
	}
	if rivalRun.State != "running" || rivalRun.WorkerID != "stage-two-rival" {
		t.Fatalf("rival run = %+v, want a live running lease", rivalRun)
	}

	worker := stageTwoWorkerAt(repo, classifier, fixture.FirstIngested.Add(StageTwoDelay))
	result, err := worker.EvaluateTenantOnce(ctx, fixture.TenantID)
	if err != nil {
		t.Fatalf("leased stage two sweep: %v", err)
	}
	if result.Due != 1 || result.Evaluated != 0 || result.LeaseHeldElsewhere != 1 {
		t.Fatalf("leased sweep = %+v, want due=1 evaluated=0 lease_held_elsewhere=1", result)
	}
	if got := stageTwoClassificationCount(t, ctx, admin, fixture.TenantID); got != beforeCount {
		t.Fatalf("a second worker appended %d verdicts while the lease was held elsewhere", got-beforeCount)
	}
	// One run row, not one per worker. A per-worker run id would give every
	// worker a private lease and the mutual exclusion would be decorative.
	var runs int
	if err := admin.QueryRow(ctx, `
SELECT count(*) FROM event_reclassification_runs WHERE tenant_id = $1::uuid`,
		fixture.TenantID).Scan(&runs); err != nil {
		t.Fatal(err)
	}
	if runs != 1 {
		t.Fatalf("reclassification runs for one message and stage = %d, want 1", runs)
	}
	// The schedule row stays pending; the lease holder, or its successor after
	// the lease expires, still owes the evaluation.
	var state string
	if err := admin.QueryRow(ctx, `
SELECT state FROM engagement_stage_two_evaluations
 WHERE tenant_id = $1::uuid AND message_identity_hash = $2 AND stage = 'delayed'`,
		fixture.TenantID, fixture.MessageHash).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "pending" {
		t.Fatalf("schedule state = %q while the lease was held elsewhere, want pending", state)
	}
}

func TestStageTwoConcurrentWorkersEvaluateAMessageExactlyOnce(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedStageTwoFixture(t, ctx, admin, 8, 200*time.Millisecond)
	repo := stageTwoRepo(t, app, "stage-two-seed")
	classifier := stageTwoBootstrapClassifier(t, ctx, repo)
	stageTwoIngestAll(t, ctx, repo, classifier, fixture)
	beforeCount := stageTwoClassificationCount(t, ctx, admin, fixture.TenantID)

	const workers = 6
	start := make(chan struct{})
	results := make(chan StageTwoResult, workers)
	failures := make(chan error, workers)
	var wait sync.WaitGroup
	for index := 0; index < workers; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			worker := stageTwoWorkerAt(
				stageTwoRepo(t, app, fmt.Sprintf("stage-two-racer-%d", index)),
				classifier, fixture.FirstIngested.Add(StageTwoDelay),
			)
			<-start
			result, err := worker.EvaluateTenantOnce(ctx, fixture.TenantID)
			if err != nil {
				failures <- err
				return
			}
			results <- result
		}(index)
	}
	close(start)
	wait.Wait()
	close(results)
	close(failures)
	for err := range failures {
		t.Fatalf("concurrent stage two worker: %v", err)
	}
	total := StageTwoResult{}
	for result := range results {
		total.add(result)
	}
	if total.Evaluated != 1 {
		t.Fatalf("%d of %d concurrent workers evaluated the message; exactly one may", total.Evaluated, workers)
	}
	if total.Evaluated+total.AlreadyEvaluated+total.LeaseHeldElsewhere != total.Due {
		t.Fatalf("concurrent outcome does not account for every due evaluation: %+v", total)
	}
	if got := stageTwoClassificationCount(t, ctx, admin, fixture.TenantID); got != beforeCount+9 {
		t.Fatalf("concurrent stage two appended %d verdicts, want exactly 9", got-beforeCount)
	}
	var runs int
	if err := admin.QueryRow(ctx, `
SELECT count(*) FROM event_reclassification_runs WHERE tenant_id = $1::uuid`,
		fixture.TenantID).Scan(&runs); err != nil {
		t.Fatal(err)
	}
	if runs != 1 {
		t.Fatalf("%d reclassification runs for one contended message, want 1", runs)
	}
}

// ---------------------------------------------------------------------------
// 5. A crashed pass replays without duplicating a verdict.
// ---------------------------------------------------------------------------

func TestStageTwoInterruptedPassReplaysWithoutDuplicatingVerdicts(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedStageTwoFixture(t, ctx, admin, 8, 200*time.Millisecond)
	ingestRepo := stageTwoRepo(t, app, "stage-two-crash-ingest")
	classifier := stageTwoBootstrapClassifier(t, ctx, ingestRepo)
	stageTwoIngestAll(t, ctx, ingestRepo, classifier, fixture)
	beforeCount := stageTwoClassificationCount(t, ctx, admin, fixture.TenantID)

	evaluation := StageTwoEvaluation{
		TenantID: fixture.TenantID, MessageIdentityHash: fixture.MessageHash,
		Stage: StageTwoDelayed, FirstEventAt: fixture.FirstIngested,
		DueAt: fixture.FirstIngested.Add(StageTwoDelay), State: "pending",
	}
	stageClassifier, err := stageTwoClassifier(classifier, StageTwoDelayed)
	if err != nil {
		t.Fatal(err)
	}

	// A worker with a deliberately short lease classifies part of the message
	// and then dies without completing its run.
	dying := &Repo{
		Pool: (*db.Pool)(app), ReclassificationWorkerID: "stage-two-dying",
		ReclassificationLeaseTTL: 250 * time.Millisecond,
	}
	run, err := dying.claimStageTwoRun(ctx, evaluation, stageClassifier)
	if err != nil {
		t.Fatalf("dying worker claim: %v", err)
	}
	lease := leaseFromRun(run, dying.reclassificationLeaseTTL())
	partial := []EventRef{fixture.Opens[0], fixture.Opens[1], fixture.Opens[2]}
	for _, event := range partial {
		if _, err := dying.reclassifyEvent(ctx, fixture.TenantID, event, stageClassifier, lease); err != nil {
			t.Fatalf("partial stage two pass: %v", err)
		}
	}
	interrupted := stageTwoClassificationCount(t, ctx, admin, fixture.TenantID)
	if interrupted != beforeCount+len(partial) {
		t.Fatalf("partial pass wrote %d verdicts, want %d", interrupted-beforeCount, len(partial))
	}

	// Its lease expires.
	time.Sleep(700 * time.Millisecond)

	successor := stageTwoRepo(t, app, "stage-two-successor")
	worker := stageTwoWorkerAt(successor, classifier, fixture.FirstIngested.Add(StageTwoDelay))
	result, err := worker.EvaluateTenantOnce(ctx, fixture.TenantID)
	if err != nil {
		t.Fatalf("successor stage two sweep: %v", err)
	}
	if result.Evaluated != 1 {
		t.Fatalf("successor sweep = %+v, want the interrupted evaluation completed", result)
	}
	// Nine events, nine stage-two verdicts in total — the three the dying worker
	// already wrote are recognised as its own durable work, not rewritten and
	// not duplicated.
	if got := stageTwoClassificationCount(t, ctx, admin, fixture.TenantID); got != beforeCount+9 {
		t.Fatalf("after replay the message has %d stage two verdicts, want 9", got-beforeCount)
	}
	for index, event := range append([]EventRef{fixture.Delivered}, fixture.Opens...) {
		lineage := stageTwoVerdicts(t, ctx, admin, fixture.TenantID, event)
		if len(lineage) != 2 {
			t.Fatalf("event %d has %d verdicts after the replayed pass, want 2", index, len(lineage))
		}
		if lineage[1].Supersedes != lineage[0].ID {
			t.Fatalf("event %d lost its supersedes lineage: %+v", index, lineage)
		}
	}
	var runs int
	if err := admin.QueryRow(ctx, `
SELECT count(*) FROM event_reclassification_runs WHERE tenant_id = $1::uuid`,
		fixture.TenantID).Scan(&runs); err != nil {
		t.Fatal(err)
	}
	if runs != 1 {
		t.Fatalf("the replayed pass created %d runs, want the same one reclaimed", runs)
	}
}

// ---------------------------------------------------------------------------
// 6. The schedule is tenant-scoped evidence, not open state.
// ---------------------------------------------------------------------------

func TestStageTwoScheduleIsTenantIsolatedAndWorkerScoped(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedStageTwoFixture(t, ctx, admin, 2, time.Second)
	repo := stageTwoRepo(t, app, "stage-two-rls")
	classifier := stageTwoBootstrapClassifier(t, ctx, repo)
	stageTwoIngestAll(t, ctx, repo, classifier, fixture)

	var seeded int
	if err := admin.QueryRow(ctx, `
SELECT count(*) FROM engagement_stage_two_evaluations WHERE tenant_id = $1::uuid`,
		fixture.TenantID).Scan(&seeded); err != nil {
		t.Fatal(err)
	}
	if seeded != 2 {
		t.Fatalf("seeded schedule rows = %d, want 2; the isolation assertions below would be vacuous", seeded)
	}

	// A plain tenant session — no worker scope — sees nothing and may not arm
	// an evaluation of its own.
	tenantTx, err := db.WithTenant(ctx, (*db.Pool)(app), fixture.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	var visible int
	if err := tenantTx.QueryRow(ctx,
		`SELECT count(*) FROM engagement_stage_two_evaluations`).Scan(&visible); err != nil {
		t.Fatal(err)
	}
	if visible != 0 {
		t.Fatalf("a plain tenant session can read %d stage two schedule rows", visible)
	}
	_, err = tenantTx.Exec(ctx, `
INSERT INTO engagement_stage_two_evaluations (
    tenant_id, message_identity_hash, stage, first_event_at, due_at
) VALUES ($1::uuid, $2, 'delayed', now(), now() + interval '1 minute')`,
		fixture.TenantID, repeat("c", 64))
	if classifierSQLState(err) != "42501" {
		t.Fatalf("plain tenant schedule insert error=%v state=%q, want 42501", err, classifierSQLState(err))
	}
	_ = tenantTx.Rollback(ctx)

	// Another tenant's worker sees nothing either, and its due query is empty.
	foreignTx, err := db.WithTenantWorker(ctx, (*db.Pool)(app), fixture.ForeignTenantID)
	if err != nil {
		t.Fatal(err)
	}
	if err := bindClassifierScope(ctx, foreignTx); err != nil {
		t.Fatal(err)
	}
	var foreignVisible int
	if err := foreignTx.QueryRow(ctx,
		`SELECT count(*) FROM engagement_stage_two_evaluations`).Scan(&foreignVisible); err != nil {
		t.Fatal(err)
	}
	_ = foreignTx.Rollback(ctx)
	if foreignVisible != 0 {
		t.Fatalf("a foreign tenant worker can read %d stage two schedule rows", foreignVisible)
	}
	foreignDue, err := repo.DueStageTwoEvaluations(ctx, fixture.ForeignTenantID,
		fixture.FirstIngested.Add(DefaultStageTwoConversionWindow), 50)
	if err != nil {
		t.Fatalf("foreign due query: %v", err)
	}
	if len(foreignDue) != 0 {
		t.Fatalf("foreign tenant drained %d of another tenant's evaluations", len(foreignDue))
	}

	// Deleting scheduling evidence is refused outright.
	workerTx, err := db.WithTenantWorker(ctx, (*db.Pool)(app), fixture.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	if err := bindClassifierScope(ctx, workerTx); err != nil {
		t.Fatal(err)
	}
	_, err = workerTx.Exec(ctx,
		`DELETE FROM engagement_stage_two_evaluations WHERE tenant_id = $1::uuid`,
		fixture.TenantID)
	_ = workerTx.Rollback(ctx)
	if state := classifierSQLState(err); state != "42501" && state != "55000" {
		t.Fatalf("stage two schedule delete error=%v state=%q, want a refusal", err, state)
	}
}

func TestStageTwoIsNotScheduledWithoutAMessageIdentity(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedStageTwoFixture(t, ctx, admin, 2, time.Second)
	repo := stageTwoRepo(t, app, "stage-two-anonymous")
	classifier := stageTwoBootstrapClassifier(t, ctx, repo)

	anonymous := stageTwoObservation(fixture, fixture.Opens[0], "anonymous")
	anonymous.MessageIdentityHash = ""
	stageTwoIngest(t, ctx, repo, classifier, fixture.TenantID, anonymous)

	var scheduled int
	if err := admin.QueryRow(ctx, `
SELECT count(*) FROM engagement_stage_two_evaluations WHERE tenant_id = $1::uuid`,
		fixture.TenantID).Scan(&scheduled); err != nil {
		t.Fatal(err)
	}
	// Without a message identity there is no aggregate to widen; a delayed pass
	// would re-read the single row it already classified.
	if scheduled != 0 {
		t.Fatalf("an observation with no message identity armed %d evaluations", scheduled)
	}

	identified := stageTwoObservation(fixture, fixture.Opens[1], "identified")
	stageTwoIngest(t, ctx, repo, classifier, fixture.TenantID, identified)
	if err := admin.QueryRow(ctx, `
SELECT count(*) FROM engagement_stage_two_evaluations WHERE tenant_id = $1::uuid`,
		fixture.TenantID).Scan(&scheduled); err != nil {
		t.Fatal(err)
	}
	if scheduled != 2 {
		t.Fatalf("an identified observation armed %d evaluations, want 2", scheduled)
	}
}

func TestStageTwoEvaluateMessageRefusesAnUnscheduledMessage(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedStageTwoFixture(t, ctx, admin, 2, time.Second)
	repo := stageTwoRepo(t, app, "stage-two-ondemand")
	classifier := stageTwoBootstrapClassifier(t, ctx, repo)
	stageTwoIngestAll(t, ctx, repo, classifier, fixture)

	worker := stageTwoWorkerAt(repo, classifier, fixture.FirstIngested.Add(StageTwoDelay))
	if _, err := worker.EvaluateMessage(ctx, fixture.TenantID, repeat("d", 64), StageTwoDelayed); !errors.Is(err, ErrStageTwoNotScheduled) {
		t.Fatalf("unscheduled message error = %v, want ErrStageTwoNotScheduled", err)
	}
	// A scheduled but not-yet-due message is equally refused: the delay is not
	// optional just because a caller asked directly.
	early := stageTwoWorkerAt(repo, classifier, fixture.FirstIngested)
	if _, err := early.EvaluateMessage(ctx, fixture.TenantID, fixture.MessageHash, StageTwoDelayed); !errors.Is(err, ErrStageTwoNotScheduled) {
		t.Fatalf("early on-demand evaluation error = %v, want ErrStageTwoNotScheduled", err)
	}
	result, err := worker.EvaluateMessage(ctx, fixture.TenantID, fixture.MessageHash, StageTwoDelayed)
	if err != nil || result.Evaluated != 1 {
		t.Fatalf("on-demand evaluation = %+v err=%v", result, err)
	}
}
