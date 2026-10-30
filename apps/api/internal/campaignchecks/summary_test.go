// SPDX-License-Identifier: AGPL-3.0-only

package campaignchecks

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// A button made of pixels is a button a summariser cannot describe.
//
// Nothing flagged this before: no display property is set, the alt text is
// present and informative, and the anchor has a real destination, so every
// existing visibility, accessibility and parity check passes it. The only thing
// wrong with it is the thing F06 is about — the one action the message exists
// to prompt is unreadable to anything that cannot see.
func TestACallToActionOnlyInsideAnImageIsFlagged(t *testing.T) {
	t.Parallel()
	report := Analyze(imageButtonInput(t, ""))

	assertFindingCode(t, report, "CTA_ONLY_IN_IMAGE")
	finding := findingByCode(t, report, "CTA_ONLY_IN_IMAGE")
	if !finding.Blocking || !finding.Overridable {
		t.Errorf("image-only call to action is advisory: blocking=%t overridable=%t", finding.Blocking, finding.Overridable)
	}
	if finding.Dimension != DimensionPrimaryAction {
		t.Errorf("dimension = %q", finding.Dimension)
	}
	observed := decodeObserved(t, finding)
	if observed["scope"] != "every_actionable_link" {
		t.Errorf("scope = %v, want every_actionable_link", observed["scope"])
	}
	actions, _ := observed["image_only_actions"].([]any)
	if len(actions) != 1 {
		t.Fatalf("image_only_actions = %v; the finding names no anchor", observed["image_only_actions"])
	}
	first, _ := actions[0].(map[string]any)
	if first["canonical_url"] != "https://example.test/shop" {
		t.Errorf("finding does not name the destination: %v", first)
	}
}

// The same message with a readable button must not be flagged.
//
// This check runs over every campaign, so a false positive is an unappealable
// block on a legitimate send. The fixture differs from the one above by exactly
// one thing: the anchor contains words as well as the image.
//
// It has to contain the image too. A text-only anchor exercises nothing: with
// no image in the subtree the image-only slice stays empty whatever the
// suppression does, so the test would pass with the live-text rule deleted. The
// image is what makes this anchor a candidate, and the words are what must
// rescue it.
func TestALiveTextCallToActionIsNotFlagged(t *testing.T) {
	t.Parallel()
	const anchorOpen = `<a href="https://example.test/shop">` +
		`<img src="https://cdn.example.test/button.png" alt="Shop the sale">`
	body := func(anchorText string) string {
		return `<html><body><h1>Legacy update</h1>` + anchorOpen + anchorText + `</a></body></html>`
	}
	text := "Legacy update\n\nShop the sale: https://example.test/shop\n"

	// Guard the guard. The identical fixture with the words removed must be
	// flagged; if it is not, this anchor was never a candidate and the
	// assertion below would pass with the live-text rule deleted.
	assertFindingCode(t, Analyze(legacyCheckInput(t, body(""), text)), "CTA_ONLY_IN_IMAGE")

	report := Analyze(legacyCheckInput(t, body("Shop the sale"), text))
	assertNoFindingCode(t, report, "CTA_ONLY_IN_IMAGE")
}

// A footer link is not a call to action and must not rescue one.
//
// Almost every real campaign carries "Unsubscribe" and "View in browser". If
// those counted as live-text actions, this check would fire on nothing that
// ships, which is the quiet way a check stops existing. A summariser that reads
// this message and reports "unsubscribe" as its action has misrepresented it
// exactly as badly as one that reports no action at all.
func TestFooterBoilerplateDoesNotRescueAnImageOnlyCallToAction(t *testing.T) {
	t.Parallel()
	footer := `<a href="https://example.test/unsub">Unsubscribe from these emails</a>` +
		`<a href="https://example.test/browser">View in browser</a>` +
		`<a href="https://example.test/privacy">Privacy policy</a>`
	report := Analyze(imageButtonInput(t, footer))
	assertFindingCode(t, report, "CTA_ONLY_IN_IMAGE")
}

