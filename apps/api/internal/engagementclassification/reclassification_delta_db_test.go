// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"testing"
	"time"
)

func deltaWindow(fixture stageTwoFixture) (time.Time, time.Time) {
	return fixture.Delivered.At.Add(-time.Hour), fixture.Delivered.At.Add(time.Hour)
}

// The whole F12 delta claim, end to end on Postgres.
//
// Before Stage 2 the recipient sits in the unknown band. Stage 2 appends a
// superseding verdict for every open and the recipient becomes machine-only.
// The reach FIGURE moved, and the audience did not change by a single row — so
// the delta must attribute the entire movement to the classifier, and the
// reach report for the same window must agree with the delta's after-figures.
func TestReclassificationDeltaAttributesStageTwoMovementToTheClassifier(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedStageTwoFixture(t, ctx, admin, 8, 200*time.Millisecond)
	repo := stageTwoRepo(t, app, "reclassification-delta")
	classifier := stageTwoBootstrapClassifier(t, ctx, repo)
	stageTwoIngestAll(t, ctx, repo, classifier, fixture)

	since, until := deltaWindow(fixture)
	query := ReclassificationDeltaQuery{
		TenantID: fixture.TenantID, Since: since, Until: until,
	}

	before, err := repo.ReclassificationDeltaFor(ctx, query)
	if err != nil {
		t.Fatalf("delta before stage two: %v", err)
	}
	// The premise. Nothing has been superseded, so nothing is attributable to
	// the classifier and the report must say so rather than emit an empty body.
	if before.EligibleEvents != 8 || before.ClassifiedEvents != 8 {
		t.Fatalf("eligible/classified events = %d/%d, want 8/8 (the delivery is not an interaction)",
			before.EligibleEvents, before.ClassifiedEvents)
	}
	if before.SupersededEvents != 0 || before.ChangedEvents != 0 || len(before.Transitions) != 0 {
		t.Fatalf("pre-stage-two delta claims a reclassification: %+v", before)
	}
	if before.RecipientsConsidered != 1 || before.UnknownBandBefore != 1 || before.UnknownBandAfter != 1 {
		t.Fatalf("pre-stage-two recipient buckets = %+v", before)
	}
	if before.ReachFloorDelta != 0 || before.UnknownBandDelta != 0 || before.MachineOnlyDelta != 0 {
		t.Fatalf("pre-stage-two deltas are non-zero: %+v", before)
	}
	if before.UnlinkedMultipleVerdictEvents != 0 {
		t.Fatalf("unlinked verdicts before stage two = %d, want 0", before.UnlinkedMultipleVerdictEvents)
	}

	worker := stageTwoWorkerAt(repo, classifier, fixture.FirstIngested.Add(StageTwoDelay))
	result, err := worker.EvaluateTenantOnce(ctx, fixture.TenantID)
	if err != nil {
		t.Fatalf("stage two evaluation: %v", err)
	}
	if result.EventsSuperseded == 0 {
		t.Fatalf("stage two superseded nothing; the delta assertions below would be vacuous: %+v", result)
	}

	after, err := repo.ReclassificationDeltaFor(ctx, query)
	if err != nil {
		t.Fatalf("delta after stage two: %v", err)
	}

	// 1. Seeding a superseding verdict CHANGES the delta.
	if after.SupersededEvents != 8 {
		t.Fatalf("superseded events = %d, want the 8 opens", after.SupersededEvents)
	}
	if after.ChangedEvents != 8 || after.RestatedEvents != 0 {
		t.Fatalf("changed/restated = %d/%d, want 8/0", after.ChangedEvents, after.RestatedEvents)
	}
	if after.MaxSupersessionDepth != 1 {
		t.Fatalf("max supersession depth = %d, want 1", after.MaxSupersessionDepth)
	}
	if after.UnlinkedMultipleVerdictEvents != 0 {
		t.Fatalf("linked stage-two lineage was counted as unlinked: %d",
			after.UnlinkedMultipleVerdictEvents)
	}

	// 2. WHAT changed, not just that something did.
	if len(after.Transitions) != 1 {
		t.Fatalf("transitions = %+v, want exactly unknown→machine/prefetcher", after.Transitions)
	}
	transition := after.Transitions[0]
	if transition.From != string(Unknown) || transition.To != string(Machine) ||
		transition.ToMachineSubtype != string(SubtypePrefetcher) ||
		transition.FromMachineSubtype != "" || !transition.Changed || transition.Events != 8 {
		t.Fatalf("transition = %+v", transition)
	}
	// The lineage carries the METHODOLOGY that produced each side. Without it a
	// reader cannot tell which classifier moved the number.
	if transition.FromMethodologyVersion == "" ||
		transition.FromMethodologyVersion == transition.ToMethodologyVersion {
		t.Fatalf("transition methodology identity = %q → %q, want two distinct versions",
			transition.FromMethodologyVersion, transition.ToMethodologyVersion)
	}
	expectedTo, err := stageTwoMethodologyVersion(transition.FromMethodologyVersion, StageTwoDelayed)
	if err != nil {
		t.Fatal(err)
	}
	if transition.ToMethodologyVersion != expectedTo {
		t.Fatalf("transition to-methodology = %q, want %q", transition.ToMethodologyVersion, expectedTo)
	}

	// 3. BY HOW MUCH, at event and recipient level.
	if after.HumanEventDelta != 0 || after.MachineEventDelta != 8 || after.UnknownEventDelta != -8 {
		t.Fatalf("event deltas human=%d machine=%d unknown=%d, want 0/+8/-8",
			after.HumanEventDelta, after.MachineEventDelta, after.UnknownEventDelta)
	}
	if after.RecipientsConsidered != 1 {
		t.Fatalf("recipients considered = %d, want 1", after.RecipientsConsidered)
	}
	if after.UnknownBandBefore != 1 || after.UnknownBandAfter != 0 || after.UnknownBandDelta != -1 {
		t.Fatalf("unknown band before/after/delta = %d/%d/%d, want 1/0/-1",
			after.UnknownBandBefore, after.UnknownBandAfter, after.UnknownBandDelta)
	}
	if after.MachineOnlyBefore != 0 || after.MachineOnlyAfter != 1 || after.MachineOnlyDelta != 1 {
		t.Fatalf("machine-only before/after/delta = %d/%d/%d, want 0/1/+1",
			after.MachineOnlyBefore, after.MachineOnlyAfter, after.MachineOnlyDelta)
	}
	if after.ReachFloorBefore != 0 || after.ReachFloorAfter != 0 || after.ReachFloorDelta != 0 {
		t.Fatalf("reach floor before/after/delta = %d/%d/%d, want 0/0/0",
			after.ReachFloorBefore, after.ReachFloorAfter, after.ReachFloorDelta)
	}

	// 4. The delta actually MOVED between the two reads. Comparing the two
	// reports directly is what proves the read is a function of the lineage
	// rather than a constant the assertions above happen to match.
	if after.UnknownBandAfter == before.UnknownBandAfter ||
		after.MachineOnlyAfter == before.MachineOnlyAfter ||
		after.SupersededEvents == before.SupersededEvents {
		t.Fatalf("the delta did not move when a superseding verdict was seeded:\nbefore=%+v\nafter=%+v",
			before, after)
	}

	// 5. Reconciliation with the report the delta explains. If these disagree,
	// the delta is describing a different population and every number above is
	// an answer to a question nobody asked.
	reach, err := repo.HumanEngagedReachFor(ctx, ReachQuery{
		TenantID: fixture.TenantID, Since: since, Until: until,
	})
	if err != nil {
		t.Fatalf("reach report: %v", err)
	}
	if reach.HumanEngagedReachFloor != after.ReachFloorAfter ||
		reach.UnknownBand != after.UnknownBandAfter ||
		reach.MachineOnly != after.MachineOnlyAfter {
		t.Fatalf("delta after-figures do not reconcile with the reach report: reach=%d/%d/%d delta=%d/%d/%d",
			reach.HumanEngagedReachFloor, reach.UnknownBand, reach.MachineOnly,
			after.ReachFloorAfter, after.UnknownBandAfter, after.MachineOnlyAfter)
	}

	// 6. Tenant isolation: the lineage read is an RLS-scoped tenant read, and a
	// foreign tenant must see an empty delta rather than another tenant's.
	foreign, err := repo.ReclassificationDeltaFor(ctx, ReclassificationDeltaQuery{
		TenantID: fixture.ForeignTenantID, Since: since, Until: until,
	})
	if err != nil {
		t.Fatalf("foreign tenant delta: %v", err)
	}
	if foreign.EligibleEvents != 0 || foreign.SupersededEvents != 0 ||
		foreign.RecipientsConsidered != 0 {
		t.Fatalf("foreign tenant observed another tenant's lineage: %+v", foreign)
	}
}

