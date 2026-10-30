// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ---------------------------------------------------------------------------
// Fixtures: several MESSAGES inside one tenant.
//
// The head-of-line story cannot be told with one message. DueStageTwoEvaluations
// orders by due_at, so "the oldest pending row is examined first, and first
// again on every later sweep" only becomes observable when there is something
// standing behind it.
// ---------------------------------------------------------------------------

type stageTwoMessage struct {
	Hash         string
	Events       []EventRef
	FirstEventAt time.Time
}

func seedStageTwoMessage(
	t *testing.T,
	ctx context.Context,
	admin *pgxpool.Pool,
	fixture stageTwoFixture,
	label string,
	base time.Time,
	openCount int,
	spacing time.Duration,
) stageTwoMessage {
	t.Helper()
	if openCount < 1 {
		t.Fatalf("seedStageTwoMessage(%s) needs at least one event", label)
	}
	digest := sha256.Sum256([]byte("stage-two-message-" + label + "-" + fixture.Suffix))
	message := stageTwoMessage{Hash: hex.EncodeToString(digest[:])}
	for index := 0; index < openCount; index++ {
		at := base.Add(time.Duration(index) * spacing).UTC().Truncate(time.Microsecond)
		var event EventRef
		if err := admin.QueryRow(ctx, `
INSERT INTO subscriber_events (
    tenant_id, subscriber_email, event_type, campaign_id, source,
    provider_event_id, source_event_id, message_id, metadata, at
) VALUES (
    $1::uuid, $2, 'opened', $3::uuid, 'f01-stage-two', $4, $4, $5, '{}'::jsonb, $6
)
RETURNING id, at`, fixture.TenantID,
			fmt.Sprintf("s2-%s@example.test", fixture.Suffix), fixture.CampaignID,
			fmt.Sprintf("s2-%s-%s-%d", fixture.Suffix, label, index),
			fmt.Sprintf("<s2-%s-%s@example.test>", fixture.Suffix, label), at,
		).Scan(&event.ID, &event.At); err != nil {
			t.Fatalf("seed stage two message %s event %d: %v", label, index, err)
		}
		message.Events = append(message.Events, event)
	}
	message.FirstEventAt = message.Events[0].At
	return message
}

func stageTwoIngestMessage(
	t *testing.T,
	ctx context.Context,
	repo *Repo,
	classifier *Classifier,
	fixture stageTwoFixture,
	message stageTwoMessage,
	label string,
) {
	t.Helper()
	for index, event := range message.Events {
		observation := stageTwoObservation(fixture, event, fmt.Sprintf("%s-%d", label, index))
		observation.MessageIdentityHash = message.Hash
		stageTwoIngest(t, ctx, repo, classifier, fixture.TenantID, observation)
	}
}

// floodEventObservations replays one canonical event under many idempotency
// keys until it crosses loadEventEvidence's 256-observation ceiling.
//
// This is the permanently unclassifiable message, and it is a real shape rather
// than an injected fault: a provider that re-delivers the same webhook under a
// fresh key each time produces exactly it. Every reclassification of that event
// — Stage 2's included — refuses the evidence, so the message can never settle
// on its own.
//
// Written straight through the admin pool on purpose. Re-ingesting through
// IngestHook would re-run STAGE ONE against a message aggregate that each write
// changes, and a changed verdict under an unchanged classifier identity is an
// idempotency conflict at ingest, which is a different failure from the one this
// fixture is for.
func floodEventObservations(
	t *testing.T,
	ctx context.Context,
	admin *pgxpool.Pool,
	tenantID string,
	event EventRef,
	replays int,
) {
	t.Helper()
	tag, err := admin.Exec(ctx, `
INSERT INTO subscriber_event_observations (
    tenant_id, subscriber_event_id, subscriber_event_at, source, source_event_id,
    idempotency_key, event_schema_version, event_type, occurred_at, ingested_at,
    delivered_at, campaign_id, recipient_identity_hmac, recipient_key_id,
    message_identity_hash, link_identity_hash, is_seed, seed_test_id,
    provider_message_id, provider_request_id, ordered_headers,
    ordered_headers_complete, user_agent, ip_address, network_asn,
    network_region, reverse_dns, tls_ja4, provider_signals, dwell_milliseconds,
    message_link_count, body_hash, privacy_expiry_at, observation_fingerprint
)
SELECT o.tenant_id, o.subscriber_event_id, o.subscriber_event_at, o.source,
       o.source_event_id, o.idempotency_key || '-replay-' || g,
       o.event_schema_version, o.event_type, o.occurred_at, o.ingested_at,
       o.delivered_at, o.campaign_id, o.recipient_identity_hmac, o.recipient_key_id,
       o.message_identity_hash, o.link_identity_hash, o.is_seed, o.seed_test_id,
       o.provider_message_id, o.provider_request_id, o.ordered_headers,
       o.ordered_headers_complete, o.user_agent, o.ip_address, o.network_asn,
       o.network_region, o.reverse_dns, o.tls_ja4, o.provider_signals,
       o.dwell_milliseconds, o.message_link_count, o.body_hash,
       o.privacy_expiry_at,
       encode(sha256(('replay-' || g || '-' || o.id::text)::bytea), 'hex')
  FROM subscriber_event_observations o, generate_series(1, $4) g
 WHERE o.tenant_id = $1::uuid
   AND o.subscriber_event_id = $2 AND o.subscriber_event_at = $3`,
		tenantID, event.ID, event.At, replays)
	if err != nil {
		t.Fatalf("flood event observations: %v", err)
	}
	if tag.RowsAffected() != int64(replays) {
		t.Fatalf("flood wrote %d observations, want %d", tag.RowsAffected(), replays)
	}
	var total int
	if err := admin.QueryRow(ctx, `
SELECT count(*) FROM subscriber_event_observations
 WHERE tenant_id = $1::uuid AND subscriber_event_id = $2 AND subscriber_event_at = $3`,
		tenantID, event.ID, event.At).Scan(&total); err != nil {
		t.Fatal(err)
	}
	// The ceiling loadEventEvidence enforces. Below it this fixture is a
	// perfectly classifiable message and every assertion built on it is vacuous.
	if total <= 256 {
		t.Fatalf("flooded event carries %d observations, want more than 256", total)
	}
}

