// SPDX-License-Identifier: AGPL-3.0-only

package campaigncomprehension

import (
	"encoding/json"
	"math"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/factcontract"
)

func TestScoreV1ExactOutputsAndContradictionsRemainSeparate(t *testing.T) {
	contract := validContract(t)
	receipt := validReceipt(t)
	result := ScoreV1(ScenarioScoreInputV1{
		ScenarioID: "desktop_en_IN", Contract: contract,
		RequiredOutputIDs: []string{"model_b", "model_a"},
		Outputs: []AnalyzerOutputV1{
			{ConfigurationID: "model_a", Receipt: &receipt},
			{ConfigurationID: "model_b", Receipt: &receipt},
		},
	})
	if !result.Complete || result.Overall == nil || *result.Overall != 100 {
		t.Fatalf("complete score = %#v", result)
	}
	if dereference(result.Components.IntentFidelity) != 100 || dereference(result.Components.PrimaryAction) != 100 ||
		dereference(result.Components.EntityRecovery) != 100 || dereference(result.Components.AnalyzerRobustness) != 100 {
		t.Fatalf("components = %#v", result.Components)
	}
	if !result.HasContradictions || len(result.UnsupportedClaims) != 2 {
		t.Fatalf("unsupported claims must be explicit: %#v", result.UnsupportedClaims)
	}
	for _, claim := range result.UnsupportedClaims {
		if !claim.Contradiction || len(claim.ForbiddenClaimIDs) != 1 || claim.ForbiddenClaimIDs[0] != "guarantee" {
			t.Fatalf("claim result = %#v", claim)
		}
	}
	if len(result.PairwiseAgreement) != 1 || result.PairwiseAgreement[0].Agreement != 100 || result.Coverage.Ratio != 1 {
		t.Fatalf("robustness/coverage = %#v %#v", result.PairwiseAgreement, result.Coverage)
	}
}

func TestScoreV1AppliesPinnedWeightsEquivalenceAndPairwiseAgreement(t *testing.T) {
	contract := validContract(t)
	exact := validReceipt(t)
	mutatedExtraction := deepCloneExtraction(t, exact.Extraction)
	mutatedExtraction.PrimaryIntent.Value = "RESERVE A SEAT FOR THE WORKFLOW LAUNCH!"
	mutatedExtraction.PrimaryAction.Label = "RESERVE MY SEAT!"
	factByID(&mutatedExtraction, "deadline").Normalized = "2026-08-14T10:30:00Z"
	factByID(&mutatedExtraction, "deadline").Timezone = "UTC"
	factByID(&mutatedExtraction, "price").Normalized = "1599.5"
	factByID(&mutatedExtraction, "feature").Normalized = "workflow automation is included!"
	withoutCapacity := make([]ExtractedFact, 0, len(mutatedExtraction.Facts)-1)
	for _, fact := range mutatedExtraction.Facts {
		if fact.FactID != "capacity" {
			withoutCapacity = append(withoutCapacity, fact)
		}
	}
	mutatedExtraction.Facts = withoutCapacity
	mutated := receiptFromExtraction(t, mutatedExtraction)

	result := ScoreV1(ScenarioScoreInputV1{
		ScenarioID: "desktop_en_IN", Contract: contract,
		RequiredOutputIDs: []string{"model_a", "model_b"},
		Outputs:           []AnalyzerOutputV1{{ConfigurationID: "model_a", Receipt: &exact}, {ConfigurationID: "model_b", Receipt: &mutated}},
	})
	assertFloat(t, dereference(result.Components.IntentFidelity), 87.5)
	assertFloat(t, dereference(result.Components.PrimaryAction), 75)
	assertFloat(t, dereference(result.Components.EntityRecovery), 66.6667)
	assertFloat(t, dereference(result.Components.AnalyzerRobustness), 62.5)
	assertFloat(t, dereference(result.Overall), 73.5417)
	if result.Range == nil {
		t.Fatal("range missing")
	}
	assertFloat(t, result.Range.Min, 56.4583)
	assertFloat(t, result.Range.Max, 90.625)
	assertFloat(t, result.Range.Spread, 34.1667)
	assertFloat(t, dereference(result.Agreement), .625)

	wantMatches := map[factcontract.FactID]MatchClass{
		"deadline": MatchEquivalent, "price": MatchWrong, "feature": MatchEquivalent,
		"capacity": MatchMissing, "details_url": MatchExact,
	}
	for _, fact := range result.FactResults {
		if fact.ConfigurationID == "model_b" && wantMatches[fact.FactID] != fact.Match {
			t.Errorf("fact %s match = %s, want %s", fact.FactID, fact.Match, wantMatches[fact.FactID])
		}
	}
	if len(result.PairwiseAgreement) != 1 || result.PairwiseAgreement[0].ComparedItems != 8 || result.PairwiseAgreement[0].Agreement != 62.5 {
		t.Fatalf("pairwise = %#v", result.PairwiseAgreement)
	}
}

