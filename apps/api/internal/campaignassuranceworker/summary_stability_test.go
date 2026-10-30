// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceworker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/campaignchecks"
)

// Eight consistent summaries are measured, persisted, and carry their numbers.
//
// The assertions are deliberately not "no findings were recorded". A worker
// that never ran the assessment also records no findings, so this counts the
// provider calls the reviewed summarisation configuration made, reads the run
// ordinals it made them with, and reads the variance out of the durable
// normalized extraction. Deleting the call from the modeled path fails every
// one of them.
func TestWorkerMeasuresSummaryStabilityThroughTheFrozenSuite(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceModeled)
	configureModeledEnsemble(t, &fixture, modeledTestContract(t), 2, 2*time.Second)
	configureSummaryStabilityTarget(t, &fixture, 2*time.Second)

	recorder := &summaryRunRecorder{}
	fixture.worker.ModelExecutor = summaryTestExecutor(t, recorder, func(int) string {
		return stableSummaryDraft
	})

	result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != OutcomeComplete || result.Run == nil ||
		result.Run.GateDecision != campaignassurance.GatePass {
		t.Fatalf("result = %+v", result)
	}
	if got := recorder.runs(); len(got) != campaignchecks.SummaryRunCount {
		t.Fatalf("summarisation runs = %v, want %d", got, campaignchecks.SummaryRunCount)
	}
	for index, run := range recorder.runs() {
		if run != index+1 {
			t.Fatalf("summarisation run ordinals = %v; the executor cannot vary its sampling", recorder.runs())
		}
	}
	if distinct := recorder.distinctCacheKeys(); distinct != campaignchecks.SummaryRunCount {
		t.Fatalf("distinct summarisation cache keys = %d, want %d; a caching executor "+
			"would return one answer eight times and every campaign would look stable",
			distinct, campaignchecks.SummaryRunCount)
	}

	fixture.assurance.mu.Lock()
	defer fixture.assurance.mu.Unlock()
	extraction := summaryExtraction(t, fixture.assurance.extractions)
	if extraction.Status != campaignassurance.ExtractionComplete {
		t.Fatalf("summary stability extraction status = %q", extraction.Status)
	}
	report := decodeSummaryReport(t, extraction.NormalizedExtraction)
	if report["assessment_status"] != "pass" || report["kind"] != "summary_stability_report" {
		t.Fatalf("summary stability report = %v", report)
	}
	variance, _ := report["variance"].(map[string]any)
	if variance == nil {
		t.Fatalf("the normalized extraction carries no variance: %v", report)
	}
	for field, want := range map[string]float64{
		"runs": float64(campaignchecks.SummaryRunCount), "answered": float64(campaignchecks.SummaryRunCount),
		"failed": 0, "compared_pairs": 28, "summary_agreement": 1,
	} {
		if variance[field] != want {
			t.Fatalf("variance[%s] = %v, want %v (full variance %v)", field, variance[field], want, variance)
		}
	}
	// Metering is the other thing only a real run can produce.
	if extraction.InputTokens != int64(campaignchecks.SummaryRunCount)*10 ||
		extraction.CostMicrounits != int64(campaignchecks.SummaryRunCount)*3 ||
		extraction.ExecutionKind != campaignassurance.ModeledExecutionInvoked ||
		extraction.RawOutputObjectRef == "" {
		t.Fatalf("summary stability extraction lost its invocation evidence: %+v", extraction)
	}
	// The scored comprehension ensemble is untouched: the summariser is not an
	// analyzer and must not be counted as one.
	if fixture.assurance.finalizeInput.OverallScore == nil ||
		*fixture.assurance.finalizeInput.OverallScore != 100 {
		t.Fatalf("summary stability disturbed the comprehension score: %+v", fixture.assurance.finalizeInput)
	}
}