// The delta must read the LINEAGE, not "the oldest row wins".
//
// Two ingest-time verdicts under different configuration hashes are two
// independent verdicts: neither declares that it replaces the other, and
// event_classifications records no supersedes_id link between them. Treating
// the older one as an "origin" would report a reclassification the ledger never
// recorded — which is the exact failure mode this read exists to prevent, since
// it would attribute movement to the classifier on no evidence.
func TestReclassificationDeltaRefusesToInferASupersessionThatWasNeverRecorded(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedStageTwoFixture(t, ctx, admin, 1, time.Second)
	repo := stageTwoRepo(t, app, "reclassification-delta-unlinked")
	classifierA := stageTwoBootstrapClassifier(t, ctx, repo)

	open := fixture.Opens[0]
	stageTwoIngest(t, ctx, repo, classifierA, fixture.TenantID,
		stageTwoObservation(fixture, open, "open-a"))

	// A SECOND configuration identity for the same event. Different
	// configuration hash, so this is an appended row rather than a replay — and
	// insertClassification is handed an empty supersedes id, exactly as every
	// ingest-time write is.
	configB := DefaultConfig()
	configB.HumanThreshold = 0.50
	registry, err := repo.LoadRegistry(ctx, CurrentRegistryV2)
	if err != nil {
		t.Fatalf("load registry: %v", err)
	}
	classifierB, err := NewClassifier(configB, registry)
	if err != nil {
		t.Fatalf("compile second classifier: %v", err)
	}
	observationB := stageTwoObservation(fixture, open, "open-b")
	observationB.SourceEventID = "stage-two-open-b"
	stageTwoIngest(t, ctx, repo, classifierB, fixture.TenantID, observationB)

	// Premise: the ledger really does hold two UNLINKED verdicts. Without this
	// the assertions below would pass on a single-verdict event and prove
	// nothing.
	verdicts := stageTwoVerdicts(t, ctx, admin, fixture.TenantID, open)
	if len(verdicts) != 2 {
		t.Fatalf("verdict rows = %d, want 2 independent ingest-time verdicts", len(verdicts))
	}
	for index, verdict := range verdicts {
		if verdict.Supersedes != "" {
			t.Fatalf("verdict %d unexpectedly carries lineage %q", index, verdict.Supersedes)
		}
	}

	since, until := deltaWindow(fixture)
	delta, err := repo.ReclassificationDeltaFor(ctx, ReclassificationDeltaQuery{
		TenantID: fixture.TenantID, Since: since, Until: until,
	})
	if err != nil {
		t.Fatalf("delta: %v", err)
	}
	if delta.EligibleEvents != 1 || delta.ClassifiedEvents != 1 {
		t.Fatalf("eligible/classified = %d/%d, want 1/1", delta.EligibleEvents, delta.ClassifiedEvents)
	}
	// THE ASSERTION. An implementation that picked "the earliest verdict for
	// this event" as the origin — i.e. that ignored supersedes_id — reports a
	// supersession here.
	if delta.SupersededEvents != 0 {
		t.Fatalf("superseded events = %d, want 0: no supersedes_id link exists between these verdicts",
			delta.SupersededEvents)
	}
	if len(delta.Transitions) != 0 {
		t.Fatalf("transitions = %+v, want none: the ledger recorded no supersession", delta.Transitions)
	}
	if delta.ChangedEvents != 0 || delta.RestatedEvents != 0 {
		t.Fatalf("changed/restated = %d/%d, want 0/0", delta.ChangedEvents, delta.RestatedEvents)
	}
	if delta.HumanEventDelta != 0 || delta.MachineEventDelta != 0 || delta.UnknownEventDelta != 0 {
		t.Fatalf("event deltas are non-zero without a recorded supersession: %+v", delta)
	}
	// It is not silently dropped either: the reader is told the ledger cannot
	// explain this event, which is a different statement from "nothing happened".
	if delta.UnlinkedMultipleVerdictEvents != 1 {
		t.Fatalf("unlinked multiple-verdict events = %d, want 1", delta.UnlinkedMultipleVerdictEvents)
	}
	// Origin == current for an unsuperseded event, so the recipient buckets
	// cannot move.
	if delta.ReachFloorBefore != delta.ReachFloorAfter ||
		delta.UnknownBandBefore != delta.UnknownBandAfter ||
		delta.MachineOnlyBefore != delta.MachineOnlyAfter {
		t.Fatalf("recipient buckets moved without a recorded supersession: %+v", delta)
	}
	if delta.RecipientsConsidered != 1 {
		t.Fatalf("recipients considered = %d, want 1", delta.RecipientsConsidered)
	}
}