// A genuine text link anywhere in the message does rescue it.
//
// The other half of the boilerplate rule. Once a summariser has any real action
// it can read, this message's action is recoverable and F06 has no complaint.
func TestAnyRealTextLinkSuppressesTheImageOnlyFinding(t *testing.T) {
	t.Parallel()
	report := Analyze(imageButtonInput(t,
		`<a href="https://example.test/story">Read the full story</a>`))
	assertNoFindingCode(t, report, "CTA_ONLY_IN_IMAGE")
}

// A declared primary action is judged on its own, not on the message's links.
//
// When the artifact says which anchor is the call to action, a text link
// elsewhere does not make THAT action readable. This is the case
// PRIMARY_ACTION_IMAGE_ONLY only reaches when a Fact Contract is frozen; here
// there is none, and FACT_CONTRACT_UNAVAILABLE is an info finding.
func TestADeclaredPrimaryActionIsJudgedEvenWhenOtherTextLinksExist(t *testing.T) {
	t.Parallel()
	body := `<html><body><h1>Legacy update</h1>` +
		`<a href="https://example.test/shop" data-postwave-role="primary_action">` +
		`<img src="https://cdn.example.test/button.png" alt="Shop the sale"></a>` +
		`<a href="https://example.test/story">Read the full story</a></body></html>`
	report := Analyze(legacyCheckInput(t, body, "Legacy update\n\nShop the sale\n"))

	assertFindingCode(t, report, "CTA_ONLY_IN_IMAGE")
	assertNoFindingCode(t, report, "PRIMARY_ACTION_IMAGE_ONLY")
	observed := decodeObserved(t, findingByCode(t, report, "CTA_ONLY_IN_IMAGE"))
	if observed["scope"] != "declared_primary_action" {
		t.Errorf("scope = %v, want declared_primary_action", observed["scope"])
	}
}

// An anchor with neither words nor an image is not an image-only action.
//
// Empty anchors are ordinary tracking artifacts. Flagging one as "the call to
// action is in an image" would be a false statement about a message that has no
// image at all.
func TestAnEmptyAnchorIsNotReportedAsAnImageAction(t *testing.T) {
	t.Parallel()
	body := `<html><body><h1>Legacy update</h1>` +
		`<a href="https://example.test/pixel"></a></body></html>`
	report := Analyze(legacyCheckInput(t, body, "Legacy update\n"))
	assertNoFindingCode(t, report, "CTA_ONLY_IN_IMAGE")
}

// Eight identical answers are stable, and the assessment says so with numbers.
//
// The assertions are deliberately not just "status == pass": a runner that
// never ran would also produce no instability. Runs, answered, compared pairs
// and distinct values are all asserted at their non-trivial values, and the
// fake counts its own invocations, so an assessment that skipped the model
// cannot reach this line.
func TestEightIdenticalSummariesAreStable(t *testing.T) {
	t.Parallel()
	summarizer := &scriptedSummarizer{drafts: repeatDraft(SummaryDraft{
		OneLineSummary: "Workflow Live opens registration for existing customers next Thursday",
		PrimaryIntent:  "event_invite",
		PrimaryAction:  "Reserve my seat",
	}, SummaryRunCount)}

	result := AssessSummaryStability(context.Background(), validCheckInput(t, false, ""), summarizer)

	if result.Status != AssessmentPass {
		t.Fatalf("status = %q, want pass; findings=%s", result.Status, prettyJSON(result.Findings))
	}
	assertNoStabilityFinding(t, result, "SUMMARY_UNSTABLE")
	if summarizer.calls != SummaryRunCount {
		t.Fatalf("summariser was called %d times, want %d", summarizer.calls, SummaryRunCount)
	}
	if result.Variance == nil {
		t.Fatal("a pass carries no variance; the PRD requires the spread with every score")
	}
	variance := *result.Variance
	if variance.Runs != SummaryRunCount || variance.Answered != SummaryRunCount || variance.Failed != 0 {
		t.Errorf("variance run accounting = %+v", variance)
	}
	if variance.ComparedPairs != SummaryRunCount*(SummaryRunCount-1)/2 {
		t.Errorf("compared pairs = %d, want 28", variance.ComparedPairs)
	}
	if variance.DistinctSummaries != 1 || variance.DistinctIntents != 1 || variance.DistinctActions != 1 {
		t.Errorf("identical drafts produced distinct values: %+v", variance)
	}
	if variance.SummaryAgreement != 1 || variance.IntentAgreement != 1 || variance.ActionAgreement != 1 {
		t.Errorf("identical drafts did not agree: %+v", variance)
	}
	if len(variance.UnstableDimension) != 0 {
		t.Errorf("unstable dimensions on identical drafts: %v", variance.UnstableDimension)
	}
	if len(variance.RunAgreement) != SummaryRunCount {
		t.Errorf("run agreement = %v; the per-run spread was not computed", variance.RunAgreement)
	}
	if variance.MinRunAgreement != 1 || variance.MaxRunAgreement != 1 || variance.AgreementSpread != 0 {
		t.Errorf("identical drafts produced a spread: %+v", variance)
	}
	if result.Capability.ID != "agent_summary" || result.Capability.Status != CapabilityProvided {
		t.Errorf("capability = %+v", result.Capability)
	}
}