// A summariser that fails is not a summariser that agreed with itself.
//
// This is the failure mode the whole tri-state exists for: eight failed runs
// produce no observed disagreement, and a check that reads "no disagreement
// observed" as "stable" converts a total outage into a certificate. The
// assertions therefore pin the exact opposite of a pass at every layer that a
// reader could mistake for one — the finding, the extraction status, and the
// gate.
func TestAFailingSummariserIsNotAPass(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceModeled)
	configureModeledEnsemble(t, &fixture, modeledTestContract(t), 2, 2*time.Second)
	configureSummaryStabilityTarget(t, &fixture, 2*time.Second)

	recorder := &summaryRunRecorder{failEveryRun: true}
	fixture.worker.ModelExecutor = summaryTestExecutor(t, recorder, func(int) string { return "" })

	result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
	if err != nil {
		t.Fatal(err)
	}
	if len(recorder.runs()) != campaignchecks.SummaryRunCount {
		t.Fatalf("summarisation runs = %v; the failing summariser was not actually exercised", recorder.runs())
	}
	if result.Outcome != OutcomeIncomplete || result.Run == nil ||
		result.Run.GateDecision != campaignassurance.GateUnavailable {
		t.Fatalf("a summariser that answered nothing produced result %+v", result)
	}

	fixture.assurance.mu.Lock()
	defer fixture.assurance.mu.Unlock()
	extraction := summaryExtraction(t, fixture.assurance.extractions)
	if extraction.Status != campaignassurance.ExtractionUnavailable ||
		extraction.ErrorCode != summaryStabilityNotAssessedCode ||
		len(extraction.NormalizedExtraction) != 0 {
		t.Fatalf("an unmeasured assessment produced a measurement receipt: %+v", extraction)
	}
	if !bytesContainAll(extraction.EvidenceManifest,
		`"assessment_status":"not_assessed"`, `"answered":0`,
		`"failed":`+strconv.Itoa(campaignchecks.SummaryRunCount)) {
		t.Fatalf("the not-assessed receipt does not say how many runs answered: %s", extraction.EvidenceManifest)
	}

	finding := summaryFinding(t, fixture.assurance.findings, "SUMMARY_STABILITY_NOT_ASSESSED")
	if finding.SourceClass != campaignassurance.SourceModeled {
		t.Fatalf("a model-derived finding was recorded as %q", finding.SourceClass)
	}
	if !bytesContainAll(finding.ObservedValue, `"assessed":false`) {
		t.Fatalf("finding does not state that nothing was assessed: %s", finding.ObservedValue)
	}
	for _, recorded := range fixture.assurance.findings {
		if recorded.Code == "SUMMARY_UNSTABLE" {
			t.Fatalf("a summariser that never answered was reported as unstable: %+v", recorded)
		}
	}
	if bytesContainAll(extraction.EvidenceManifest, `"assessment_status":"pass"`) {
		t.Fatalf("a failed assessment reported a pass: %s", extraction.EvidenceManifest)
	}
}

// Eight answers about eight different messages block the gate.
//
// The drafts below disagree on all three dimensions at once, which is the
// shape of the failure a customer actually reports: they forward the digest
// line their assistant produced and it is not the one anybody else got.
func TestEightDivergentSummariesBlockTheGate(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceModeled)
	configureModeledEnsemble(t, &fixture, modeledTestContract(t), 2, 2*time.Second)
	configureSummaryStabilityTarget(t, &fixture, 2*time.Second)

	recorder := &summaryRunRecorder{}
	fixture.worker.ModelExecutor = summaryTestExecutor(t, recorder, divergentSummaryDraft)

	result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
	if err != nil {
		t.Fatal(err)
	}
	if len(recorder.runs()) != campaignchecks.SummaryRunCount {
		t.Fatalf("summarisation runs = %v", recorder.runs())
	}
	if result.Outcome != OutcomeComplete || result.Run == nil ||
		result.Run.GateDecision != campaignassurance.GateBlock || result.BlockerCount != 1 {
		t.Fatalf("eight divergent summaries did not block: %+v", result)
	}

	fixture.assurance.mu.Lock()
	defer fixture.assurance.mu.Unlock()
	finding := summaryFinding(t, fixture.assurance.findings, "SUMMARY_UNSTABLE")
	if !finding.Blocking || finding.SourceClass != campaignassurance.SourceModeled {
		t.Fatalf("SUMMARY_UNSTABLE is advisory or misattributed: %+v", finding)
	}
	if !bytesContainAll(finding.ObservedValue,
		`"one_line_summary"`, `"primary_intent"`, `"primary_action"`) {
		t.Fatalf("the finding does not name the dimensions that diverged: %s", finding.ObservedValue)
	}

	extraction := summaryExtraction(t, fixture.assurance.extractions)
	report := decodeSummaryReport(t, extraction.NormalizedExtraction)
	if report["assessment_status"] != "fail" {
		t.Fatalf("summary stability report = %v", report)
	}
	variance, _ := report["variance"].(map[string]any)
	unstable, _ := variance["unstable_dimensions"].([]any)
	if len(unstable) != 3 {
		t.Fatalf("unstable dimensions = %v, want all three", variance["unstable_dimensions"])
	}
	if variance["answered"] != float64(campaignchecks.SummaryRunCount) {
		t.Fatalf("a blocking verdict was reached without eight answers: %v", variance)
	}
}