// A window with no classified interaction at all must still reconcile: the
// recipient is counted, its verdicts are absent rather than unknown-by-decision,
// and the provenance says "unclassified" instead of naming a classifier.
func TestReclassificationDeltaReportsUnclassifiedInteractionsAsAbsentProvenance(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedStageTwoFixture(t, ctx, admin, 2, time.Second)
	repo := stageTwoRepo(t, app, "reclassification-delta-unclassified")

	since, until := deltaWindow(fixture)
	delta, err := repo.ReclassificationDeltaFor(ctx, ReclassificationDeltaQuery{
		TenantID: fixture.TenantID, Since: since, Until: until,
	})
	if err != nil {
		t.Fatalf("delta: %v", err)
	}
	if delta.EligibleEvents != 2 || delta.ClassifiedEvents != 0 {
		t.Fatalf("eligible/classified = %d/%d, want 2/0", delta.EligibleEvents, delta.ClassifiedEvents)
	}
	if delta.RecipientsConsidered != 1 ||
		delta.UnknownBandBefore != 1 || delta.UnknownBandAfter != 1 {
		t.Fatalf("unclassified recipient buckets = %+v", delta)
	}
	if len(delta.ClassifierVersionCoverage) != 1 || !delta.ClassifierVersionCoverage[0].Unclassified ||
		delta.ClassifierVersionCoverage[0].EventCount != 2 {
		t.Fatalf("coverage = %+v, want one unclassified row for 2 events", delta.ClassifierVersionCoverage)
	}
	if delta.MixedClassifierVersions {
		t.Fatal("single-coverage window reported as mixed")
	}
	// The reach report reaches the same conclusion for the same window.
	reach, err := repo.HumanEngagedReachFor(ctx, ReachQuery{
		TenantID: fixture.TenantID, Since: since, Until: until,
	})
	if err != nil {
		t.Fatalf("reach report: %v", err)
	}
	if reach.UnknownBand != delta.UnknownBandAfter {
		t.Fatalf("reach unknown band %d != delta after %d", reach.UnknownBand, delta.UnknownBandAfter)
	}
}