func TestScoreV1IsNullableForMissingFailedOrInvalidRequiredEvidence(t *testing.T) {
	contract := validContract(t)
	receipt := validReceipt(t)
	tests := []struct {
		name    string
		input   ScenarioScoreInputV1
		failure string
	}{
		{
			name: "missing", failure: "required_output_missing",
			input: ScenarioScoreInputV1{ScenarioID: "scenario", Contract: contract, RequiredOutputIDs: []string{"a", "b"}, Outputs: []AnalyzerOutputV1{{ConfigurationID: "a", Receipt: &receipt}}},
		},
		{
			name: "unavailable", failure: "required_output_unavailable",
			input: ScenarioScoreInputV1{ScenarioID: "scenario", Contract: contract, RequiredOutputIDs: []string{"a", "b"}, Outputs: []AnalyzerOutputV1{{ConfigurationID: "a", Receipt: &receipt}, {ConfigurationID: "b", FailureCode: "model_timeout"}}},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result := ScoreV1(test.input)
			if result.Complete || result.Overall != nil || !hasScoreFailure(result, test.failure) {
				t.Fatalf("score = %#v", result)
			}
			if dereference(result.Components.AnalyzerRobustness) != 0 {
				t.Fatalf("missing-output robustness = %v, want zero", dereference(result.Components.AnalyzerRobustness))
			}
		})
	}

	invalid := contract
	invalid.PrimaryAction.ActionID = ""
	result := ScoreV1(ScenarioScoreInputV1{ScenarioID: "scenario", Contract: invalid, RequiredOutputIDs: []string{"a", "b"}})
	if result.Overall != nil || len(result.ContractErrors) == 0 || !hasScoreFailure(result, "invalid_fact_contract") {
		t.Fatalf("invalid-contract score = %#v", result)
	}
}

func TestScoreV1RenormalizesInapplicableEntityRecovery(t *testing.T) {
	contract := validContract(t)
	contract.RequiredFacts = nil
	receipt := validReceipt(t)
	result := ScoreV1(ScenarioScoreInputV1{
		ScenarioID: "no_facts", Contract: contract, RequiredOutputIDs: []string{"a", "b"},
		Outputs: []AnalyzerOutputV1{{ConfigurationID: "a", Receipt: &receipt}, {ConfigurationID: "b", Receipt: &receipt}},
	})
	if !result.Complete || result.Overall == nil || *result.Overall != 100 || result.Components.EntityRecovery != nil {
		t.Fatalf("score = %#v", result)
	}
	// Two omissions now: this fixture declares no facts AND its extraction
	// carries no would_surface_in_digest, so surfaceability is unmeasurable too.
	// IntentFidelity is still .4 — the surfaceability weight was chosen to keep
	// the four original dimensions in their existing proportion, so adding a
	// dimension does not silently restate historical scores.
	if len(result.OmittedDimensions) != 2 ||
		result.OmittedDimensions[0] != "entity_recovery" ||
		result.OmittedDimensions[1] != "surfaceability" ||
		result.AppliedWeights.EntityRecovery != 0 ||
		result.AppliedWeights.Surfaceability != 0 ||
		result.AppliedWeights.IntentFidelity != .4 {
		t.Fatalf("renormalization = %#v omitted=%v", result.AppliedWeights, result.OmittedDimensions)
	}
	if len(result.UndeclaredFacts) != 10 {
		t.Fatalf("undeclared facts = %d, want 10 explicit results", len(result.UndeclaredFacts))
	}
}

func TestAggregateScenariosV1UsesWorstAndRequiresCoverage(t *testing.T) {
	first := ScenarioScoreV1{ScoreVersion: ScoreVersionV1, ScenarioID: "desktop", Complete: true, Overall: floatPointer(92), HasContradictions: true}
	second := ScenarioScoreV1{ScoreVersion: ScoreVersionV1, ScenarioID: "mobile", Complete: true, Overall: floatPointer(76)}
	aggregate := AggregateScenariosV1([]string{"mobile", "desktop"}, []ScenarioScoreV1{first, second})
	if !aggregate.Complete || dereference(aggregate.Worst) != 76 || dereference(aggregate.Mean) != 84 || !aggregate.HasContradictions {
		t.Fatalf("aggregate = %#v", aggregate)
	}
	if aggregate.Range == nil || aggregate.Range.Spread != 16 || len(aggregate.WorstScenarioIDs) != 1 || aggregate.WorstScenarioIDs[0] != "mobile" {
		t.Fatalf("aggregate range/worst ids = %#v %v", aggregate.Range, aggregate.WorstScenarioIDs)
	}
	incomplete := AggregateScenariosV1([]string{"mobile", "desktop", "dark_mode"}, []ScenarioScoreV1{first, second})
	if incomplete.Complete || incomplete.Worst != nil || incomplete.Mean != nil || incomplete.Coverage.Ratio != round6(2.0/3.0) {
		t.Fatalf("incomplete aggregate = %#v", incomplete)
	}
}