// A summariser that asks a different question never reaches the provider.
//
// This is what makes "the prompt is reviewed" a guarantee rather than a
// convention. The reviewed rendering is recomputed from the frozen suite and
// the closed artifact; anything else is refused before a call is made, so a
// future Summarizer cannot smuggle its own question through the one string this
// package accepts from campaignchecks.
func TestASummariserAskingAnUnreviewedQuestionIsRefusedBeforeTheProvider(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceModeled)
	executor := &modelExecutorFake{
		identity: ModelExecutorIdentity{ID: "test.closed-executor", Version: "postwave.test.executor.v1"},
		execute: func(_ context.Context, request ModelRequest) (ModelResult, error) {
			return summaryModelResult(request, stableSummaryDraft), nil
		},
	}
	worker := &Worker{ModelExecutor: executor}
	checkInput := campaignchecks.Input{
		Revision: fixture.artifacts.revision, Compilation: fixture.compiled,
		PolicyVersion: "postwave.test.gate-policy.v1",
	}
	configuration := summaryTestConfiguration(2 * time.Second)
	invoker := worker.newSummaryInvoker(
		configuration,
		ModelRequest{
			CacheKey:      fixture.compiled.Artifact.OutboundMIMEHash,
			Configuration: configuration,
		},
		checkInput,
	)
	if invoker == nil {
		t.Fatal("no invoker was built for a bounded artifact")
	}

	if _, err := invoker.invoke(context.Background(), "Summarise this however you like."); !errors.Is(err, errSummaryPromptUnreviewed) {
		t.Fatalf("an unreviewed prompt returned %v, want refusal", err)
	}
	if executor.requestCount() != 0 {
		t.Fatalf("an unreviewed prompt reached the provider %d times", executor.requestCount())
	}

	frozen, ok := campaignchecks.NewSummaryRequestV1(checkInput)
	if !ok {
		t.Fatal("the fixture artifact is outside the bounded summarisation input")
	}
	if _, err := invoker.invoke(context.Background(), campaignchecks.RenderSummaryPromptV1(frozen)); err != nil {
		t.Fatalf("the frozen reviewed prompt was refused: %v", err)
	}
	if executor.requestCount() != 1 {
		t.Fatalf("the frozen reviewed prompt reached the provider %d times", executor.requestCount())
	}
}

// No executor means no summariser, which means no pass.
//
// The invoker is the only thing that can turn a ModelExecutor into a
// Summarizer. When it declines to build one, campaignchecks receives a nil
// Summarizer, and a nil Summarizer is the case its tri-state exists for. The
// two halves are asserted together here so that "absent" cannot quietly become
// "assumed fine" at the seam between the packages.
func TestAWorkerWithNoExecutorBuildsNoSummariserAndCannotPass(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceModeled)
	checkInput := campaignchecks.Input{
		Revision: fixture.artifacts.revision, Compilation: fixture.compiled,
		PolicyVersion: "postwave.test.gate-policy.v1",
	}
	worker := &Worker{}
	if invoker := worker.newSummaryInvoker(
		summaryTestConfiguration(2*time.Second), ModelRequest{}, checkInput,
	); invoker != nil {
		t.Fatalf("a worker with no model executor built a summariser: %+v", invoker)
	}

	stability := campaignchecks.AssessSummaryStability(context.Background(), checkInput, nil)
	if stability.Status != campaignchecks.AssessmentNotAssessed {
		t.Fatalf("an absent summariser reported %q", stability.Status)
	}
	if len(stability.Findings) == 0 || stability.Findings[0].Code != "SUMMARY_STABILITY_NOT_ASSESSED" {
		t.Fatalf("an absent summariser recorded no finding: %+v", stability.Findings)
	}
}

