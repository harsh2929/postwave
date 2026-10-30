// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// TestStageTwoReArmAfterAReapEvaluatesTheStragglerRatherThanConflicting_DB is
// migration 1967's own documented rationale, executed.
//
// 1967 reaps SETTLED Stage-2 schedule rows and justifies itself with this
// claim: "Re-arming after a reap is safe ... a straggler event for a long-settled
// message re-INSERTs the schedule row ... and re-arms an evaluation".  What the
// comment then asserted — that the deterministic run id finds the already
// completed run and closes the new schedule row from its counters — was false,
// and falsely reassuring in the worst way:
//
//   - scheduleStageTwo sets first_event_at to the OBSERVATION time and due_at to
//     first_event_at + StageTwoDelay, so a re-inserted row carries a NEW WINDOW.
//   - claimStageTwoRun derives the reclassification window from exactly those two
//     columns, and reclassificationRequestHash hashes them.
//   - stageTwoRunRequestID did not cover them.
//
// So the id was stable while the hash moved: createAndClaimRun found the old
// completed run under the same id, saw a different request_hash, and returned
// ErrIdempotencyConflict.  The straggler's evidence never received a Stage-2
// verdict.  Silently — evaluate() turns the conflict into a failed schedule row
// and returns a nil error, so the sweep reports success.  And permanently —
// event_reclassification_runs has no retention path, so the stale run outlives
// every future re-arm and every one of them conflicts again.
//
// This test walks that exact sequence and asserts the straggler is CLASSIFIED.
func TestStageTwoReArmAfterAReapEvaluatesTheStragglerRatherThanConflicting_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)

	// Nine opens are seeded but only eight are ingested now; the ninth is the
	// straggler that arrives after the schedule row has been reaped. Two hundred
	// milliseconds apart keeps the whole message inside BurstWindowMax both
	// before and after the straggler, so the eight original verdicts are
	// genuinely IDENTICAL on re-evaluation. That matters: event_classifications
	// refuses a different result under one identity, so a fixture whose verdicts
	// drifted would fail for an unrelated reason and prove nothing about the run
	// id.
	fixture := seedStageTwoFixture(t, ctx, admin, 9, 200*time.Millisecond)
	straggler := fixture.Opens[len(fixture.Opens)-1]
	repo := stageTwoRepo(t, app, "stage-two-rearm")
	classifier := stageTwoBootstrapClassifier(t, ctx, repo)

	for index, event := range fixture.Opens[:len(fixture.Opens)-1] {
		stageTwoIngest(t, ctx, repo, classifier, fixture.TenantID,
			stageTwoObservation(fixture, event, fmt.Sprintf("open-%d", index)))
	}
	stageTwoIngest(t, ctx, repo, classifier, fixture.TenantID,
		stageTwoObservation(fixture, fixture.Delivered, "delivered"))

	// --- The original delayed evaluation settles. -------------------------
	firstWindow := readStageTwoWindow(t, ctx, admin, fixture.TenantID,
		fixture.MessageHash, StageTwoDelayed)
	firstPass, err := stageTwoWorkerAt(repo, classifier, firstWindow.DueAt).
		EvaluateTenantOnce(ctx, fixture.TenantID)
	if err != nil || firstPass.Evaluated != 1 {
		t.Fatalf("first delayed pass = %+v err=%v, want one evaluation", firstPass, err)
	}
	settled := readStageTwoSchedule(t, ctx, admin, fixture.TenantID,
		fixture.MessageHash, StageTwoDelayed)
	if settled.State != "completed" || settled.RunID == "" {
		t.Fatalf("settled delayed row = %+v, want completed with a run", settled)
	}
	firstRunID := settled.RunID

	// --- Retention reaps the settled row. 1967's premise. ------------------
	aged := &Repo{
		Pool: (*db.Pool)(app), ReclassificationWorkerID: "stage-two-rearm-retention",
		ReclassificationLeaseTTL: 2 * time.Minute,
		Now: func() time.Time {
			return time.Now().UTC().Add(DefaultStageTwoRetention + 24*time.Hour)
		},
	}
	pruned, err := aged.PruneStageTwoEvaluationBatch(
		ctx, fixture.TenantID, DefaultStageTwoRetention, 100)
	if err != nil {
		t.Fatalf("reap settled stage two schedule: %v", err)
	}
	if pruned != 1 {
		t.Fatalf("retention reaped %d rows, want exactly the settled delayed row; "+
			"without the reap there is nothing to re-arm and this test is vacuous", pruned)
	}

	// --- The straggler arrives and re-arms the evaluation. -----------------
	stageTwoIngest(t, ctx, repo, classifier, fixture.TenantID,
		stageTwoObservation(fixture, straggler, "open-straggler"))
	secondWindow := readStageTwoWindow(t, ctx, admin, fixture.TenantID,
		fixture.MessageHash, StageTwoDelayed)
	if secondWindow.State != "pending" {
		t.Fatalf("re-armed delayed row = %q, want pending", secondWindow.State)
	}
	// The premise of the whole defect: the window MOVED. If a future change made
	// scheduleStageTwo preserve the original first_event_at, the assertions below
	// would pass for a reason that has nothing to do with the run id.
	if !secondWindow.FirstEventAt.After(firstWindow.FirstEventAt) ||
		!secondWindow.DueAt.After(firstWindow.DueAt) {
		t.Fatalf("re-armed window %v..%v did not move past %v..%v; the divergence axis this test exercises is gone",
			secondWindow.FirstEventAt, secondWindow.DueAt,
			firstWindow.FirstEventAt, firstWindow.DueAt)
	}

	// --- The re-armed evaluation must actually EVALUATE. -------------------
	secondPass, err := stageTwoWorkerAt(repo, classifier, secondWindow.DueAt).
		EvaluateTenantOnce(ctx, fixture.TenantID)
	if err != nil {
		t.Fatalf("re-armed delayed pass: %v", err)
	}
	if secondPass.Failed != 0 {
		t.Fatalf("re-armed delayed pass failed %d evaluations (result %+v); "+
			"a re-armed window must be a NEW run, not a conflict with the reaped one",
			secondPass.Failed, secondPass)
	}
	if secondPass.Evaluated != 1 {
		t.Fatalf("re-armed delayed pass = %+v, want exactly one evaluation", secondPass)
	}
	rearmed := readStageTwoSchedule(t, ctx, admin, fixture.TenantID,
		fixture.MessageHash, StageTwoDelayed)
	if rearmed.State != "completed" || rearmed.ErrorCode != "" {
		t.Fatalf("re-armed schedule row = %+v, want completed with no error code", rearmed)
	}
	if rearmed.RunID == "" || rearmed.RunID == firstRunID {
		t.Fatalf("re-armed schedule closed against run %q (original %q); a different window deserves its own auditable run",
			rearmed.RunID, firstRunID)
	}

	// --- THE POINT: the straggler's evidence carries a Stage-2 verdict. -----
	stageTwoMethodology, err := stageTwoMethodologyVersion(
		classifier.Config().MethodologyVersion, StageTwoDelayed)
	if err != nil {
		t.Fatal(err)
	}
	verdicts := stageTwoVerdicts(t, ctx, admin, fixture.TenantID, straggler)
	var stageTwoCount int
	for _, verdict := range verdicts {
		if verdict.MethodologyVersion == stageTwoMethodology {
			stageTwoCount++
		}
	}
	if stageTwoCount != 1 {
		t.Fatalf("the straggler carries %d Stage-2 verdicts (lineage %+v), want exactly 1; "+
			"its evidence was never re-evaluated", stageTwoCount, verdicts)
	}

	// The original evidence keeps exactly one Stage-2 verdict each: a new run for
	// a new window must not duplicate verdicts it already appended, and it must
	// not lose the lineage of the reaped run either.
	for index, event := range fixture.Opens[:len(fixture.Opens)-1] {
		var count int
		for _, verdict := range stageTwoVerdicts(t, ctx, admin, fixture.TenantID, event) {
			if verdict.MethodologyVersion == stageTwoMethodology {
				count++
			}
		}
		if count != 1 {
			t.Fatalf("original open %d carries %d Stage-2 verdicts, want exactly 1", index, count)
		}
	}

	// The reaped run itself is untouched evidence: it stayed completed, and the
	// re-arm neither rewrote nor failed it.
	state, errorCode, _ := readReclassificationRunState(t, ctx, admin, fixture.TenantID, firstRunID)
	if state != "completed" || errorCode != "" {
		t.Fatalf("the original run is now %q/%q; the re-arm rewrote settled evidence", state, errorCode)
	}
}

type stageTwoWindowRow struct {
	FirstEventAt time.Time
	DueAt        time.Time
	State        string
}

func readStageTwoWindow(
	t *testing.T,
	ctx context.Context,
	admin *pgxpool.Pool,
	tenantID, messageHash string,
	stage StageTwoStage,
) stageTwoWindowRow {
	t.Helper()
	var row stageTwoWindowRow
	if err := admin.QueryRow(ctx, `
SELECT first_event_at, due_at, state
  FROM engagement_stage_two_evaluations
 WHERE tenant_id = $1::uuid AND message_identity_hash = $2 AND stage = $3`,
		tenantID, messageHash, string(stage)).
		Scan(&row.FirstEventAt, &row.DueAt, &row.State); err != nil {
		t.Fatalf("read stage two window (%s/%s): %v", messageHash, stage, err)
	}
	return row
}