// A caller may not read another tenant's campaign through the campaign filter.
func TestReclassificationDeltaRejectsAForeignCampaignScope(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedStageTwoFixture(t, ctx, admin, 1, time.Second)
	other := seedStageTwoFixture(t, ctx, admin, 1, time.Second)
	repo := stageTwoRepo(t, app, "reclassification-delta-scope")

	since, until := deltaWindow(fixture)
	if _, err := repo.ReclassificationDeltaFor(ctx, ReclassificationDeltaQuery{
		TenantID: fixture.TenantID, CampaignID: other.CampaignID,
		Since: since, Until: until,
	}); err == nil {
		t.Fatal("a foreign campaign scope was accepted")
	}

	// Guard the guard: the tenant's OWN campaign scope is accepted, so the
	// assertion above is testing ownership rather than a broken query.
	own, err := repo.ReclassificationDeltaFor(ctx, ReclassificationDeltaQuery{
		TenantID: fixture.TenantID, CampaignID: fixture.CampaignID,
		Since: since, Until: until,
	})
	if err != nil {
		t.Fatalf("own campaign scope rejected: %v", err)
	}
	if own.CampaignID != fixture.CampaignID || own.EligibleEvents != 1 {
		t.Fatalf("own campaign delta = %+v", own)
	}

}