// Eight materially different answers are unstable and must be reported.
//
// This is the failure the PRD calls out as more dangerous than a low score: a
// campaign that scores 90 on one run and 40 on the next cannot be relied on at
// all. Every dimension diverges here, and all three must be named.
func TestEightDivergentSummariesAreReportedUnstable(t *testing.T) {
	t.Parallel()
	summarizer := &scriptedSummarizer{drafts: divergentDrafts()}

	result := AssessSummaryStability(context.Background(), validCheckInput(t, false, ""), summarizer)

	if result.Status != AssessmentFail {
		t.Fatalf("status = %q, want fail", result.Status)
	}
	if summarizer.calls != SummaryRunCount {
		t.Fatalf("summariser was called %d times, want %d", summarizer.calls, SummaryRunCount)
	}
	finding := stabilityFinding(t, result, "SUMMARY_UNSTABLE")
	if !finding.Blocking || finding.Dimension != DimensionAgentComprehension {
		t.Errorf("finding policy = blocking:%t dimension:%q", finding.Blocking, finding.Dimension)
	}
	if result.Variance == nil {
		t.Fatal("instability reported with no variance")
	}
	variance := *result.Variance
	if variance.Answered != SummaryRunCount || variance.ComparedPairs != 28 {
		t.Fatalf("variance was computed over the wrong sample: %+v", variance)
	}
	if variance.DistinctSummaries != SummaryRunCount {
		t.Errorf("distinct summaries = %d, want %d", variance.DistinctSummaries, SummaryRunCount)
	}
	if variance.SummaryAgreement >= summaryTextAgreementFloor ||
		variance.IntentAgreement >= summaryIntentAgreementFloor ||
		variance.ActionAgreement >= summaryActionAgreementFloor {
		t.Fatalf("divergent drafts scored as agreeing: %+v", variance)
	}
	assertUnstableDimensions(t, variance, "one_line_summary", "primary_intent", "primary_action")

	// The finding must carry the spread, not just the verdict.
	observed := decodeObserved(t, finding)
	if observed["compared_pairs"] != float64(28) || observed["runs"] != float64(SummaryRunCount) {
		t.Errorf("finding does not surface the run set: %v", observed)
	}
	if _, present := observed["action_agreement"]; !present {
		t.Errorf("finding does not surface per-dimension agreement: %v", observed)
	}
	// Model output is derived from artifact content and is never echoed.
	if bytesContain(finding.ObservedValue, "Reserve my seat") {
		t.Errorf("model draft text was echoed into the finding: %s", finding.ObservedValue)
	}
	if len(result.Drafts) != SummaryRunCount {
		t.Errorf("drafts = %d; the caller cannot see the evidence", len(result.Drafts))
	}
}

