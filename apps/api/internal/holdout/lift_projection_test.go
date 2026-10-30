// SPDX-License-Identifier: AGPL-3.0-only

package holdout

import (
	"testing"
	"time"
)

func TestProjectLiftResultUsesFrozenPopulationAndEvidence(t *testing.T) {
	absolute := 0.02
	relative := 0.40
	incremental := 180.0
	low, high := 0.01, 0.03
	result := &LiftResult{
		ID: "result-1", CampaignID: "campaign-1",
		ResultVersion: LiftResultVersion, MethodologyVersion: LiftMethodologyVersion,
		Metric: "purchase", WindowStart: time.Unix(1_700_000_000, 0).UTC(),
		WindowEnd:  time.Unix(1_700_086_400, 0).UTC(),
		NTreatment: 9_000, NControl: 1_000,
		ConversionsTreatment: 630, ConversionsControl: 50,
		RateTreatment: 0.07, RateControl: 0.05, Status: "powered",
		AbsoluteLift: &absolute, RelativeLift: &relative,
		IncrementalConversions: &incremental, PValue: 0.001,
		CILow: &low, CIHigh: &high, MinimumDetectableEffect: 0.008,
		AssignmentSetSHA256:  "assignment-evidence",
		ConversionSetSHA256:  "conversion-evidence",
		EvidenceSHA256:       "result-evidence",
		MethodologyStatement: LiftMethodologyStatement,
	}

	got := projectLiftResult(10, result)
	if got["calculation_mode"] != "frozen_intent_to_treat" {
		t.Fatalf("calculation_mode = %v", got["calculation_mode"])
	}
	if _, exists := got["approximate"]; exists {
		t.Fatal("immutable projection must not carry the legacy approximation flag")
	}
	if got["held_out_subs"] != int64(1_000) || got["sent_subs"] != int64(9_000) {
		t.Fatalf("projection did not use frozen populations: %+v", got)
	}
	if got["held_out_conversions"] != int64(50) || got["sent_conversions"] != int64(630) {
		t.Fatalf("projection did not use frozen conversions: %+v", got)
	}
	if got["incremental_lift"] != absolute || got["lift_percent"] != relative {
		t.Fatalf("powered projection omitted estimate: %+v", got)
	}
}

func TestProjectLiftResultWithholdsEveryEstimateWhenUnderpowered(t *testing.T) {
	result := &LiftResult{
		ID: "result-2", CampaignID: "campaign-2",
		ResultVersion: LiftResultVersion, MethodologyVersion: LiftMethodologyVersion,
		Metric: "any_conversion", Status: "underpowered",
		NTreatment: 90, NControl: 10,
		ConversionsTreatment: 4, ConversionsControl: 0,
		UnderpoweredReason:   "control arm too small",
		MethodologyStatement: LiftMethodologyStatement,
	}

	got := projectLiftResult(10, result)
	for _, key := range []string{"incremental_lift", "lift_percent"} {
		if _, exists := got[key]; exists {
			t.Fatalf("underpowered projection exposed %s: %+v", key, got)
		}
	}
	significance, ok := got["significance"].(LiftSignificance)
	if !ok || significance.Powered || significance.AbsoluteLift != nil ||
		significance.RelativeLift != nil || significance.IncrementalConversions != nil {
		t.Fatalf("underpowered significance exposed an estimate: %#v", got["significance"])
	}
}