// The same refusal one row further along.
//
// An event can carry a REAL supersedes_id chain and then acquire a later,
// unlinked verdict — a second ingest-time configuration classifying the same
// event after Stage 2 has already run. The current verdict then supersedes
// nothing, and the earlier reclassification sits outside the chain the report
// walks. A "does this event have any links at all" test calls that event fully
// explained; only a chain-COVERAGE test notices that part of its history is
// unreported.
func TestReclassificationDeltaFlagsVerdictsOutsideTheCurrentLineageChain(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedStageTwoFixture(t, ctx, admin, 8, 200*time.Millisecond)
	repo := stageTwoRepo(t, app, "reclassification-delta-orphan")
	classifierA := stageTwoBootstrapClassifier(t, ctx, repo)
	stageTwoIngestAll(t, ctx, repo, classifierA, fixture)

	worker := stageTwoWorkerAt(repo, classifierA, fixture.FirstIngested.Add(StageTwoDelay))
	if _, err := worker.EvaluateTenantOnce(ctx, fixture.TenantID); err != nil {
		t.Fatalf("stage two evaluation: %v", err)
	}

	// A later, LINK-FREE verdict for one of the opens.
	configB := DefaultConfig()
	configB.HumanThreshold = 0.50
	registry, err := repo.LoadRegistry(ctx, CurrentRegistryV2)
	if err != nil {
		t.Fatal(err)
	}
	classifierB, err := NewClassifier(configB, registry)
	if err != nil {
		t.Fatal(err)
	}
	orphaned := fixture.Opens[0]
	observationB := stageTwoObservation(fixture, orphaned, "orphan-b")
	observationB.SourceEventID = "stage-two-orphan-b"
	stageTwoIngest(t, ctx, repo, classifierB, fixture.TenantID, observationB)

	// Premise: three verdicts, of which the newest carries no lineage.
	verdicts := stageTwoVerdicts(t, ctx, admin, fixture.TenantID, orphaned)
	if len(verdicts) != 3 {
		t.Fatalf("verdict rows = %d, want 3 (ingest, stage two, unlinked)", len(verdicts))
	}
	if verdicts[2].Supersedes != "" {
		t.Fatalf("the newest verdict unexpectedly carries lineage %q", verdicts[2].Supersedes)
	}
	if verdicts[1].Supersedes == "" {
		t.Fatal("the stage-two verdict lost its lineage; this test would prove nothing")
	}

	since, until := deltaWindow(fixture)
	delta, err := repo.ReclassificationDeltaFor(ctx, ReclassificationDeltaQuery{
		TenantID: fixture.TenantID, Since: since, Until: until,
	})
	if err != nil {
		t.Fatalf("delta: %v", err)
	}
	// The orphaned event has links, so a "linked_count = 0" test would call it
	// explained. Its current verdict supersedes nothing, so it is not.
	if delta.UnlinkedMultipleVerdictEvents != 1 {
		t.Fatalf("events with verdicts outside the current chain = %d, want 1",
			delta.UnlinkedMultipleVerdictEvents)
	}
	// The other seven opens are ordinary stage-two supersessions and stay in
	// the delta — the flag must not swallow the whole report.
	if delta.SupersededEvents != 7 {
		t.Fatalf("superseded events = %d, want the 7 opens whose chain still reaches their current verdict",
			delta.SupersededEvents)
	}
	if delta.EligibleEvents != 8 {
		t.Fatalf("eligible events = %d, want 8", delta.EligibleEvents)
	}
}