// The summariser is not an ensemble member.
//
// Two distinct analyzers are required before a comprehension score means
// anything. If the summarisation configuration counted toward that, one
// analyzer plus one summariser would satisfy a rule that exists to stop a
// single model's opinion from being scored as agreement.
func TestTheSummaryConfigurationDoesNotSatisfyTheAnalyzerEnsembleRule(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceModeled)
	configureModeledEnsemble(t, &fixture, modeledTestContract(t), 1, 2*time.Second)
	configureSummaryStabilityTarget(t, &fixture, 2*time.Second)

	recorder := &summaryRunRecorder{}
	fixture.worker.ModelExecutor = summaryTestExecutor(t, recorder, func(int) string { return stableSummaryDraft })

	if _, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID}); err != nil {
		t.Fatal(err)
	}
	fixture.assurance.mu.Lock()
	defer fixture.assurance.mu.Unlock()
	if !hasFindingCode(fixture.assurance.findings, "MODELED_ENSEMBLE_UNAVAILABLE", false) {
		t.Fatalf("one analyzer plus one summariser satisfied the ensemble rule: %+v", fixture.assurance.findings)
	}
	// The summariser still ran: an incomplete analyzer ensemble is not a reason
	// to skip a question that does not depend on it.
	if len(recorder.runs()) != campaignchecks.SummaryRunCount {
		t.Fatalf("summarisation runs = %v", recorder.runs())
	}
}

// The Fact Contract gate does not reach the summariser.
//
// This is the exclusion the whole F06 reachability claim rests on. A revision
// with no frozen Fact Contract sends every ANALYZER target to
// MODELED_FACT_CONTRACT_UNAVAILABLE before an artifact is ever read; if the
// summary-stability target were gated with them, SUMMARY_UNSTABLE would be
// unreachable on exactly the campaigns that arrive without a contract, which is
// most of them. Every other summary fixture in this file freezes one, so this
// is the only test that exercises a contract-less revision end to end.
//
// The assertions are deliberately not "the run completed". They count the
// provider calls, read the ordinals, read the variance out of the durable
// normalized extraction, and demand the blocking finding — and they separately
// pin that the analyzers really were denied for want of a contract, so the test
// cannot be repaired later by quietly handing the fixture one.
func TestSummaryStabilityIsMeasuredOnARevisionWithNoFactContract(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceModeled)
	configureModeledEnsemble(t, &fixture, modeledTestContract(t), 2, 2*time.Second)
	// The majority case: a frozen revision that never carried a sender oracle.
	fixture.artifacts.revision.FactContract = nil
	configureSummaryStabilityTarget(t, &fixture, 2*time.Second)

	recorder := &summaryRunRecorder{}
	fixture.worker.ModelExecutor = summaryTestExecutor(t, recorder, divergentSummaryDraft)

	result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
	if err != nil {
		t.Fatal(err)
	}

	// The summariser ran anyway. Eight calls, eight ordinals, eight cache keys.
	if got := recorder.runs(); len(got) != campaignchecks.SummaryRunCount {
		t.Fatalf("summarisation runs on a contract-less revision = %v, want %d; "+
			"the Fact Contract gate swallowed the summary target, so SUMMARY_UNSTABLE "+
			"is unreachable for the campaigns that arrive without a contract",
			got, campaignchecks.SummaryRunCount)
	}
	for index, run := range recorder.runs() {
		if run != index+1 {
			t.Fatalf("summarisation run ordinals = %v", recorder.runs())
		}
	}
	if distinct := recorder.distinctCacheKeys(); distinct != campaignchecks.SummaryRunCount {
		t.Fatalf("distinct summarisation cache keys = %d, want %d", distinct, campaignchecks.SummaryRunCount)
	}

	fixture.assurance.mu.Lock()
	defer fixture.assurance.mu.Unlock()
	analyzersDenied, summaryDenied := factContractDenials(fixture.assurance.findings)
	if summaryDenied != 0 {
		t.Fatalf("the summary target was denied for want of a Fact Contract %d time(s); "+
			"the check now only runs on campaigns that already have a contract", summaryDenied)
	}
	// Guard the guard: the two ANALYZER targets must both have been refused, which
	// is what makes this a contract-less run rather than a second copy of the
	// ordinary fixture. Handing the fixture a contract to make the test pass fails
	// here instead.
	if analyzersDenied != 2 {
		t.Fatalf("analyzer targets denied for want of a Fact Contract = %d, want 2; "+
			"the fixture is not contract-less and proves nothing: %+v",
			analyzersDenied, fixture.assurance.findings)
	}

	// The measurement is durable, and it is a measurement — not a receipt saying
	// the sender oracle was missing.
	extraction := summaryExtraction(t, fixture.assurance.extractions)
	if extraction.Status != campaignassurance.ExtractionComplete || extraction.ErrorCode != "" {
		t.Fatalf("summary stability was recorded as %q/%q on a contract-less revision: %+v",
			extraction.Status, extraction.ErrorCode, extraction)
	}
	if extraction.ExecutionKind != campaignassurance.ModeledExecutionInvoked ||
		extraction.InputTokens != int64(campaignchecks.SummaryRunCount)*10 ||
		extraction.RawOutputObjectRef == "" {
		t.Fatalf("summary stability extraction lost its invocation evidence: %+v", extraction)
	}
	report := decodeSummaryReport(t, extraction.NormalizedExtraction)
	if report["assessment_status"] != "fail" {
		t.Fatalf("eight divergent summaries on a contract-less revision reported %v", report)
	}
	variance, _ := report["variance"].(map[string]any)
	if variance == nil || variance["answered"] != float64(campaignchecks.SummaryRunCount) {
		t.Fatalf("a verdict was reached without eight answers: %v", report)
	}
	if unstable, _ := variance["unstable_dimensions"].([]any); len(unstable) != 3 {
		t.Fatalf("unstable dimensions = %v, want all three", variance["unstable_dimensions"])
	}

	// The finding itself — the thing a customer sees — is produced and blocking.
	finding := summaryFinding(t, fixture.assurance.findings, "SUMMARY_UNSTABLE")
	if !finding.Blocking || finding.SourceClass != campaignassurance.SourceModeled {
		t.Fatalf("SUMMARY_UNSTABLE is advisory or misattributed: %+v", finding)
	}
	if result.BlockerCount != analyzersDenied+1 {
		t.Fatalf("blocker count = %d, want %d (two contract refusals plus one unstable summary)",
			result.BlockerCount, analyzersDenied+1)
	}
	// The run is still incomplete because the analyzers never ran; an absent
	// contract does not become a pass just because the summariser answered.
	if result.Outcome != OutcomeIncomplete || result.Run == nil ||
		result.Run.GateDecision != campaignassurance.GateUnavailable {
		t.Fatalf("a run whose analyzers were refused reported %+v", result)
	}
}