// One unstable dimension is enough, and is named on its own.
//
// Half the runs say "Reserve my seat" and half say "Unsubscribe" while the
// summary sentence and the intent are word-for-word identical. A single
// weighted mean would put this comfortably in the pass band; half the audience
// would still be told the wrong thing by their assistant.
func TestOneUnstableDimensionIsNotAveragedAway(t *testing.T) {
	t.Parallel()
	drafts := make([]SummaryDraft, 0, SummaryRunCount)
	for run := 0; run < SummaryRunCount; run++ {
		action := "Reserve my seat"
		if run%2 == 1 {
			action = "Unsubscribe from these emails"
		}
		drafts = append(drafts, SummaryDraft{
			OneLineSummary: "Workflow Live opens registration for existing customers next Thursday",
			PrimaryIntent:  "event_invite",
			PrimaryAction:  action,
		})
	}
	summarizer := &scriptedSummarizer{drafts: drafts}

	result := AssessSummaryStability(context.Background(), validCheckInput(t, false, ""), summarizer)

	if result.Status != AssessmentFail {
		t.Fatalf("status = %q, want fail", result.Status)
	}
	stabilityFinding(t, result, "SUMMARY_UNSTABLE")
	variance := *result.Variance
	if variance.SummaryAgreement != 1 || variance.IntentAgreement != 1 {
		t.Fatalf("the stable dimensions were not stable: %+v", variance)
	}
	assertUnstableDimensions(t, variance, "primary_action")
	if variance.DistinctActions != 2 {
		t.Errorf("distinct actions = %d, want 2", variance.DistinctActions)
	}
}

// Paraphrase is not instability.
//
// Two faithful runs legitimately choose different words. If reworded summaries
// failed, this check would fire on every campaign and be turned off, which is
// the same as not having it.
func TestParaphrasedSummariesAreNotReportedUnstable(t *testing.T) {
	t.Parallel()
	drafts := []SummaryDraft{
		{OneLineSummary: "Workflow Live opens registration for existing customers next Thursday", PrimaryIntent: "event_invite", PrimaryAction: "Reserve my seat"},
		{OneLineSummary: "Workflow Live registration opens next Thursday for existing customers", PrimaryIntent: "event_invite", PrimaryAction: "Reserve my seat"},
		{OneLineSummary: "Registration for Workflow Live opens Thursday for existing customers", PrimaryIntent: "event_invite", PrimaryAction: "Reserve my seat"},
		{OneLineSummary: "Existing customers can register for Workflow Live from next Thursday", PrimaryIntent: "event_invite", PrimaryAction: "Reserve my seat"},
	}
	for len(drafts) < SummaryRunCount {
		drafts = append(drafts, drafts[len(drafts)%4])
	}
	result := AssessSummaryStability(context.Background(), validCheckInput(t, false, ""),
		&scriptedSummarizer{drafts: drafts})

	if result.Status != AssessmentPass {
		t.Fatalf("status = %q, want pass; variance=%+v", result.Status, result.Variance)
	}
	assertNoStabilityFinding(t, result, "SUMMARY_UNSTABLE")
}

