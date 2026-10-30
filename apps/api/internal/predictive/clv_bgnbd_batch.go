// SPDX-License-Identifier: AGPL-3.0-only
//
// clv_bgnbd_batch.go — the batch prediction that swaps the heuristic CLV for
// the fitted BG/NBD model (G-11), without editing ComputePrediction.
//
// ComputePrediction scores one customer with the "heuristic-v1" order model.
// A real BG/NBD prediction has to fit the population parameters once across
// the whole customer base and then condition each customer's forecast on
// those params — a batch operation. PredictBatchBGNBD does exactly that: fit
// once (via FitTenantBGNBD, which falls back below MinCustomersForBGNBD or
// when FitBGNBD rejects the fit), then for each customer keep everything
// ComputePrediction already computes (churn risk, drivers, cadence, RFM) and
// *override only* the order/CLV forecast with the model's, tagging the
// explanation "bgnbd-v1".
//
// This is a pure function composed over the existing per-customer scorer.
// Repo.Recompute calls it once per tenant and records the returned fit's
// outcome (see bgnbdRunMetrics and logBGNBDFallback in repo.go).
package predictive

import (
	"time"

	"github.com/postwave/postwave/apps/api/internal/predictive_clv"
)

// The CLV model labels a Prediction's explanation["model"] and a model run's
// metrics["clv_model"] carry.
const (
	clvModelHeuristic = "heuristic-v1"
	clvModelBGNBD     = "bgnbd-v1"
)

// PredictBatchBGNBD scores a whole tenant's customer base. It fits the BG/NBD
// population parameters once; when the model fits (see FitTenantBGNBD) each
// scorable customer's predicted order count and CLV come from the model,
// otherwise every customer keeps ComputePrediction's heuristic unchanged. All
// non-CLV fields (churn risk, drivers, cadence, sufficiency) always come
// straight from ComputePrediction. The fit is returned with the predictions
// so the caller can record which model they came from and, when it is the
// heuristic, why (BGNBDFit.FallbackReason).
func PredictBatchBGNBD(signals []ProfileSignals, now time.Time) ([]Prediction, BGNBDFit) {
	return predictBatchBGNBD(signals, now, predictive_clv.FitOptions{})
}

// predictBatchBGNBD is PredictBatchBGNBD with FitBGNBD's options exposed, so
// tests can drive the real fitter into its outcome rejections.
func predictBatchBGNBD(signals []ProfileSignals, now time.Time, opts predictive_clv.FitOptions) ([]Prediction, BGNBDFit) {
	fit := fitTenantBGNBD(signals, now, opts)
	out := make([]Prediction, len(signals))
	for i, s := range signals {
		p := ComputePrediction(s, now)
		if fit.Fitted() {
			if f, ok := BGNBDForecastFor(fit.Params, s, now, DefaultCLVHorizonWeeks); ok {
				applyBGNBDForecast(&p, fit.Params, f)
			}
		}
		out[i] = p
	}
	return out, fit
}

// applyBGNBDForecast overrides p's order/CLV forecast with the model's and
// records the model + fitted params in the explanation, leaving every other
// field (churn, drivers, cadence, historic CLV) as ComputePrediction set it.
func applyBGNBDForecast(p *Prediction, params predictive_clv.Params, f BGNBDForecast) {
	p.PredictedOrderCount = f.PredictedOrders
	p.PredictedCLVCents = f.PredictedCLVCents
	p.TotalCLVCents = p.HistoricCLVCents + f.PredictedCLVCents
	if p.Explanation == nil {
		p.Explanation = map[string]any{}
	}
	p.Explanation["model"] = clvModelBGNBD
	p.Explanation["bgnbd_r"] = params.R
	p.Explanation["bgnbd_alpha"] = params.Alpha
	p.Explanation["bgnbd_a"] = params.A
	p.Explanation["bgnbd_b"] = params.B
}