func validContract(t *testing.T) factcontract.ContractV1 {
	t.Helper()
	textFeature := "Workflow automation is included"
	detailsURL := "https://example.test/events/launch?seat=founder"
	contract := factcontract.ContractV1{
		SchemaVersion:   factcontract.SchemaVersionV1,
		PrimaryIntent:   factcontract.Intent{Kind: factcontract.IntentPromote, Statement: "Reserve a seat for the workflow launch"},
		AudienceContext: factcontract.Audience{Description: "Product founders"},
		CoreClaim:       factcontract.Claim{Statement: "Workflow automation launches on 14 August", SourceBlockIDs: []factcontract.BlockID{"blk_claim"}},
		PrimaryAction:   factcontract.PrimaryAction{ActionID: "reserve_seat", BlockID: "blk_cta", Role: factcontract.PrimaryActionRegister, Label: "Reserve my seat", CanonicalURL: detailsURL},
		RequiredFacts: []factcontract.RequiredFact{
			{ID: "deadline", Type: factcontract.FactTypeDateTime, DisplayValue: "14 August, 4 PM IST", Criticality: factcontract.CriticalityCritical, SourceBlockIDs: []factcontract.BlockID{"blk_deadline"}, DateTimeValue: &factcontract.DateTimeValue{RFC3339: "2026-08-14T16:00:00+05:30", Timezone: "Asia/Kolkata"}},
			{ID: "price", Type: factcontract.FactTypeMoney, DisplayValue: "₹1,499.50", Criticality: factcontract.CriticalityCritical, SourceBlockIDs: []factcontract.BlockID{"blk_price"}, MoneyValue: &factcontract.MoneyValue{Amount: "1499.5", Currency: "INR"}},
			{ID: "feature", Type: factcontract.FactTypeText, DisplayValue: textFeature, Criticality: factcontract.CriticalityImportant, SourceBlockIDs: []factcontract.BlockID{"blk_feature"}, TextValue: &textFeature},
			{ID: "capacity", Type: factcontract.FactTypeQuantity, DisplayValue: "100 seats", Criticality: factcontract.CriticalitySupporting, SourceBlockIDs: []factcontract.BlockID{"blk_capacity"}, NumberValue: &factcontract.NumberValue{Value: "100", Unit: "seats"}},
			{ID: "details_url", Type: factcontract.FactTypeURL, DisplayValue: "Event details", Criticality: factcontract.CriticalitySupporting, SourceBlockIDs: []factcontract.BlockID{"blk_cta"}, URLValue: &detailsURL},
		},
		ForbiddenClaims:         []factcontract.ForbiddenClaim{{ID: "guarantee", Statement: "Every customer is guaranteed to double revenue"}},
		AllowedSecondaryActions: []factcontract.SecondaryActionRole{factcontract.SecondaryActionUnsubscribe},
		Language:                "en-IN",
	}
	normalized, errs := factcontract.NormalizeAndValidateV1(contract)
	if len(errs) != 0 {
		t.Fatalf("test contract invalid: %v", errs)
	}
	return normalized
}

func validReceipt(t *testing.T) ExtractionReceiptV1 {
	t.Helper()
	raw, allowlist := validExtractionJSON(t)
	receipt, errs := DecodeAndNormalizeV1(raw, allowlist)
	if len(errs) != 0 {
		t.Fatalf("test extraction invalid: %v", errs)
	}
	return receipt
}

func receiptFromExtraction(t *testing.T, extraction ExtractionV1) ExtractionReceiptV1 {
	t.Helper()
	raw, err := json.Marshal(extraction)
	if err != nil {
		t.Fatal(err)
	}
	_, allowlist := validExtractionJSON(t)
	receipt, errs := DecodeAndNormalizeV1(raw, allowlist)
	if len(errs) != 0 {
		t.Fatalf("mutated extraction invalid: %v", errs)
	}
	return receipt
}

func hasScoreFailure(result ScenarioScoreV1, code string) bool {
	for _, failure := range result.Failures {
		if failure.Code == code {
			return true
		}
	}
	return false
}

func dereference(value *float64) float64 {
	if value == nil {
		return math.NaN()
	}
	return *value
}

func assertFloat(t *testing.T, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > .00001 {
		t.Fatalf("value = %.8f, want %.8f", got, want)
	}
}

func FuzzScoreV1TamperedReceipts(f *testing.F) {
	f.Add(uint8(0), "")
	f.Add(uint8(1), "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")
	f.Fuzz(func(t *testing.T, selector uint8, replacement string) {
		contract := validContract(t)
		receipt := validReceipt(t)
		switch selector % 4 {
		case 0:
			receipt.ReceiptHash = replacement
		case 1:
			receipt.NormalizationVersion = replacement
		case 2:
			receipt.Extraction.Summary = replacement
		case 3:
			receipt.CanonicalExtraction = json.RawMessage(replacement)
		}
		result := ScoreV1(ScenarioScoreInputV1{
			ScenarioID: "fuzz", Contract: contract, RequiredOutputIDs: []string{"a", "b"},
			Outputs: []AnalyzerOutputV1{{ConfigurationID: "a", Receipt: &receipt}, {ConfigurationID: "b", Receipt: &receipt}},
		})
		if len(VerifyExtractionReceiptV1(receipt)) != 0 && result.Overall != nil {
			t.Fatal("invalid receipt received a score")
		}
	})
}
