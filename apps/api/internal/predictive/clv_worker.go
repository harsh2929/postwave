// SPDX-License-Identifier: AGPL-3.0-only
//
// clv_worker.go — a fake-driven prediction-run loop (G-11). For each tenant,
// RunPredictionBatch gathers the per-customer order signals, computes
// BG/NBD-backed predictions and persists them. It is written against two
// interfaces (SignalSource, PredictionSink), so the orchestration and the
// model swap are testable with fakes.
//
// Nothing in production calls it. Production recomputes through
// Repo.Recompute: the sto_predictive_clv worker (wired in main.go) and the
// operational-maintenance worker call it for every tenant, and
// POST /api/v1/predictive/recompute calls it for one. Repo.Recompute makes
// the same PredictBatchBGNBD call, and when the fit is not used it records
// why in the run's predictive_model_runs.metrics and in the log.
package predictive

import (
	"context"
	"time"
)

// SignalSource yields the per-customer order signals (ProfileSignals) for one
// tenant — the input a real worker reads out of commerce_orders /
// subscriber_events.
type SignalSource interface {
	SignalsForTenant(ctx context.Context, tenantID string) ([]ProfileSignals, error)
}

// PredictionSink persists a tenant's computed predictions (the worker's
// UpsertPredictions path).
type PredictionSink interface {
	UpsertPredictions(ctx context.Context, tenantID string, preds []Prediction) error
}

// PredictionRunResult summarizes a RunPredictionBatch call.
type PredictionRunResult struct {
	TenantsProcessed   int
	TenantsFailed      int
	PredictionsWritten int
	// BGNBDFallbacks maps each processed tenant whose CLV forecasts stayed on
	// the heuristic to the reason (BGNBDFit.FallbackReason). A tenant the
	// model fitted is not in it.
	BGNBDFallbacks map[string]string
}

// RunPredictionBatch computes and persists predictions for each tenant: fetch
// signals → PredictBatchBGNBD (fitted model, or the heuristic fallback when
// the model cannot be fitted) → upsert. A per-tenant fetch/upsert error is
// recorded and the run continues to the next tenant — one bad tenant must not
// halt the whole batch — and the first such error is returned alongside the
// summary so a caller can alert without losing the successful work.
func RunPredictionBatch(ctx context.Context, tenants []string, src SignalSource, sink PredictionSink, now time.Time) (PredictionRunResult, error) {
	res := PredictionRunResult{BGNBDFallbacks: map[string]string{}}
	var firstErr error
	fail := func(err error) {
		res.TenantsFailed++
		if firstErr == nil {
			firstErr = err
		}
	}
	for _, tenantID := range tenants {
		if err := ctx.Err(); err != nil {
			return res, err // cancellation stops the whole batch
		}
		signals, err := src.SignalsForTenant(ctx, tenantID)
		if err != nil {
			fail(err)
			continue
		}
		preds, fit := PredictBatchBGNBD(signals, now)
		if err := sink.UpsertPredictions(ctx, tenantID, preds); err != nil {
			fail(err)
			continue
		}
		res.TenantsProcessed++
		res.PredictionsWritten += len(preds)
		if !fit.Fitted() {
			res.BGNBDFallbacks[tenantID] = fit.FallbackReason()
		}
	}
	return res, firstErr
}