// The mean can say "stable" while one run is about a different message.
//
// Seven runs are word-for-word identical and the eighth shares no content word
// with them, though it names the same intent and the same action. Every floor
// is cleared and the campaign passes — correctly, because the action a
// recipient is told to take never wavers. What must NOT happen is the outlier
// disappearing: the PRD asks for the spread precisely so a customer can see the
// one run that would have embarrassed them.
func TestTheSpreadSurvivesAMeanThatSaysStable(t *testing.T) {
	t.Parallel()
	steady := SummaryDraft{
		OneLineSummary: "Workflow Live opens registration for existing customers next Thursday",
		PrimaryIntent:  "event_invite", PrimaryAction: "Reserve my seat",
	}
	drafts := repeatDraft(steady, SummaryRunCount-1)
	drafts = append(drafts, SummaryDraft{
		OneLineSummary: "Quarterly billing summary attached",
		PrimaryIntent:  "event_invite", PrimaryAction: "Reserve my seat",
	})

	result := AssessSummaryStability(context.Background(), validCheckInput(t, false, ""),
		&scriptedSummarizer{drafts: drafts})

	if result.Status != AssessmentPass {
		t.Fatalf("status = %q, want pass; variance=%+v", result.Status, result.Variance)
	}
	variance := *result.Variance
	if len(variance.RunAgreement) != SummaryRunCount {
		t.Fatalf("run agreement = %v", variance.RunAgreement)
	}
	if variance.AgreementSpread <= 0 {
		t.Fatalf("the outlier vanished into the mean: %+v", variance)
	}
	if variance.MinRunAgreement >= variance.MaxRunAgreement {
		t.Fatalf("min/max run agreement = %v/%v", variance.MinRunAgreement, variance.MaxRunAgreement)
	}
	// The odd run is last, and it must be the one with the lowest agreement.
	lowest := variance.RunAgreement[SummaryRunCount-1]
	for _, agreement := range variance.RunAgreement[:SummaryRunCount-1] {
		if lowest >= agreement {
			t.Fatalf("the outlier is not the least agreeing run: %v", variance.RunAgreement)
		}
	}
}

// No summariser is not a pass.
//
// This is the whole reason the status is tri-state. An absent measurement
// reported as a passing measurement converts an unknown into a certificate,
// and a certificate is what the customer acts on.
func TestAnAbsentSummariserIsNotAPass(t *testing.T) {
	t.Parallel()
	result := AssessSummaryStability(context.Background(), validCheckInput(t, false, ""), nil)

	if result.Status != AssessmentNotAssessed {
		t.Fatalf("status = %q, want not_assessed", result.Status)
	}
	if result.Status == AssessmentPass {
		t.Fatal("an unassessed message was certified")
	}
	finding := stabilityFinding(t, result, "SUMMARY_STABILITY_NOT_ASSESSED")
	if finding.Dimension != DimensionAgentComprehension {
		t.Errorf("dimension = %q", finding.Dimension)
	}
	observed := decodeObserved(t, finding)
	if observed["assessed"] != false || observed["reason"] != "no_summariser_injected" {
		t.Errorf("the finding does not say why it was not assessed: %v", observed)
	}
	if result.Capability.Status != CapabilityUnavailable || result.Capability.ID != "agent_summary" {
		t.Errorf("capability = %+v; an unassessed run claimed a capability", result.Capability)
	}
	if result.Variance != nil {
		t.Errorf("variance reported with no runs: %+v", result.Variance)
	}
}

// A summariser that fails every run is not a pass either.
//
// Eight errors produce no disagreement at all, which is exactly what perfect
// stability looks like to anything counting divergence.
func TestASummariserThatFailsEveryRunIsNotAPass(t *testing.T) {
	t.Parallel()
	summarizer := &scriptedSummarizer{failEvery: true}
	result := AssessSummaryStability(context.Background(), validCheckInput(t, false, ""), summarizer)

	if result.Status != AssessmentNotAssessed {
		t.Fatalf("status = %q, want not_assessed", result.Status)
	}
	stabilityFinding(t, result, "SUMMARY_STABILITY_NOT_ASSESSED")
	if summarizer.calls != SummaryRunCount {
		t.Errorf("calls = %d, want %d", summarizer.calls, SummaryRunCount)
	}
	if result.Variance == nil || result.Variance.Failed != SummaryRunCount || result.Variance.Answered != 0 {
		t.Errorf("variance = %+v; the failed runs were not accounted for", result.Variance)
	}
}

