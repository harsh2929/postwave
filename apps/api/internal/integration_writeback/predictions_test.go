// SPDX-License-Identifier: AGPL-3.0-only
package integration_writeback

import "testing"

func ptrInt(v int) *int           { return &v }
func ptrFloat(v float64) *float64 { return &v }
func ptrStr(v string) *string     { return &v }

func TestAddPredictionTraits(t *testing.T) {
	traits := map[string]any{}
	addPredictionTraits(traits, predictionScan{
		predictedCLV:    ptrInt(124000),
		churnRisk:       ptrFloat(0.85),
		predictedOrders: ptrFloat(4.5),
		predictedGender: ptrStr("female"),
		rfmScore:        ptrStr("555"),
		rfmSegment:      ptrStr("champions"),
		recencyScore:    ptrInt(5),
		// historicCLV / totalCLV / frequency / monetary / expectedNextOrderAt left nil
	})
	if traits["_predicted_clv_cents"] != 124000 {
		t.Fatalf("clv = %v", traits["_predicted_clv_cents"])
	}
	if traits["_churn_risk"] != 0.85 {
		t.Fatalf("churn = %v", traits["_churn_risk"])
	}
	if traits["_predicted_order_count"] != 4.5 {
		t.Fatalf("orders = %v", traits["_predicted_order_count"])
	}
	if traits["_rfm_segment"] != "champions" || traits["_rfm_score"] != "555" || traits["_recency_score"] != 5 {
		t.Fatalf("rfm = %+v", traits)
	}
	// Absent predictions must NOT be written (so a missing score isn't pushed as 0).
	for _, k := range []string{"_historic_clv_cents", "_total_clv_cents", "_frequency_score", "_monetary_score", "_expected_next_order_at"} {
		if _, present := traits[k]; present {
			t.Fatalf("absent prediction %q must be skipped, got %v", k, traits[k])
		}
	}
}

// End-to-end mapping: a trait_field_map referencing a predicted-analytics key
// resolves to the right platform field value (rendered through stringifyTrait),
// proving predictions can be synced back to a platform.
func TestPredictionTraitMapsToPlatformField(t *testing.T) {
	traits := map[string]any{}
	addPredictionTraits(traits, predictionScan{
		predictedCLV: ptrInt(124000),
		churnRisk:    ptrFloat(0.85),
		rfmSegment:   ptrStr("champions"),
	})
	fields := resolveMemberFields(
		nil,
		map[string]string{
			"predicted_clv": "_predicted_clv_cents",
			"churn_risk":    "_churn_risk",
			"rfm_segment":   "_rfm_segment",
			"missing":       "_total_clv_cents", // absent -> not written
		},
		traits,
	)
	if fields["predicted_clv"] != "124000" {
		t.Fatalf("clv field = %q (whole-number int, not 124000.0)", fields["predicted_clv"])
	}
	if fields["churn_risk"] != "0.85" {
		t.Fatalf("churn field = %q", fields["churn_risk"])
	}
	if fields["rfm_segment"] != "champions" {
		t.Fatalf("rfm field = %q", fields["rfm_segment"])
	}
	if _, present := fields["missing"]; present {
		t.Fatalf("a member without that prediction must not get the field: %+v", fields)
	}
}
