// SPDX-License-Identifier: AGPL-3.0-only
package predictive

import (
	"testing"
)

func TestPredictBatchBGNBD_BelowThresholdKeepsHeuristic(t *testing.T) {
	signals := makeSignals(10) // < MinCustomersForBGNBD → no fit
	preds, fit := PredictBatchBGNBD(signals, bgnbdNow)
	if len(preds) != len(signals) {
		t.Fatalf("got %d predictions, want %d", len(preds), len(signals))
	}
	if reason := fit.FallbackReason(); reason != BGNBDFallbackTooFewCustomers {
		t.Errorf("fallback reason = %q (%v), want %q", reason, fit.Err, BGNBDFallbackTooFewCustomers)
	}
	for i, p := range preds {
		if p.Explanation["model"] != "heuristic-v1" {
			t.Errorf("pred %d model = %v, want heuristic-v1 (no fit below threshold)", i, p.Explanation["model"])
		}
		// Must equal the untouched per-customer heuristic.
		want := ComputePrediction(signals[i], bgnbdNow)
		if p.PredictedOrderCount != want.PredictedOrderCount || p.PredictedCLVCents != want.PredictedCLVCents {
			t.Errorf("pred %d diverged from heuristic: got orders=%v clv=%d, want orders=%v clv=%d",
				i, p.PredictedOrderCount, p.PredictedCLVCents, want.PredictedOrderCount, want.PredictedCLVCents)
		}
	}
}

func TestPredictBatchBGNBD_AboveThresholdUsesModel(t *testing.T) {
	signals := makeSignals(200)
	want := FitTenantBGNBD(signals, bgnbdNow)
	if !want.Fitted() {
		t.Fatalf("200 customers should fit; test precondition failed: %v", want.Err)
	}
	params := want.Params
	preds, fit := PredictBatchBGNBD(signals, bgnbdNow)
	if !fit.Fitted() || fit.Params != params || fit.Customers != len(signals) || fit.FallbackReason() != "" {
		t.Fatalf("PredictBatchBGNBD reported fit %+v (reason %q), want FitTenantBGNBD's %+v with no fallback",
			fit, fit.FallbackReason(), want)
	}

	bgnbdCount := 0
	for i, p := range signals {
		f, ok := BGNBDForecastFor(params, p, bgnbdNow, DefaultCLVHorizonWeeks)
		if !ok {
			continue // unscorable customer falls back; skip
		}
		got := preds[i]
		if got.Explanation["model"] != "bgnbd-v1" {
			t.Errorf("scorable pred %d model = %v, want bgnbd-v1", i, got.Explanation["model"])
			continue
		}
		if got.PredictedOrderCount != f.PredictedOrders {
			t.Errorf("pred %d predicted orders = %v, want model's %v", i, got.PredictedOrderCount, f.PredictedOrders)
		}
		if got.TotalCLVCents != got.HistoricCLVCents+f.PredictedCLVCents {
			t.Errorf("pred %d total CLV = %d, want historic+predicted", i, got.TotalCLVCents)
		}
		// The fitted params are recorded for cross-run drift tracking.
		if got.Explanation["bgnbd_r"] != params.R {
			t.Errorf("pred %d missing fitted r param in explanation", i)
		}
		bgnbdCount++
	}
	if bgnbdCount == 0 {
		t.Fatal("expected at least some customers scored by the model")
	}

	// Non-CLV fields must be untouched by the model swap.
	for i := range signals {
		base := ComputePrediction(signals[i], bgnbdNow)
		if preds[i].ChurnRisk != base.ChurnRisk || preds[i].DataSufficiency != base.DataSufficiency {
			t.Errorf("pred %d: model swap altered a non-CLV field (churn/sufficiency)", i)
		}
	}
}
