package sto_predictive_clv

import (
	"context"
	"log/slog"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Worker is the weekly training loop. The scaffold runs the tick and
// records `skipped_insufficient_data` audit rows for each tenant — the
// real ML pipeline (BTYD-NBD + Gamma-Gamma for CLV, XGBoost for churn,
// gender / age classifiers) lands in a follow-up.
//
// Data flow (deferred work):
//
//  1. For each tenant, snapshot `subscriber_events` + `orders` (when
//     the commerce integration is wired) into a feature frame keyed by
//     (subscriber_id, week-bucket).
//  2. Filter out tenants below MinCustomersForTraining /
//     MinHistoryDays — stamp `skipped_insufficient_data` and continue.
//  3. Fit BTYD-NBD (frequency / recency / T) + Gamma-Gamma (monetary)
//     per tenant for the CLV + EDONO + ATBO + predicted_order_count
//     outputs.
//  4. Fit an XGBoost classifier on event-derived features for
//     churn_risk_score. Calibrate with isotonic regression so the
//     output is interpretable as a probability.
//  5. Score every eligible subscriber and UpsertPrediction in batches
//     of ~5000 rows per tx (keeping per-statement payloads under the
//     5 MiB cap on Aurora postgres).
//  6. Compute drift metrics vs the previous run (KS test on
//     clv_predicted_cents distribution, churn AUC against a hold-out
//     fold) and record them in `subscriber_prediction_runs.metrics`.
//
// The scaffold's Run() returns after stamping the audit row so the
// loop can be wired into main.go without exercising any of the
// pipeline above. The Interval field controls how often Run() fires.
type Worker struct {
	Pool     *db.Pool
	Repo     *Repo
	Logger   *slog.Logger
	Interval time.Duration
	// Recompute runs one tenant's prediction recompute — wired in main.go to
	// internal/predictive's (now BG/NBD-backed) Repo.Recompute, kept as an
	// injected seam so this package stays decoupled from that one. When nil,
	// Run() stays the historical no-op so the loop can be constructed without
	// activating any work.
	Recompute func(ctx context.Context, tenantID string) error
}

// DefaultInterval is the cadence vendors converge on (Klaviyo +
// Mailchimp both recompute weekly). The audit run rows let operators
// see the cadence even when the underlying model isn't refreshed.
const DefaultInterval = 7 * 24 * time.Hour

// Loop runs Run on Worker.Interval until ctx is cancelled. Designed to
// be wrapped in safego.Go in main.go (no panics escape; ctx
// cancellation is the only stop signal).
func (w *Worker) Loop(ctx context.Context) {
	if w == nil {
		return
	}
	interval := w.Interval
	if interval <= 0 {
		interval = DefaultInterval
	}
	logger := w.logger()

	// Fire once on startup so the audit trail isn't empty for a week
	// after a fresh deploy. Errors are swallowed (logged) — the loop
	// is best-effort.
	if err := w.Run(ctx); err != nil {
		logger.Warn("sto_predictive_clv.worker initial tick failed", "err", err)
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := w.Run(ctx); err != nil {
				logger.Warn("sto_predictive_clv.worker tick failed", "err", err)
			}
		}
	}
}

// Run executes one training pass across every tenant. The scaffold
// short-circuits without iterating tenants — that requires reaching
// into the tenants table from a non-tenant scope, which is the
// worker-scope path. The full implementation does:
//
//	tenants := SELECT id FROM tenants WHERE deleted_at IS NULL
//	for _, t := range tenants {
//	    InsertRunPending(t)
//	    feats := buildFeatures(t)
//	    if !sufficient(feats) { MarkRunSkipped(t); continue }
//	    model := trainBTYD(feats)
//	    scores := score(model, feats)
//	    UpsertPredictions(t, scores)
//	    MarkRunSucceeded(t, metrics)
//	}
//
// Returning nil here keeps the loop deterministic until the pipeline
// is wired.
func (w *Worker) Run(ctx context.Context) error {
	if w == nil || w.Pool == nil {
		return nil
	}
	logger := w.logger()
	if w.Recompute == nil {
		logger.Info("sto_predictive_clv.worker tick (no recompute wired; skipping)")
		return nil
	}
	tenants, err := w.listTenants(ctx)
	if err != nil {
		return err
	}
	var processed, failed int
	for _, tenantID := range tenants {
		if err := ctx.Err(); err != nil {
			return err // cancellation stops the pass
		}
		if err := w.Recompute(ctx, tenantID); err != nil {
			failed++
			logger.Warn("sto_predictive_clv.worker: tenant recompute failed", "tenant", tenantID, "err", err)
			continue // one bad tenant must not halt the weekly pass
		}
		processed++
	}
	logger.Info("sto_predictive_clv.worker tick complete",
		"tenants_processed", processed, "tenants_failed", failed)
	return nil
}

// listTenants enumerates every tenant from worker (non-tenant) scope, the same
// db.WithWorkerScope path referrals.VerificationWorker uses. tenants has no
// soft-delete column, so every row is a live tenant.
func (w *Worker) listTenants(ctx context.Context) ([]string, error) {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `SELECT id::text FROM tenants ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (w *Worker) logger() *slog.Logger {
	if w == nil || w.Logger == nil {
		return slog.Default()
	}
	return w.Logger
}