// A contract-less revision whose summariser fails is not a pass either.
//
// The two conditions compose, and this is the composition that would be worst
// to get wrong: the analyzers are already unavailable for want of a contract, so
// a summariser that answers nothing leaves the run with no positive evidence at
// all. The verdict must still be SUMMARY_STABILITY_NOT_ASSESSED — a distinct,
// non-passing tri-state — rather than silence, a pass, or the contract refusal
// wearing the summariser's name.
func TestAContractLessRevisionWithAFailingSummariserIsNotAssessedRatherThanPassed(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceModeled)
	configureModeledEnsemble(t, &fixture, modeledTestContract(t), 2, 2*time.Second)
	fixture.artifacts.revision.FactContract = nil
	configureSummaryStabilityTarget(t, &fixture, 2*time.Second)

	recorder := &summaryRunRecorder{failEveryRun: true}
	fixture.worker.ModelExecutor = summaryTestExecutor(t, recorder, func(int) string { return "" })

	result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != OutcomeIncomplete || result.Run == nil ||
		result.Run.GateDecision != campaignassurance.GateUnavailable {
		t.Fatalf("result = %+v", result)
	}

	// The summariser was reached and exercised: the failure being measured is the
	// summariser's, not the gate refusing to call it.
	if len(recorder.runs()) != campaignchecks.SummaryRunCount {
		t.Fatalf("summarisation runs = %v, want %d; the failing summariser was never called "+
			"on a contract-less revision", recorder.runs(), campaignchecks.SummaryRunCount)
	}

	fixture.assurance.mu.Lock()
	defer fixture.assurance.mu.Unlock()
	analyzersDenied, summaryDenied := factContractDenials(fixture.assurance.findings)
	if summaryDenied != 0 {
		t.Fatalf("the summary target was denied for want of a Fact Contract %d time(s)", summaryDenied)
	}
	if analyzersDenied != 2 {
		t.Fatalf("analyzer targets denied for want of a Fact Contract = %d, want 2: %+v",
			analyzersDenied, fixture.assurance.findings)
	}

	extraction := summaryExtraction(t, fixture.assurance.extractions)
	if extraction.Status != campaignassurance.ExtractionUnavailable ||
		extraction.ErrorCode != summaryStabilityNotAssessedCode ||
		len(extraction.NormalizedExtraction) != 0 {
		t.Fatalf("a summariser that answered nothing produced %q/%q: %+v",
			extraction.Status, extraction.ErrorCode, extraction)
	}
	if !bytesContainAll(extraction.EvidenceManifest,
		`"assessment_status":"not_assessed"`, `"answered":0`,
		`"failed":`+strconv.Itoa(campaignchecks.SummaryRunCount)) {
		t.Fatalf("the not-assessed receipt does not say how many runs answered: %s", extraction.EvidenceManifest)
	}
	if bytesContainAll(extraction.EvidenceManifest, `"assessment_status":"pass"`) {
		t.Fatalf("a failed assessment reported a pass: %s", extraction.EvidenceManifest)
	}

	finding := summaryFinding(t, fixture.assurance.findings, "SUMMARY_STABILITY_NOT_ASSESSED")
	if finding.SourceClass != campaignassurance.SourceModeled ||
		!bytesContainAll(finding.ObservedValue, `"assessed":false`) {
		t.Fatalf("the not-assessed finding does not state that nothing was assessed: %+v", finding)
	}
	for _, recorded := range fixture.assurance.findings {
		if recorded.Code == "SUMMARY_UNSTABLE" {
			t.Fatalf("a summariser that never answered was reported as unstable: %+v", recorded)
		}
	}
}