// A draft with no summary is a failed run, not an agreeing answer.
//
// Eight empty answers agree with each other completely. Counting them would
// turn a summariser that says nothing into the most stable campaign in the
// system.
func TestEmptyDraftsAreFailedRunsRatherThanAgreement(t *testing.T) {
	t.Parallel()
	result := AssessSummaryStability(context.Background(), validCheckInput(t, false, ""),
		&scriptedSummarizer{drafts: repeatDraft(SummaryDraft{PrimaryIntent: "other"}, SummaryRunCount)})

	if result.Status == AssessmentPass {
		t.Fatalf("eight empty summaries were certified as stable: %+v", result.Variance)
	}
	if result.Variance == nil || result.Variance.Answered != 0 {
		t.Fatalf("empty drafts were counted as answers: %+v", result.Variance)
	}
}

// Agreement across a partial run set cannot pass, but divergence can still fail.
//
// The asymmetry is the point. Observed divergence is evidence on its own;
// observed agreement over the runs that happened to answer is not evidence
// about the runs that did not.
func TestPartialRunSetsPassNeverButFailStill(t *testing.T) {
	t.Parallel()
	input := validCheckInput(t, false, "")
	identical := SummaryDraft{
		OneLineSummary: "Workflow Live opens registration for existing customers next Thursday",
		PrimaryIntent:  "event_invite", PrimaryAction: "Reserve my seat",
	}

	agreeing := AssessSummaryStability(context.Background(), input,
		&scriptedSummarizer{drafts: repeatDraft(identical, 6), failAfter: 6})
	if agreeing.Status != AssessmentNotAssessed {
		t.Fatalf("six agreeing runs out of eight = %q, want not_assessed", agreeing.Status)
	}
	if agreeing.Variance == nil || agreeing.Variance.Answered != 6 || agreeing.Variance.Failed != 2 {
		t.Fatalf("partial variance = %+v", agreeing.Variance)
	}
	stabilityFinding(t, agreeing, "SUMMARY_STABILITY_NOT_ASSESSED")

	diverging := AssessSummaryStability(context.Background(), input,
		&scriptedSummarizer{drafts: divergentDrafts()[:4], failAfter: 4})
	if diverging.Status != AssessmentFail {
		t.Fatalf("four divergent runs out of eight = %q, want fail", diverging.Status)
	}
	stabilityFinding(t, diverging, "SUMMARY_UNSTABLE")
}

// The production summariser accepts only the frozen schema.
//
// This is the real parser, not the test fake: NewJSONSummarizer is what a
// composition root injects. A lenient parser here would invent a draft out of
// a model's apology and feed it into the stability arithmetic as an answer.
func TestTheProductionSummariserAcceptsOnlyTheFrozenSchema(t *testing.T) {
	t.Parallel()
	var seen string
	summarizer := NewJSONSummarizer(func(_ context.Context, prompt string) (string, error) {
		seen = prompt
		return `{"one_line_summary":"Workflow Live opens registration","primary_intent":"event_invite","primary_action":"Reserve my seat"}`, nil
	})

	draft, err := summarizer.Summarize(context.Background(), SummaryRequest{
		Run: 1, RunCount: SummaryRunCount, PromptVersion: SummaryPromptVersionV1,
		Subject: "Workflow Live", PlainText: "Reserve my seat: https://example.test/register",
		HTML: "<p>Reserve my seat</p>",
	})
	if err != nil {
		t.Fatalf("valid frozen-schema output rejected: %v", err)
	}
	if draft.PrimaryAction != "Reserve my seat" || draft.PrimaryIntent != "event_invite" {
		t.Fatalf("draft = %+v", draft)
	}
	for _, required := range []string{SummaryPromptVersionV1, "Workflow Live", "https://example.test/register", "one_line_summary"} {
		if !strings.Contains(seen, required) {
			t.Errorf("the production prompt omits %q", required)
		}
	}

	for name, raw := range map[string]string{
		"prose":          "Sure! Here is the summary you asked for.",
		"fenced":         "```json\n{\"one_line_summary\":\"x\",\"primary_intent\":\"other\",\"primary_action\":\"\"}\n```",
		"unknown field":  `{"one_line_summary":"x","primary_intent":"other","primary_action":"","confidence":0.9}`,
		"trailing":       `{"one_line_summary":"x","primary_intent":"other","primary_action":""}{"one_line_summary":"y"}`,
		"empty summary":  `{"one_line_summary":"   ","primary_intent":"other","primary_action":""}`,
		"empty response": "",
	} {
		if _, err := decodeSummaryDraft(raw); err == nil {
			t.Errorf("%s output was accepted as a draft", name)
		}
	}
}