type stageTwoScheduleRow struct {
	State     string
	ErrorCode string
	Evaluated int64
	Completed bool
	RunID     string
}

func readStageTwoSchedule(
	t *testing.T,
	ctx context.Context,
	admin *pgxpool.Pool,
	tenantID, messageHash string,
	stage StageTwoStage,
) stageTwoScheduleRow {
	t.Helper()
	var row stageTwoScheduleRow
	if err := admin.QueryRow(ctx, `
SELECT state, COALESCE(error_code, ''), evaluated_event_count,
       completed_at IS NOT NULL, COALESCE(run_id::text, '')
  FROM engagement_stage_two_evaluations
 WHERE tenant_id = $1::uuid AND message_identity_hash = $2 AND stage = $3`,
		tenantID, messageHash, string(stage)).Scan(&row.State, &row.ErrorCode,
		&row.Evaluated, &row.Completed, &row.RunID); err != nil {
		t.Fatalf("read stage two schedule row (%s/%s): %v", messageHash, stage, err)
	}
	return row
}

func readReclassificationRunState(
	t *testing.T,
	ctx context.Context,
	admin *pgxpool.Pool,
	tenantID, runID string,
) (string, string, int64) {
	t.Helper()
	var state, errorCode string
	var errorCount int64
	if err := admin.QueryRow(ctx, `
SELECT state, COALESCE(error_code, ''), error_count
  FROM event_reclassification_runs
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, runID).
		Scan(&state, &errorCode, &errorCount); err != nil {
		t.Fatalf("read reclassification run %s: %v", runID, err)
	}
	return state, errorCode, errorCount
}

// ---------------------------------------------------------------------------
// DEFECT 1. One poisoned message may not starve the tenant's queue.
// ---------------------------------------------------------------------------

// TestStageTwoPoisonedMessagesDoNotStarveTheTenantQueue_DB seeds two failing
// messages AHEAD of a healthy one and proves the healthy one is still evaluated
// in the same pass.
//
// Both poisons are real, durable shapes rather than injected faults:
//
//   - HEAD: a message whose existing run records a different request hash than
//     this evaluation computes. Nothing about it is transient: the run row is
//     immutable and due_at never moves, so before the fix the message stayed
//     pending and stayed FIRST. (Two divergences between the run id and the
//     request hash used to REACH this state through ordinary application paths —
//     a classifier reconfiguration, and a schedule row re-armed after retention
//     reaped it. Both are closed; stageTwoRunRequestID now covers everything
//     reclassificationRequestHash covers. The state itself is still reachable
//     across a deploy that changes the hash derivation alone, so the branch still
//     has to survive it, and the poison below writes it directly.)
//
//   - MIDDLE: a message one of whose events carries more than 256 observations,
//     which loadEventEvidence refuses outright. Every attempt to reclassify it
//     fails the same way.
//
// Before the fix the drain returned at the first error, and because the due
// query is ordered by due_at the same row was re-presented first on every later
// sweep. One message therefore parked the whole tenant — silently, and with the
// backlog behind it growing.
func TestStageTwoPoisonedMessagesDoNotStarveTheTenantQueue_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)

	// The fixture's own message is the HEAD: it has the earliest first event.
	fixture := seedStageTwoFixture(t, ctx, admin, 3, 200*time.Millisecond)
	repo := stageTwoRepo(t, app, "stage-two-headline")
	classifier := stageTwoBootstrapClassifier(t, ctx, repo)
	stageTwoIngestAll(t, ctx, repo, classifier, fixture)

	overflowing := seedStageTwoMessage(t, ctx, admin, fixture, "overflowing",
		fixture.FirstIngested.Add(5*time.Minute), 3, 200*time.Millisecond)
	stageTwoIngestMessage(t, ctx, repo, classifier, fixture, overflowing, "overflowing")
	healthy := seedStageTwoMessage(t, ctx, admin, fixture, "healthy",
		fixture.FirstIngested.Add(10*time.Minute), 3, 200*time.Millisecond)
	stageTwoIngestMessage(t, ctx, repo, classifier, fixture, healthy, "healthy")

	stageClassifier, err := stageTwoClassifier(classifier, StageTwoDelayed)
	if err != nil {
		t.Fatal(err)
	}

	// Poison the HEAD: a run stored under exactly the request id this evaluation
	// will derive, carrying a request hash this evaluation cannot reproduce.
	//
	// stageTwoRunRequestID and reclassificationRequestHash now cover the same
	// material — tenant, message, stage, window, classifier identity — so no
	// application path can produce this divergence any more; a re-armed window
	// and a re-configured classifier each ask for their own run. What remains
	// reachable is a run written by a build whose request-hash DERIVATION
	// differed, which is exactly what a rolling deploy that edits
	// reclassificationRequestHash's payload without touching the id produces.
	// The conflict branch is the safety net for that, so it is poisoned here at
	// the row level rather than through an application call that can no longer
	// reach it.
	head := readStageTwoWindow(t, ctx, admin, fixture.TenantID,
		fixture.MessageHash, StageTwoDelayed)
	headRequestID := stageTwoRunRequestID(fixture.TenantID, fixture.MessageHash,
		StageTwoDelayed, head.FirstEventAt, head.DueAt, stageClassifier)
	staleHash, err := reclassificationRequestHash(ReclassificationWindow{
		Start: head.FirstEventAt, End: head.DueAt.Add(time.Hour),
	}, stageClassifier)
	if err != nil {
		t.Fatal(err)
	}
	liveHash, err := reclassificationRequestHash(ReclassificationWindow{
		Start: head.FirstEventAt, End: head.DueAt,
	}, stageClassifier)
	if err != nil {
		t.Fatal(err)
	}
	if staleHash == liveHash {
		t.Fatal("the poison hash matches the one the sweep derives; there would be no conflict to survive")
	}
	if _, err := admin.Exec(ctx, `
INSERT INTO event_reclassification_runs (
    tenant_id, request_id, request_hash, event_window_start, event_window_end,
    classifier_version, methodology_version, registry_version, configuration_hash
) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9)`,
		fixture.TenantID, headRequestID, staleHash, head.FirstEventAt, head.DueAt,
		stageClassifier.Config().ClassifierVersion,
		stageClassifier.Config().MethodologyVersion,
		stageClassifier.Config().RegistryVersion,
		stageClassifier.ConfigurationHash()); err != nil {
		t.Fatalf("seed conflicting run: %v", err)
	}

	// Poison the MIDDLE.
	floodEventObservations(t, ctx, admin, fixture.TenantID, overflowing.Events[0], 300)

	evaluateAt := healthy.FirstEventAt.Add(StageTwoDelay)

	// The premise: all three are due, and the two poisoned ones really are
	// AHEAD of the healthy one in the order the drain uses. Without this the
	// assertions below would prove nothing about head-of-line blocking.
	due, err := repo.DueStageTwoEvaluations(ctx, fixture.TenantID, evaluateAt, 50)
	if err != nil {
		t.Fatalf("due query: %v", err)
	}
	if len(due) != 3 {
		t.Fatalf("due evaluations = %d, want 3 (one delayed row per message); got %+v", len(due), due)
	}
	wantOrder := []string{fixture.MessageHash, overflowing.Hash, healthy.Hash}
	for index, want := range wantOrder {
		if due[index].MessageIdentityHash != want || due[index].Stage != StageTwoDelayed {
			t.Fatalf("due[%d] = %s/%s, want %s/delayed", index,
				due[index].MessageIdentityHash, due[index].Stage, want)
		}
	}

	worker := stageTwoWorkerAt(repo, classifier, evaluateAt)
	result, err := worker.EvaluateTenantOnce(ctx, fixture.TenantID)

	// The unclassifiable message's failure is REPORTED — it is not swallowed —
	// but it is reported after the page rather than instead of it.
	if err == nil {
		t.Fatal("an unclassifiable message reported success; its failure must stay visible")
	}
	if result.Due != 3 {
		t.Fatalf("result = %+v, want due=3; the drain stopped short of the page", result)
	}
	if result.Evaluated != 1 {
		t.Fatalf("result = %+v, want exactly the healthy message evaluated; a poisoned message starved the queue behind it", result)
	}
	if result.Failed != 2 {
		t.Fatalf("result = %+v, want failed=2 (the two poisoned messages)", result)
	}
	if !strings.Contains(err.Error(), overflowing.Hash) {
		t.Fatalf("sweep error does not name the failing message: %v", err)
	}

	// The healthy message did real work, not merely a counter increment.
	healthySchedule := readStageTwoSchedule(t, ctx, admin, fixture.TenantID, healthy.Hash, StageTwoDelayed)
	if healthySchedule.State != "completed" || healthySchedule.RunID == "" ||
		healthySchedule.Evaluated != int64(len(healthy.Events)) {
		t.Fatalf("healthy schedule row = %+v, want completed over %d events",
			healthySchedule, len(healthy.Events))
	}
	lineage := stageTwoVerdicts(t, ctx, admin, fixture.TenantID, healthy.Events[0])
	if len(lineage) != 2 || lineage[1].Supersedes != lineage[0].ID {
		t.Fatalf("healthy message verdict lineage = %+v, want stage one superseded by stage two", lineage)
	}

	// The conflicted message is now TERMINAL rather than pending forever.
	conflictedSchedule := readStageTwoSchedule(t, ctx, admin, fixture.TenantID,
		fixture.MessageHash, StageTwoDelayed)
	if conflictedSchedule.State != "failed" ||
		conflictedSchedule.ErrorCode != "reclassification_request_conflict" ||
		!conflictedSchedule.Completed {
		t.Fatalf("conflicted schedule row = %+v, want failed/reclassification_request_conflict",
			conflictedSchedule)
	}
	// So is the unclassifiable one, through the abandon path.
	overflowSchedule := readStageTwoSchedule(t, ctx, admin, fixture.TenantID,
		overflowing.Hash, StageTwoDelayed)
	if overflowSchedule.State != "failed" || overflowSchedule.ErrorCode != "classification_failed" {
		t.Fatalf("unclassifiable schedule row = %+v, want failed/classification_failed", overflowSchedule)
	}

	// Nothing is left at the head. The queue drained rather than jamming.
	after, err := repo.DueStageTwoEvaluations(ctx, fixture.TenantID, evaluateAt, 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, evaluation := range after {
		if evaluation.Stage == StageTwoDelayed {
			t.Fatalf("a delayed evaluation is still queued after the pass: %+v", evaluation)
		}
	}
}

// TestStageTwoSweepDoesNotStarveTenantsBehindAFailingTenant_DB is the same
// invariant one level up: tenants are visited in a stable id order, so aborting
// the sweep at the first failing tenant parks every tenant that sorts after it.
func TestStageTwoSweepDoesNotStarveTenantsBehindAFailingTenant_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)

	// The two tenants are placed ADJACENT in the sweep's id order rather than
	// drawn at random.
	//
	// SweepOnce pages a bounded number of tenants and this database holds
	// thousands, so two random ids fall in one page only about half the time:
	// with random ids this proof passed or failed on the uuid draw, and it got
	// less likely to pass as the table grew. Two ids differing only in their last
	// nibble cannot have another tenant between them, so the page provably holds
	// both and the sweep provably reaches the healthy one SECOND.
	stem := uuid.NewString()
	poisoned := seedStageTwoFixtureForTenant(t, ctx, admin,
		stem[:len(stem)-1]+"0", 3, 200*time.Millisecond)
	healthy := seedStageTwoFixtureForTenant(t, ctx, admin,
		stem[:len(stem)-1]+"1", 3, 200*time.Millisecond)
	if poisoned.TenantID >= healthy.TenantID {
		t.Fatalf("fixture order is wrong: %s must sort before %s",
			poisoned.TenantID, healthy.TenantID)
	}
	var between int
	if err := admin.QueryRow(ctx, `
SELECT count(*) FROM tenants WHERE id::text > $1 AND id::text < $2`,
		poisoned.TenantID, healthy.TenantID).Scan(&between); err != nil {
		t.Fatal(err)
	}
	if between != 0 {
		t.Fatalf("%d tenants sort between the poisoned and healthy fixtures; the page below would not provably hold both", between)
	}
	repo := stageTwoRepo(t, app, "stage-two-sweep-isolation")
	classifier := stageTwoBootstrapClassifier(t, ctx, repo)
	stageTwoIngestAll(t, ctx, repo, classifier, poisoned)
	stageTwoIngestAll(t, ctx, repo, classifier, healthy)

	floodEventObservations(t, ctx, admin, poisoned.TenantID, poisoned.Opens[0], 300)

	// A tenant page that starts immediately before the poisoned tenant and holds
	// exactly the two of them, so the sweep genuinely reaches the healthy one
	// second and no unrelated fixture in this shared database is drawn in.
	var cursor string
	if err := admin.QueryRow(ctx, `
SELECT COALESCE(max(id::text), '') FROM tenants WHERE id::text < $1`,
		poisoned.TenantID).Scan(&cursor); err != nil {
		t.Fatal(err)
	}
	worker := stageTwoWorkerAt(repo, classifier,
		maxTime(poisoned.FirstIngested, healthy.FirstIngested).Add(StageTwoDelay))
	worker.TenantBatchSize = 2

	result, err := worker.SweepOnce(ctx, cursor)
	if err == nil {
		t.Fatal("the failing tenant reported success; its failure must stay visible")
	}
	if !strings.Contains(err.Error(), poisoned.TenantID) {
		t.Fatalf("sweep error does not name the failing tenant: %v", err)
	}
	if result.TenantCount != 2 {
		t.Fatalf("sweep visited %d tenants, want exactly the poisoned one and the healthy one behind it", result.TenantCount)
	}
	healthySchedule := readStageTwoSchedule(t, ctx, admin,
		healthy.TenantID, healthy.MessageHash, StageTwoDelayed)
	if healthySchedule.State != "completed" {
		t.Fatalf("tenant sorting after a failing tenant was starved: schedule row = %+v", healthySchedule)
	}
	if result.Evaluated < 1 {
		t.Fatalf("sweep result = %+v, want at least the healthy tenant evaluated", result)
	}
}

func maxTime(a, b time.Time) time.Time {
	if b.After(a) {
		return b
	}
	return a
}

// ---------------------------------------------------------------------------
// DEFECT 2. The Stage-2 FAILURE path.
// ---------------------------------------------------------------------------

// TestStageTwoTerminalRunClosesTheScheduleRowAsFailed_DB covers the ErrRunTerminal
// branch and failStageTwoEvaluation together: a message whose run already failed
// must leave a terminal, attributable schedule row rather than a pending one that
// is retried against a run that can never be claimed again.
func TestStageTwoTerminalRunClosesTheScheduleRowAsFailed_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedStageTwoFixture(t, ctx, admin, 3, 200*time.Millisecond)
	repo := stageTwoRepo(t, app, "stage-two-terminal")
	classifier := stageTwoBootstrapClassifier(t, ctx, repo)
	stageTwoIngestAll(t, ctx, repo, classifier, fixture)
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
	run, err := repo.claimStageTwoRun(ctx, evaluation, stageClassifier)
	if err != nil {
		t.Fatalf("claim run: %v", err)
	}
	lease := leaseFromRun(run, repo.reclassificationLeaseTTL())
	cause := errors.New("synthetic run failure")
	if _, err := repo.failReclassificationRun(
		ctx, fixture.TenantID, run, lease, "classification_failed", cause,
	); !errors.Is(err, cause) {
		t.Fatalf("fail run error = %v, want the cause", err)
	}
	if state, _, _ := readReclassificationRunState(t, ctx, admin, fixture.TenantID, run.ID); state != "failed" {
		t.Fatalf("run state = %q, want failed; the premise of this test does not hold", state)
	}

	// Premise: the schedule row is still owed.
	if before := readStageTwoSchedule(t, ctx, admin, fixture.TenantID,
		fixture.MessageHash, StageTwoDelayed); before.State != "pending" {
		t.Fatalf("schedule row before the sweep = %+v, want pending", before)
	}

	worker := stageTwoWorkerAt(repo, classifier, fixture.FirstIngested.Add(StageTwoDelay))
	result, err := worker.EvaluateTenantOnce(ctx, fixture.TenantID)
	if err != nil {
		t.Fatalf("sweep over a terminal run: %v", err)
	}
	if result.Due != 1 || result.Failed != 1 || result.Evaluated != 0 {
		t.Fatalf("sweep result = %+v, want due=1 failed=1 evaluated=0", result)
	}
	after := readStageTwoSchedule(t, ctx, admin, fixture.TenantID, fixture.MessageHash, StageTwoDelayed)
	if after.State != "failed" || after.ErrorCode != "reclassification_run_terminal" || !after.Completed {
		t.Fatalf("schedule row = %+v, want failed/reclassification_run_terminal with a completion stamp", after)
	}
	// A failed evaluation appends nothing.
	if got := stageTwoClassificationCount(t, ctx, admin, fixture.TenantID); got != beforeCount {
		t.Fatalf("a failed stage two evaluation appended %d verdicts", got-beforeCount)
	}
	// And it is out of the queue, not retried against a run that can never be
	// claimed again.
	due, err := repo.DueStageTwoEvaluations(ctx, fixture.TenantID,
		fixture.FirstIngested.Add(StageTwoDelay), 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, evaluation := range due {
		if evaluation.Stage == StageTwoDelayed {
			t.Fatalf("the terminally failed evaluation is still due: %+v", evaluation)
		}
	}
}

// TestStageTwoAbandonMarksBothTheRunAndTheSchedule_DB is the invariant abandon's
// own comment states and nothing enforced: marking only one of the two leaves a
// message permanently due against a run that can never be claimed again.
func TestStageTwoAbandonMarksBothTheRunAndTheSchedule_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedStageTwoFixture(t, ctx, admin, 3, 200*time.Millisecond)
	repo := stageTwoRepo(t, app, "stage-two-abandon")
	classifier := stageTwoBootstrapClassifier(t, ctx, repo)
	stageTwoIngestAll(t, ctx, repo, classifier, fixture)

	evaluation := StageTwoEvaluation{
		TenantID: fixture.TenantID, MessageIdentityHash: fixture.MessageHash,
		Stage: StageTwoDelayed, FirstEventAt: fixture.FirstIngested,
		DueAt: fixture.FirstIngested.Add(StageTwoDelay), State: "pending",
	}
	stageClassifier, err := stageTwoClassifier(classifier, StageTwoDelayed)
	if err != nil {
		t.Fatal(err)
	}
	run, err := repo.claimStageTwoRun(ctx, evaluation, stageClassifier)
	if err != nil {
		t.Fatalf("claim run: %v", err)
	}
	if run.State != "running" {
		t.Fatalf("claimed run state = %q, want running; the premise does not hold", run.State)
	}
	if before := readStageTwoSchedule(t, ctx, admin, fixture.TenantID,
		fixture.MessageHash, StageTwoDelayed); before.State != "pending" {
		t.Fatalf("schedule row before abandoning = %+v, want pending", before)
	}
	lease := leaseFromRun(run, repo.reclassificationLeaseTTL())

	worker := stageTwoWorkerAt(repo, classifier, fixture.FirstIngested.Add(StageTwoDelay))
	cause := errors.New("synthetic message load failure")
	err = worker.abandon(ctx, evaluation, run, lease, "message_load_failed", cause)
	if !errors.Is(err, cause) {
		t.Fatalf("abandon error = %v, want the original cause preserved", err)
	}

	runState, runErrorCode, runErrorCount := readReclassificationRunState(
		t, ctx, admin, fixture.TenantID, run.ID)
	if runState != "failed" || runErrorCode != "message_load_failed" || runErrorCount != 1 {
		t.Fatalf("run after abandoning: state=%q error_code=%q error_count=%d, want failed/message_load_failed/1",
			runState, runErrorCode, runErrorCount)
	}
	schedule := readStageTwoSchedule(t, ctx, admin, fixture.TenantID, fixture.MessageHash, StageTwoDelayed)
	if schedule.State != "failed" || schedule.ErrorCode != "message_load_failed" || !schedule.Completed {
		t.Fatalf("schedule row after abandoning = %+v, want failed/message_load_failed", schedule)
	}
	// Neither half may be left behind: a failed run with a pending schedule is a
	// message that is due forever against a run nobody can claim.
	due, err := repo.DueStageTwoEvaluations(ctx, fixture.TenantID,
		fixture.FirstIngested.Add(StageTwoDelay), 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, evaluation := range due {
		if evaluation.Stage == StageTwoDelayed {
			t.Fatalf("abandoned evaluation is still due: %+v", evaluation)
		}
	}
}

// ---------------------------------------------------------------------------
// DEFECT 3. BuildRuntime actually constructs the Stage-2 worker.
// ---------------------------------------------------------------------------

func TestBuildRuntimeConstructsAUsableStageTwoWorker_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	_, app := classifierDBPools(t, ctx)

	configuration := RuntimeConfiguration{
		Enabled:                  true,
		IdentityHMACKey:          []byte(strings.Repeat("stage-two-runtime-key-", 2)),
		IdentityKeyID:            "engagement-hmac-2026-08",
		ObservationRetention:     365 * 24 * time.Hour,
		ReclassificationLeaseTTL: 90 * time.Second,
		ReclassificationWorkerID: "stage-two-runtime-worker",
		RetentionSweepInterval:   30 * time.Second,
		StageTwoSweepInterval:    45 * time.Second,
		StageTwoConversionWindow: 48 * time.Hour,
		StageTwoRetention:        120 * 24 * time.Hour,
	}
	runtime, err := BuildRuntime(ctx, configuration, (*db.Pool)(app))
	if err != nil {
		t.Fatalf("build runtime: %v", err)
	}
	if !runtime.Enabled() {
		t.Fatal("enabled configuration produced a disabled runtime")
	}
	worker := runtime.stageTwoWorker
	if worker == nil {
		t.Fatal("BuildRuntime did not construct the stage two worker; the schedule would never be drained")
	}
	// Constructed is not the same as usable. A worker that fails its own bounds
	// check would return ErrInvalidInput from the first tick and drain nothing.
	if err := worker.validate(); err != nil {
		t.Fatalf("constructed stage two worker is unusable: %v", err)
	}
	if worker.Repo == nil || worker.Repo.Pool == nil || worker.Classifier == nil {
		t.Fatalf("stage two worker is missing its repository or classifier: %+v", worker)
	}
	if worker.Interval != configuration.StageTwoSweepInterval {
		t.Fatalf("stage two sweep cadence = %s, want %s", worker.Interval, configuration.StageTwoSweepInterval)
	}
	// The conversion window lives on the repo the INGEST path shares, because it
	// is what arms the second schedule row.
	if worker.Repo.StageTwoConversionWindow != configuration.StageTwoConversionWindow {
		t.Fatalf("stage two conversion window = %s, want %s",
			worker.Repo.StageTwoConversionWindow, configuration.StageTwoConversionWindow)
	}
	if runtime.retentionWorker == nil ||
		runtime.retentionWorker.StageTwoRetention != configuration.StageTwoRetention {
		t.Fatalf("stage two schedule retention was not wired into the retention worker: %+v",
			runtime.retentionWorker)
	}

	// RunStageTwo must reach that worker rather than refusing.
	logger := slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelError}))
	runCtx, cancelRun := context.WithCancel(ctx)
	cancelRun()
	runErr := runtime.RunStageTwo(runCtx, logger)
	if errors.Is(runErr, ErrRuntimeNotReady) || errors.Is(runErr, ErrRuntimeDisabled) {
		t.Fatalf("RunStageTwo refused on a fully built runtime: %v", runErr)
	}
	if !errors.Is(runErr, context.Canceled) {
		t.Fatalf("RunStageTwo on a cancelled context = %v, want context.Canceled", runErr)
	}

	// The two refusals themselves, so "reached the worker" is a distinguishable
	// outcome rather than the only outcome the code can produce.
	disabled, err := BuildRuntime(ctx, RuntimeConfiguration{}, nil)
	if err != nil {
		t.Fatalf("build disabled runtime: %v", err)
	}
	if err := disabled.RunStageTwo(ctx, logger); !errors.Is(err, ErrRuntimeDisabled) {
		t.Fatalf("disabled RunStageTwo = %v, want ErrRuntimeDisabled", err)
	}
	if err := (&Runtime{enabled: true}).RunStageTwo(ctx, logger); !errors.Is(err, ErrRuntimeNotReady) {
		t.Fatalf("RunStageTwo without a worker = %v, want ErrRuntimeNotReady", err)
	}
}

// ---------------------------------------------------------------------------
// Retention for the Stage-2 schedule.
// ---------------------------------------------------------------------------

func TestStageTwoScheduleRetentionReapsSettledRowsOnly_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedStageTwoFixture(t, ctx, admin, 3, 200*time.Millisecond)
	repo := stageTwoRepo(t, app, "stage-two-retention")
	classifier := stageTwoBootstrapClassifier(t, ctx, repo)
	stageTwoIngestAll(t, ctx, repo, classifier, fixture)

	// Settle the delayed stage; the conversion-window row stays OWED.
	evaluated, err := stageTwoWorkerAt(repo, classifier, fixture.FirstIngested.Add(StageTwoDelay)).
		EvaluateTenantOnce(ctx, fixture.TenantID)
	if err != nil || evaluated.Evaluated != 1 {
		t.Fatalf("delayed pass = %+v err=%v", evaluated, err)
	}
	countSchedule := func() (total, pending int) {
		t.Helper()
		if err := admin.QueryRow(ctx, `
SELECT count(*), count(*) FILTER (WHERE state = 'pending')
  FROM engagement_stage_two_evaluations WHERE tenant_id = $1::uuid`,
			fixture.TenantID).Scan(&total, &pending); err != nil {
			t.Fatalf("count schedule rows: %v", err)
		}
		return total, pending
	}
	if total, pending := countSchedule(); total != 2 || pending != 1 {
		t.Fatalf("schedule before retention: total=%d pending=%d, want 2/1; the assertions below would be vacuous",
			total, pending)
	}

	// Nothing is eligible yet: the rows settled seconds ago.
	fresh, err := repo.PruneStageTwoEvaluationBatch(
		ctx, fixture.TenantID, DefaultStageTwoRetention, 100)
	if err != nil {
		t.Fatalf("prune before retention elapsed: %v", err)
	}
	if fresh != 0 {
		t.Fatalf("retention reaped %d rows that settled seconds ago", fresh)
	}

	// Time passes. The settled row becomes eligible; the owed one never does.
	aged := &Repo{
		Pool: (*db.Pool)(app), ReclassificationWorkerID: "stage-two-retention-aged",
		ReclassificationLeaseTTL: 2 * time.Minute,
		Now: func() time.Time {
			return time.Now().UTC().Add(DefaultStageTwoRetention + 24*time.Hour)
		},
	}
	// Reaping runs inside the tenant's own retention sweep, one bounded tenant
	// page at a time — the cursor here selects exactly this tenant so the sweep
	// cannot touch another test's fixture.
	var cursor string
	if err := admin.QueryRow(ctx, `
SELECT COALESCE(max(id::text), '') FROM tenants WHERE id::text < $1`,
		fixture.TenantID).Scan(&cursor); err != nil {
		t.Fatal(err)
	}
	retention := &RetentionWorker{
		Repo: aged, Interval: time.Minute,
		TenantBatchSize: 1, ObservationBatchSize: 100,
	}
	result, err := retention.SweepOnce(ctx, cursor)
	if err != nil {
		t.Fatalf("retention sweep: %v", err)
	}
	if result.TenantCount != 1 {
		t.Fatalf("retention sweep visited %d tenants, want exactly this one", result.TenantCount)
	}
	if result.StageTwoPruned != 1 {
		t.Fatalf("retention sweep pruned %d stage two schedule rows, want 1", result.StageTwoPruned)
	}
	total, pending := countSchedule()
	if total != 1 || pending != 1 {
		t.Fatalf("schedule after retention: total=%d pending=%d, want the owed row alone", total, pending)
	}
	remaining := readStageTwoSchedule(t, ctx, admin, fixture.TenantID,
		fixture.MessageHash, StageTwoConversionWindowClose)
	if remaining.State != "pending" {
		t.Fatalf("the surviving row = %+v, want the still-owed conversion-window evaluation", remaining)
	}

	// Idempotent: a second sweep has nothing left to reap and still does not
	// touch the owed row.
	second, err := retention.SweepOnce(ctx, cursor)
	if err != nil {
		t.Fatalf("second retention sweep: %v", err)
	}
	if second.StageTwoPruned != 0 {
		t.Fatalf("second retention sweep pruned %d rows, want 0", second.StageTwoPruned)
	}
	if total, pending := countSchedule(); total != 1 || pending != 1 {
		t.Fatalf("second sweep changed the schedule: total=%d pending=%d", total, pending)
	}
}

// TestStageTwoScheduleDeletionIsRefusedBelowTheApplication_DB proves the reap is
// not merely a well-behaved query. RLS filters rather than refuses, so the
// guarantee that an OWED evaluation cannot vanish has to hold at the trigger,
// where even a superuser statement meets it.
func TestStageTwoScheduleDeletionIsRefusedBelowTheApplication_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedStageTwoFixture(t, ctx, admin, 2, time.Second)
	repo := stageTwoRepo(t, app, "stage-two-retention-guard")
	classifier := stageTwoBootstrapClassifier(t, ctx, repo)
	stageTwoIngestAll(t, ctx, repo, classifier, fixture)
	if _, err := stageTwoWorkerAt(repo, classifier, fixture.FirstIngested.Add(StageTwoDelay)).
		EvaluateTenantOnce(ctx, fixture.TenantID); err != nil {
		t.Fatalf("delayed pass: %v", err)
	}

	// Premise: one settled row and one owed row exist.
	var settled, owed int
	if err := admin.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE state <> 'pending'), count(*) FILTER (WHERE state = 'pending')
  FROM engagement_stage_two_evaluations WHERE tenant_id = $1::uuid`,
		fixture.TenantID).Scan(&settled, &owed); err != nil {
		t.Fatal(err)
	}
	if settled != 1 || owed != 1 {
		t.Fatalf("schedule shape settled=%d owed=%d, want 1/1", settled, owed)
	}

	attempt := func(name string, declareRetention bool, stage StageTwoStage) error {
		t.Helper()
		tx, err := admin.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if declareRetention {
			if _, err := tx.Exec(ctx,
				`SELECT set_config('app.engagement_stage_two_retention_worker', 'true', true)`); err != nil {
				t.Fatalf("%s: declare retention worker: %v", name, err)
			}
		}
		_, err = tx.Exec(ctx, `
DELETE FROM engagement_stage_two_evaluations
 WHERE tenant_id = $1::uuid AND stage = $2`, fixture.TenantID, string(stage))
		return err
	}

	// An OWED evaluation may not be deleted even by the declared retention
	// worker: losing it silently cancels a message's conversion-window look.
	if err := attempt("owed row", true, StageTwoConversionWindowClose); classifierSQLState(err) != "55000" {
		t.Fatalf("deleting an owed stage two evaluation error=%v state=%q, want 55000",
			err, classifierSQLState(err))
	}
	// A settled row may not be deleted by anything that has not declared itself
	// the retention worker.
	if err := attempt("undeclared", false, StageTwoDelayed); classifierSQLState(err) != "55000" {
		t.Fatalf("undeclared delete of a settled evaluation error=%v state=%q, want 55000",
			err, classifierSQLState(err))
	}
	// And the one permitted combination really is permitted, or the two
	// refusals above would prove nothing about the guard's precision.
	if err := attempt("declared settled", true, StageTwoDelayed); err != nil {
		t.Fatalf("the retention worker was refused a settled evaluation: %v", err)
	}
}