const stableSummaryDraft = `{"one_line_summary":"The assurance fixture asks the reader to continue",` +
	`"primary_intent":"announcement","primary_action":"Continue"}`

func divergentSummaryDraft(run int) string {
	subjects := []string{
		"quarterly invoice totals are ready for download",
		"the venue moved to a different city this weekend",
		"password reset was requested from an unknown device",
		"a webinar about supply chain forecasting starts soon",
		"your subscription renews at a higher tier next month",
		"warehouse inventory counts finished ahead of schedule",
		"the beta programme closed to new participants today",
		"legal terms changed for customers in three regions",
	}
	intents := []string{
		"transactional", "event_invite", "other", "newsletter",
		"offer", "announcement", "transactional_receipt", "notice",
	}
	actions := []string{
		"Download invoice", "Check the new venue", "Reset password", "Register now",
		"Review pricing", "Open the report", "Join the waitlist", "Read the terms",
	}
	// Never index out of range, even for a run ordinal the helper should never
	// see. A helper that panics turns a clean assertion failure into a crash
	// that takes the rest of the package's results with it.
	index := ((run-1)%len(subjects) + len(subjects)) % len(subjects)
	return fmt.Sprintf(`{"one_line_summary":%q,"primary_intent":%q,"primary_action":%q}`,
		subjects[index], intents[index], actions[index])
}

type summaryRunRecorder struct {
	mu           sync.Mutex
	observedRuns []int
	cacheKeys    map[string]struct{}
	failEveryRun bool
}

func (r *summaryRunRecorder) record(request ModelRequest) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cacheKeys == nil {
		r.cacheKeys = map[string]struct{}{}
	}
	r.observedRuns = append(r.observedRuns, request.SummaryRun)
	r.cacheKeys[request.CacheKey] = struct{}{}
}

func (r *summaryRunRecorder) runs() []int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]int(nil), r.observedRuns...)
}

func (r *summaryRunRecorder) distinctCacheKeys() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.cacheKeys)
}

