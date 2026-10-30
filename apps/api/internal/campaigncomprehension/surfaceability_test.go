// SPDX-License-Identifier: AGPL-3.0-only

package campaigncomprehension

import "testing"

func boolPointer(v bool) *bool { return &v }

// receiptWithSurfacing builds a receipt whose canonical hash matches its
// extraction, with would_surface_in_digest set.
func receiptWithSurfacing(t *testing.T, surfaces bool) ExtractionReceiptV1 {
	t.Helper()
	base := validReceipt(t)
	extraction := base.Extraction
	extraction.WouldSurfaceInDigest = boolPointer(surfaces)
	return receiptFromExtraction(t, extraction)
}

// Surfaceability is the share of runs that said the message would be mentioned.
//
// It is the PRD's first dimension and the one the whole feature is named for: a
// message can be delivered, land in the inbox, and still be invisible because
// the summariser did not consider it worth mentioning. Every other dimension
// measures how WELL the message was understood; this one measures whether it
// was seen at all.
func TestSurfaceabilityIsTheShareOfRunsThatWouldSurface(t *testing.T) {
	contract := validContract(t)
	// Rebuilt through receiptFromExtraction, not mutated in place: the receipt
	// carries a hash of its canonical extraction, so editing the struct after
	// decoding makes the output fail integrity checking and never reach scoring.
	// That check is correct and worth working with rather than around.
	surfaced := receiptWithSurfacing(t, true)
	buried := receiptWithSurfacing(t, false)

	result := ScoreV1(ScenarioScoreInputV1{
		ScenarioID: "surfaceability", Contract: contract,
		RequiredOutputIDs: []string{"a", "b", "c", "d"},
		Outputs: []AnalyzerOutputV1{
			{ConfigurationID: "a", Receipt: &surfaced},
			{ConfigurationID: "b", Receipt: &surfaced},
			{ConfigurationID: "c", Receipt: &surfaced},
			{ConfigurationID: "d", Receipt: &buried},
		},
	})

	if result.Components.Surfaceability == nil {
		t.Fatal("surfaceability was not computed although every run answered")
	}
	if *result.Components.Surfaceability != 75 {
		t.Fatalf("surfaceability = %v, want 75 (3 of 4 runs)", *result.Components.Surfaceability)
	}
	for _, omitted := range result.OmittedDimensions {
		if omitted == "surfaceability" {
			t.Error("surfaceability was reported as omitted although runs answered it")
		}
	}
}

// A run that did not answer is not a "no".
//
// Counting silence as "would not surface" would depress every campaign scored
// by an analyzer that predates the field, and would state — on no evidence —
// that no assistant would ever mention the message.
func TestAnUnansweredRunIsNotCountedAsInvisible(t *testing.T) {
	contract := validContract(t)
	surfaced := receiptWithSurfacing(t, true)
	silent := validReceipt(t) // WouldSurfaceInDigest stays nil

	result := ScoreV1(ScenarioScoreInputV1{
		ScenarioID: "partial", Contract: contract,
		RequiredOutputIDs: []string{"a", "b"},
		Outputs: []AnalyzerOutputV1{
			{ConfigurationID: "a", Receipt: &surfaced},
			{ConfigurationID: "b", Receipt: &silent},
		},
	})

	if result.Components.Surfaceability == nil {
		t.Fatal("surfaceability was dropped although one run answered")
	}
	if *result.Components.Surfaceability != 100 {
		t.Fatalf("surfaceability = %v, want 100 — the silent run must be excluded "+
			"from the denominator, not counted as invisible",
			*result.Components.Surfaceability)
	}
}

// No answers at all means unknown, not zero.
func TestNoAnswersLeavesSurfaceabilityUnknown(t *testing.T) {
	contract := validContract(t)
	silent := validReceipt(t)

	result := ScoreV1(ScenarioScoreInputV1{
		ScenarioID: "silent", Contract: contract,
		RequiredOutputIDs: []string{"a", "b"},
		Outputs: []AnalyzerOutputV1{
			{ConfigurationID: "a", Receipt: &silent},
			{ConfigurationID: "b", Receipt: &silent},
		},
	})

	if result.Components.Surfaceability != nil {
		t.Fatalf("surfaceability = %v with no answers; 0 would read as 'no "+
			"assistant would ever mention this'", *result.Components.Surfaceability)
	}
	if result.AppliedWeights.Surfaceability != 0 {
		t.Error("an unmeasurable dimension still carries weight in the overall score")
	}
}
