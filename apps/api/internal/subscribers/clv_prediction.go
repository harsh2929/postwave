package subscribers

// SUB-059 — first-class predictive CLV on the subscriber detail.
//
// The predictive worker (internal/predictive) scores every commerce/email
// profile and writes a profile_predictions row keyed on (tenant_id, email):
// historic / predicted / total CLV in cents, a churn_risk scalar, a
// confidence + data_sufficiency band, and (SUB-060, migration 0912) a ranked
// churn_drivers jsonb array. That surface is already exposed at
// GET /api/v1/predictive/profiles/{email}, but the subscriber detail GET did
// not hydrate it, so the slideover had no subscriber-level CLV to render.
//
// This file LEFT JOINs profile_predictions onto the subscriber's email and
// stamps a narrowed read-only SubscriberPrediction onto the Subscriber for
// the detail GET. It reuses the predictive worker's table — zero schema
// changes here, and no coupling to the predictive Go package (the JSON shape
// is mirrored locally so the subscribers response stays self-contained).
//
// Hydration is detail-only + best-effort, matching the catalog_attributes /
// federated_master_id / prediction-lineage pattern: a missing row leaves
// Prediction nil (omitted from JSON), and a query failure logs without
// failing the core GET.

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// hydrateCLVPrediction reads the profile_predictions row for the subscriber's
// email and stamps a SubscriberPrediction onto sub for the detail GET. Keyed
// on (tenant_id, email) — the same key the predictive worker upserts — so an
// address the worker has not scored yet simply leaves sub.Prediction nil.
// Runs inside its own tenant-scoped tx; the caller's GET is unaffected on
// failure. churn_drivers is read defensively via to_regclass-free direct
// select; the column ships in migration 0912 ahead of this code.
func (r *Repo) hydrateCLVPrediction(ctx context.Context, tenantID string, sub *Subscriber) error {
	if sub == nil || sub.Email == "" {
		return nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var p SubscriberPrediction
	var driversRaw []byte
	err = tx.QueryRow(ctx, `
SELECT historic_clv_cents, predicted_clv_cents, total_clv_cents,
       churn_risk::float8, confidence::float8, data_sufficiency,
       churn_drivers, calculated_at
  FROM profile_predictions
 WHERE tenant_id = $1::uuid
   AND lower(email::text) = lower($2)
 LIMIT 1`, tenantID, sub.Email).Scan(
		&p.HistoricCLVCents, &p.PredictedCLVCents, &p.TotalCLVCents,
		&p.ChurnRisk, &p.Confidence, &p.DataSufficiency,
		&driversRaw, &p.CalculatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return tx.Commit(ctx)
	}
	if err != nil {
		return err
	}
	p.ChurnDrivers = []ChurnDriver{}
	if len(driversRaw) > 0 {
		_ = json.Unmarshal(driversRaw, &p.ChurnDrivers)
	}
	sub.Prediction = &p
	return tx.Commit(ctx)
}