func summaryTestExecutor(
	t *testing.T,
	recorder *summaryRunRecorder,
	draft func(run int) string,
) *modelExecutorFake {
	t.Helper()
	return &modelExecutorFake{
		identity: ModelExecutorIdentity{ID: "test.closed-executor", Version: "postwave.test.executor.v1"},
		execute: func(_ context.Context, request ModelRequest) (ModelResult, error) {
			if !isSummaryStabilityConfiguration(request.Configuration) {
				if request.SummaryRun != 0 {
					t.Errorf("an analyzer configuration carried a summarisation run ordinal: %d", request.SummaryRun)
				}
				return successfulModelResult(request.Configuration,
					mustJSON(exactModeledExtraction(false))), nil
			}
			recorder.record(request)
			if request.SummaryRun < 1 || request.SummaryRun > campaignchecks.SummaryRunCount {
				t.Errorf("summarisation run ordinal out of the frozen range: %d", request.SummaryRun)
			}
			if recorder.failEveryRun {
				return ModelResult{}, &ModelExecutionFailure{
					Code: "provider_retryable", Kind: ModelFailureRetryable,
				}
			}
			return summaryModelResult(request, draft(request.SummaryRun)), nil
		},
	}
}

func summaryModelResult(request ModelRequest, draft string) ModelResult {
	result := successfulModelResult(request.Configuration, []byte(draft))
	// Kept well under one eighth of the frozen per-invocation reservation so
	// that eight runs settle inside what was reserved once.
	result.InputTokens, result.OutputTokens, result.CostMicrounits = 10, 4, 3
	return result
}

func summaryTestConfiguration(timeout time.Duration) ModeledConfigurationV1 {
	configuration := modeledTestConfiguration(
		strconv.FormatInt(productionSummaryPromptDefinitionV1.Seed, 10), timeout)
	configuration.PromptVersion = SummaryStabilityPromptVersionV1
	configuration.Temperature = summaryStabilityTemperatureV1
	return configuration
}

// configureSummaryStabilityTarget appends the reviewed summarisation
// configuration as the last frozen member, exactly as
// ProductionGeminiConfigurations does.
func configureSummaryStabilityTarget(t *testing.T, fixture *fixture, timeout time.Duration) {
	t.Helper()
	input, err := NewModeledConfiguration(SummaryStabilityConfigurationID, summaryTestConfiguration(timeout))
	if err != nil {
		t.Fatal(err)
	}
	hash, err := canonicalConfigurationHash(input.Configuration)
	if err != nil {
		t.Fatal(err)
	}
	ordinal := len(fixture.assurance.claimed.Configurations) + 1
	fixture.assurance.claimed.Configurations = append(fixture.assurance.claimed.Configurations,
		campaignassurance.RunConfiguration{
			TenantID: testTenantID, CampaignID: testCampaignID, RunID: testRunID,
			Ordinal: ordinal, ID: input.ID, SourceClass: campaignassurance.SourceModeled,
			ConfigurationHash: hash, Configuration: input.Configuration,
		})
	fixture.assurance.claimed.Targets = append(fixture.assurance.claimed.Targets,
		campaignassurance.RunTarget{
			TenantID: testTenantID, CampaignID: testCampaignID, RunID: testRunID,
			SendPlanID: testPlanID, ArtifactID: testArtifactID, ConfigurationID: input.ID,
			Ordinal: ordinal, SourceClass: campaignassurance.SourceModeled,
			ConfigurationHash: hash, OutboundMIMEHash: fixture.compiled.Artifact.OutboundMIMEHash,
		})
	fixture.assurance.claimed.Run.RequiredConfigurationCount = ordinal
	fixture.assurance.claimed.Run.RequiredExtractionCount = ordinal
}

// factContractDenials splits MODELED_FACT_CONTRACT_UNAVAILABLE findings by whose
// target they were recorded against: the comprehension analyzers, which legitimately
// need a sender oracle, and the summariser, which does not and must never be
// refused for the want of one.
func factContractDenials(values []campaignassurance.FindingInput) (analyzers int, summary int) {
	for _, value := range values {
		if value.Code != "MODELED_FACT_CONTRACT_UNAVAILABLE" {
			continue
		}
		if value.ConfigurationID == SummaryStabilityConfigurationID {
			summary++
			continue
		}
		analyzers++
	}
	return analyzers, summary
}

func summaryExtraction(t *testing.T, values []campaignassurance.ExtractionInput) campaignassurance.ExtractionInput {
	t.Helper()
	found := make([]campaignassurance.ExtractionInput, 0, 1)
	for _, value := range values {
		if value.ConfigurationID == SummaryStabilityConfigurationID {
			found = append(found, value)
		}
	}
	if len(found) != 1 {
		t.Fatalf("summary stability extractions = %d, want exactly 1 (all: %+v)", len(found), values)
	}
	return found[0]
}