// A configured-but-inert model call is not a pass.
//
// NewJSONSummarizer(nil) is a non-nil Summarizer, so the nil check above cannot
// catch it. Every run must fail loudly rather than return a zero draft.
func TestAProductionSummariserWithNoModelCallCannotPass(t *testing.T) {
	t.Parallel()
	result := AssessSummaryStability(context.Background(), validCheckInput(t, false, ""), NewJSONSummarizer(nil))
	if result.Status != AssessmentNotAssessed {
		t.Fatalf("status = %q, want not_assessed", result.Status)
	}
	if result.Variance == nil || result.Variance.Failed != SummaryRunCount {
		t.Fatalf("variance = %+v", result.Variance)
	}
}

// An over-limit artifact is not summarised at all.
//
// Truncating a message, summarising the fragment eight times and reporting the
// agreement as this message's stability would be a confident statement about a
// message nobody is sending.
func TestAnOverLimitArtifactIsNotSummarised(t *testing.T) {
	t.Parallel()
	input := validCheckInput(t, false, "")
	input.Compilation.HTML = strings.Repeat("x", MaxSummaryInputBytes+1)
	summarizer := &scriptedSummarizer{drafts: repeatDraft(SummaryDraft{
		OneLineSummary: "anything at all", PrimaryIntent: "other",
	}, SummaryRunCount)}

	result := AssessSummaryStability(context.Background(), input, summarizer)

	if result.Status != AssessmentNotAssessed {
		t.Fatalf("status = %q, want not_assessed", result.Status)
	}
	if summarizer.calls != 0 {
		t.Fatalf("an over-limit artifact was sent to the model %d times", summarizer.calls)
	}
	observed := decodeObserved(t, stabilityFinding(t, result, "SUMMARY_STABILITY_NOT_ASSESSED"))
	if observed["reason"] != "artifact_exceeds_summarisation_bounds" {
		t.Errorf("reason = %v", observed["reason"])
	}
}

// The summariser is handed the compiled message, not the content model.
//
// The PRD is explicit that F06 tests what actually goes out. A request built
// from the internal tree would score a message that no recipient receives.
func TestTheSummariserSeesTheCompiledArtifact(t *testing.T) {
	t.Parallel()
	input := validCheckInput(t, false, "")
	summarizer := &scriptedSummarizer{drafts: repeatDraft(SummaryDraft{
		OneLineSummary: "Workflow Live opens registration", PrimaryIntent: "event_invite",
		PrimaryAction: "Reserve my seat",
	}, SummaryRunCount)}

	AssessSummaryStability(context.Background(), input, summarizer)

	if len(summarizer.requests) != SummaryRunCount {
		t.Fatalf("requests = %d", len(summarizer.requests))
	}
	for index, request := range summarizer.requests {
		if request.Run != index+1 || request.RunCount != SummaryRunCount {
			t.Fatalf("run %d carried Run=%d RunCount=%d", index, request.Run, request.RunCount)
		}
		if request.PlainText != input.Compilation.Text || request.HTML != input.Compilation.HTML {
			t.Fatalf("run %d was not given the compiled representations", index)
		}
		if request.ArtifactSHA256 != input.Compilation.Artifact.OutboundMIMEHash {
			t.Fatalf("run %d was not bound to the frozen artifact", index)
		}
	}
}

// --- fixtures and helpers ---

// scriptedSummarizer is the deterministic fake. It counts its own calls so a
// test cannot pass by never reaching the model.
type scriptedSummarizer struct {
	drafts    []SummaryDraft
	failEvery bool
	failAfter int
	calls     int
	requests  []SummaryRequest
}

