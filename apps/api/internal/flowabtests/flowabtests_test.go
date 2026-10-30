// SPDX-License-Identifier: AGPL-3.0-only

package flowabtests

import (
	"testing"
	"time"
)

func TestEvaluateWinner_SignificantChallenger(t *testing.T) {
	// Control 10% vs challenger 30% at n=200 each → strongly significant.
	res := []VariantResult{
		{VariantID: "control", Assigned: 200, Converted: 20, ConversionRate: 0.10},
		{VariantID: "B", Assigned: 200, Converted: 60, ConversionRate: 0.30},
	}
	v := evaluateWinner(res, "control", time.Unix(0, 0))
	if v.VariantID != "B" {
		t.Fatalf("winner = %q, want B", v.VariantID)
	}
	if !v.Significant || v.Inconclusive {
		t.Fatalf("expected significant winner, got significant=%v inconclusive=%v p=%v", v.Significant, v.Inconclusive, v.PValue)
	}
	if v.PValue >= winnerSignificanceAlpha {
		t.Fatalf("p-value %v should be below alpha", v.PValue)
	}
}

func TestEvaluateWinner_NoSignificance_BestRateInconclusive(t *testing.T) {
	// Tiny sample, slight edge → not significant; verdict = best rate, inconclusive.
	res := []VariantResult{
		{VariantID: "control", Assigned: 10, Converted: 1, ConversionRate: 0.10},
		{VariantID: "B", Assigned: 10, Converted: 2, ConversionRate: 0.20},
	}
	v := evaluateWinner(res, "control", time.Unix(0, 0))
	if !v.Inconclusive || v.Significant {
		t.Fatalf("small sample should be inconclusive, got significant=%v", v.Significant)
	}
	if v.VariantID != "B" {
		t.Fatalf("inconclusive verdict should still report best rate (B), got %q", v.VariantID)
	}
}

func TestEvaluateWinner_ControlBest(t *testing.T) {
	res := []VariantResult{
		{VariantID: "control", Assigned: 200, Converted: 60, ConversionRate: 0.30},
		{VariantID: "B", Assigned: 200, Converted: 20, ConversionRate: 0.10},
	}
	v := evaluateWinner(res, "control", time.Unix(0, 0))
	if v.VariantID != "control" {
		t.Fatalf("control has the best rate; winner = %q", v.VariantID)
	}
	if v.Significant {
		t.Fatalf("control isn't a 'significant challenger' — should be inconclusive")
	}
}

func TestEvaluateWinner_Empty(t *testing.T) {
	v := evaluateWinner(nil, "control", time.Unix(0, 0))
	if !v.Inconclusive {
		t.Fatalf("no results should be inconclusive")
	}
}

// TestEvaluateWinner_ControlByConfigNotAlphabetical is the regression for the
// "Results orders by variant_id" bug: the control must be the CONFIGURED
// control id, even when it sorts after the challenger alphabetically.
func TestEvaluateWinner_ControlByConfigNotAlphabetical(t *testing.T) {
	// Results come back alphabetically: "challenger" before "original".
	res := []VariantResult{
		{VariantID: "challenger", Assigned: 200, Converted: 60, ConversionRate: 0.30}, // the real winner
		{VariantID: "original", Assigned: 200, Converted: 20, ConversionRate: 0.10},   // the configured control
	}
	v := evaluateWinner(res, "original", time.Unix(0, 0))
	if v.VariantID != "challenger" || !v.Significant {
		t.Fatalf("challenger should win vs the configured control 'original'; got %q significant=%v", v.VariantID, v.Significant)
	}
	// If we (wrongly) treated results[0] as control, "original" would be the
	// challenger and (10%<30%) it would never be flagged significant.
}

// TestEvaluateWinner_ZeroAssignmentControl is the regression for the degenerate
// p-value: a control with 0 assignments must NOT make a 1-of-1 challenger a
// "significant" winner.
func TestEvaluateWinner_ZeroAssignmentControl(t *testing.T) {
	res := []VariantResult{
		{VariantID: "control", Assigned: 0, Converted: 0, ConversionRate: 0},
		{VariantID: "B", Assigned: 1, Converted: 1, ConversionRate: 1.0},
	}
	v := evaluateWinner(res, "control", time.Unix(0, 0))
	if v.Significant {
		t.Fatalf("a 0-assignment control must not yield a significant winner on n=1")
	}
}