func summaryFinding(t *testing.T, values []campaignassurance.FindingInput, code string) campaignassurance.FindingInput {
	t.Helper()
	for _, value := range values {
		if value.Code == code {
			return value
		}
	}
	t.Fatalf("missing finding %s; recorded: %+v", code, values)
	return campaignassurance.FindingInput{}
}

func decodeSummaryReport(t *testing.T, raw json.RawMessage) map[string]any {
	t.Helper()
	if len(raw) == 0 {
		t.Fatal("summary stability extraction carries no normalized extraction")
	}
	var report map[string]any
	if err := json.Unmarshal(raw, &report); err != nil {
		t.Fatal(err)
	}
	return report
}

// An ABSENT summariser, end to end through Process — not just at the seam.
//
// The absent case was previously asserted only at unit level: one test called
// worker.newSummaryInvoker directly and another called
// campaignchecks.AssessSummaryStability(ctx, input, nil). Both are true and
// neither proves what a deployment actually does, because nothing exercised the
// path from Process through to a persisted receipt with no executor configured.
//
// That gap matters more than the failing-summariser one it sits beside. A
// FAILING summariser is a deployment that tried; an ABSENT one is the default
// state of any environment where the model executor was never wired — which is
// exactly the configuration most likely to exist and least likely to be noticed,
// because nothing errors. If that path silently passed, the gate would report
// that a message summarises consistently on every deployment that never ran a
// summariser at all.
func TestAnAbsentSummariserIsNotAssessedRatherThanPassedEndToEnd(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceModeled)
	configureModeledEnsemble(t, &fixture, modeledTestContract(t), 2, 2*time.Second)
	configureSummaryStabilityTarget(t, &fixture, 2*time.Second)

	// The whole point: no ModelExecutor at all.
	fixture.worker.ModelExecutor = nil

	result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
	if err != nil {
		t.Fatal(err)
	}
	if result.Run == nil {
		t.Fatal("no run was recorded")
	}

	fixture.assurance.mu.Lock()
	defer fixture.assurance.mu.Unlock()
	extraction := summaryExtraction(t, fixture.assurance.extractions)
	// UNAVAILABLE is the property that matters, and it is asserted without
	// pinning WHICH unavailability. A worker with no executor is caught by the
	// generic modeled-analyzer-unavailable path before the summary assessment
	// runs at all, so the receipt says `modeled_analyzer_unavailable` rather than
	// `summary_stability_not_assessed`. That is correct and not worth forcing:
	// the entire modeled pipeline is absent, not merely the summariser, and a
	// summary-specific code would imply the rest of it ran.
	//
	// What must never vary is the outcome. Both roads end at "not measured", so
	// the assertions below are about the absence of a claim rather than about
	// which code carried it.
	if extraction.Status != campaignassurance.ExtractionUnavailable {
		t.Fatalf("an absent summariser produced extraction status %q, want unavailable: %+v",
			extraction.Status, extraction)
	}
	if extraction.ErrorCode == "" {
		t.Fatal("an unavailable extraction recorded no reason at all")
	}
	if extraction.ModelProvider != "not_invoked" {
		t.Fatalf("no executor was configured but the receipt names provider %q",
			extraction.ModelProvider)
	}
	if len(extraction.NormalizedExtraction) != 0 {
		t.Fatalf("an assessment that never ran produced a measurement: %s",
			extraction.NormalizedExtraction)
	}
	if bytesContainAll(extraction.EvidenceManifest, `"assessment_status":"pass"`) {
		t.Fatalf("an absent summariser reported a pass: %s", extraction.EvidenceManifest)
	}

	// Guard the guard, in the direction that actually costs something: a verdict
	// invented from zero answers. Neither a stable NOR an unstable claim may be
	// recorded, because both assert something was measured.
	for _, recorded := range fixture.assurance.findings {
		if recorded.Code == "SUMMARY_UNSTABLE" {
			t.Fatalf("a summariser that never ran was reported as unstable: %+v", recorded)
		}
	}
	if summaryRan := bytesContainAll(extraction.EvidenceManifest, `"answered":`); summaryRan {
		t.Fatalf("the receipt reports summarisation runs though no executor exists: %s",
			extraction.EvidenceManifest)
	}
}