func (s *scriptedSummarizer) Summarize(_ context.Context, request SummaryRequest) (SummaryDraft, error) {
	s.calls++
	s.requests = append(s.requests, request)
	if s.failEvery || (s.failAfter > 0 && s.calls > s.failAfter) || s.calls > len(s.drafts) {
		return SummaryDraft{}, fmt.Errorf("scripted failure on run %d", s.calls)
	}
	return s.drafts[s.calls-1], nil
}

func repeatDraft(draft SummaryDraft, count int) []SummaryDraft {
	drafts := make([]SummaryDraft, 0, count)
	for i := 0; i < count; i++ {
		drafts = append(drafts, draft)
	}
	return drafts
}

// divergentDrafts are eight answers that share no content words, no intent and
// no action — the "90 on one run, 40 on the next" campaign the PRD warns about.
func divergentDrafts() []SummaryDraft {
	return []SummaryDraft{
		{OneLineSummary: "Workflow Live opens registration next Thursday", PrimaryIntent: "event_invite", PrimaryAction: "Reserve my seat"},
		{OneLineSummary: "Twenty percent discount code inside", PrimaryIntent: "offer", PrimaryAction: "Apply SAVE20"},
		{OneLineSummary: "Your invoice is ready to download", PrimaryIntent: "transactional", PrimaryAction: "Download invoice"},
		{OneLineSummary: "August product roundup from the team", PrimaryIntent: "newsletter", PrimaryAction: "Browse updates"},
		{OneLineSummary: "Leadership changes announced today", PrimaryIntent: "announcement", PrimaryAction: "Read statement"},
		{OneLineSummary: "Nothing specific; marketing message", PrimaryIntent: "other", PrimaryAction: ""},
		{OneLineSummary: "Webinar recording now available online", PrimaryIntent: "announcement", PrimaryAction: "Watch recording"},
		{OneLineSummary: "Renew before billing lapses", PrimaryIntent: "transactional", PrimaryAction: "Renew subscription"},
	}
}

// imageButtonInput is a legacy campaign whose only button is a picture.
func imageButtonInput(t *testing.T, extraLinks string) Input {
	t.Helper()
	body := `<html><body><h1>Legacy update</h1>` +
		`<a href="https://example.test/shop">` +
		`<img src="https://cdn.example.test/button.png" alt="Shop the sale"></a>` +
		extraLinks + `</body></html>`
	return legacyCheckInput(t, body, "Legacy update\n\nShop the sale\n")
}

func stabilityFinding(t *testing.T, result SummaryStabilityV1, code string) Finding {
	t.Helper()
	for _, finding := range result.Findings {
		if finding.Code == code {
			return finding
		}
	}
	t.Fatalf("missing finding %s; got %s", code, prettyJSON(result.Findings))
	return Finding{}
}

func assertNoStabilityFinding(t *testing.T, result SummaryStabilityV1, code string) {
	t.Helper()
	for _, finding := range result.Findings {
		if finding.Code == code {
			t.Fatalf("unexpected finding %s: %+v", code, finding)
		}
	}
}

func assertUnstableDimensions(t *testing.T, variance SummaryVarianceV1, want ...string) {
	t.Helper()
	if len(variance.UnstableDimension) != len(want) {
		t.Fatalf("unstable dimensions = %v, want %v", variance.UnstableDimension, want)
	}
	for index, dimension := range want {
		if variance.UnstableDimension[index] != dimension {
			t.Fatalf("unstable dimensions = %v, want %v", variance.UnstableDimension, want)
		}
	}
}

func decodeObserved(t *testing.T, finding Finding) map[string]any {
	t.Helper()
	observed := map[string]any{}
	if err := json.Unmarshal(finding.ObservedValue, &observed); err != nil {
		t.Fatalf("observed value is not an object: %s", finding.ObservedValue)
	}
	return observed
}

func bytesContain(raw json.RawMessage, needle string) bool {
	return strings.Contains(string(raw), needle)
}