// The harder half of the same shape: the unreported verdict is OLDER than the
// chain rather than newer.
//
// Two ingest-time configurations classify the same event, then Stage 2
// supersedes the later of them. The current verdict now has a real chain of
// depth 1, and the first configuration's verdict sits outside it. Any test
// phrased as "does this event have links" or "is its chain depth zero" calls
// that event fully explained; only comparing chain length against the verdict
// count notices the row nobody reported.
func TestReclassificationDeltaFlagsAnOlderVerdictTheChainNeverReaches(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)
	fixture := seedStageTwoFixture(t, ctx, admin, 8, 200*time.Millisecond)
	repo := stageTwoRepo(t, app, "reclassification-delta-older-orphan")
	classifierA := stageTwoBootstrapClassifier(t, ctx, repo)
	stageTwoIngestAll(t, ctx, repo, classifierA, fixture)

	configB := DefaultConfig()
	configB.HumanThreshold = 0.50
	registry, err := repo.LoadRegistry(ctx, CurrentRegistryV2)
	if err != nil {
		t.Fatal(err)
	}
	classifierB, err := NewClassifier(configB, registry)
	if err != nil {
		t.Fatal(err)
	}
	orphaned := fixture.Opens[0]
	observationB := stageTwoObservation(fixture, orphaned, "older-orphan-b")
	observationB.SourceEventID = "stage-two-older-orphan-b"
	stageTwoIngest(t, ctx, repo, classifierB, fixture.TenantID, observationB)

	worker := stageTwoWorkerAt(repo, classifierA, fixture.FirstIngested.Add(StageTwoDelay))
	if _, err := worker.EvaluateTenantOnce(ctx, fixture.TenantID); err != nil {
		t.Fatalf("stage two evaluation: %v", err)
	}

	// Premise: three verdicts, the newest carries lineage, and one of the two
	// ingest-time verdicts is outside that chain.
	verdicts := stageTwoVerdicts(t, ctx, admin, fixture.TenantID, orphaned)
	if len(verdicts) != 3 {
		t.Fatalf("verdict rows = %d, want 3", len(verdicts))
	}
	if verdicts[2].Supersedes == "" {
		t.Fatal("the stage-two verdict carries no lineage; this test would prove nothing")
	}
	covered := map[string]bool{verdicts[2].ID: true, verdicts[2].Supersedes: true}
	if len(covered) != 2 || covered[verdicts[0].ID] == covered[verdicts[1].ID] {
		t.Fatalf("the chain does not leave exactly one verdict uncovered: %+v", verdicts)
	}

	since, until := deltaWindow(fixture)
	delta, err := repo.ReclassificationDeltaFor(ctx, ReclassificationDeltaQuery{
		TenantID: fixture.TenantID, Since: since, Until: until,
	})
	if err != nil {
		t.Fatalf("delta: %v", err)
	}
	if delta.UnlinkedMultipleVerdictEvents != 1 {
		t.Fatalf("events with a verdict the chain never reaches = %d, want 1",
			delta.UnlinkedMultipleVerdictEvents)
	}
	// The event still has a genuine one-step chain, so it stays in the delta.
	// The flag is a completeness warning, not an exclusion of the whole event.
	if delta.SupersededEvents != 8 {
		t.Fatalf("superseded events = %d, want all 8 opens", delta.SupersededEvents)
	}
	if delta.MaxSupersessionDepth != 1 {
		t.Fatalf("max supersession depth = %d, want 1", delta.MaxSupersessionDepth)
	}
}
