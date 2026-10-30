package sto_predictive_clv

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ErrNotFound is returned by GetPrediction when the worker has not yet
// scored the subscriber (or insufficient-data filtered them out).
var ErrNotFound = errors.New("sto_predictive_clv: not found")

// Repo wraps the pool with the queries the handlers + worker need. All
// per-tenant paths go through db.WithTenant so RLS pins to the caller's
// tenant (the worker uses db.WithWorkerScope + manual tenant pin).
type Repo struct {
	Pool *db.Pool
}

// ListPredictions returns the most-recently-computed snapshots for the
// tenant. The full segment-builder paths will accept additional
// filters; the scaffold returns a single ORDER BY computed_at slice.
func (r *Repo) ListPredictions(ctx context.Context, tenantID string, limit int) ([]Prediction, error) {
	if r == nil || r.Pool == nil {
		return []Prediction{}, nil
	}
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT subscriber_id::text,
       clv_predicted_cents, churn_risk_score::float8,
       expected_next_order_at, avg_days_between_orders::float8,
       predicted_order_count::float8,
       COALESCE(predicted_gender, ''), predicted_age_years,
       confidence::float8, COALESCE(data_sufficiency, ''),
       model_version, payload, computed_at
FROM subscriber_predictions
WHERE tenant_id = $1::uuid
ORDER BY computed_at DESC, subscriber_id
LIMIT $2`, tenantID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Prediction{}
	for rows.Next() {
		p, err := scanPrediction(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// GetPrediction fetches a single subscriber row. Returns ErrNotFound
// when the worker has not yet scored the subscriber.
func (r *Repo) GetPrediction(ctx context.Context, tenantID, subscriberID string) (*Prediction, error) {
	if r == nil || r.Pool == nil {
		return nil, ErrNotFound
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
SELECT subscriber_id::text,
       clv_predicted_cents, churn_risk_score::float8,
       expected_next_order_at, avg_days_between_orders::float8,
       predicted_order_count::float8,
       COALESCE(predicted_gender, ''), predicted_age_years,
       confidence::float8, COALESCE(data_sufficiency, ''),
       model_version, payload, computed_at
FROM subscriber_predictions
WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid`, tenantID, subscriberID)
	p, err := scanPrediction(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &p, nil
}

// UpsertPrediction is the worker's primary write path. The ML pipeline
// trains a model, scores every eligible subscriber, then calls this in
// a batch (see worker.go). The scaffold defines the signature; the
// inner loop is what the human engineer will fill in once the model
// outputs are real.
func (r *Repo) UpsertPrediction(ctx context.Context, tenantID string, p Prediction) error {
	if r == nil || r.Pool == nil {
		return errors.New("sto_predictive_clv: nil pool")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	payloadJSON, err := marshalPayload(p.Payload)
	if err != nil {
		return err
	}

	_, err = tx.Exec(ctx, `
INSERT INTO subscriber_predictions (
    tenant_id, subscriber_id,
    clv_predicted_cents, churn_risk_score,
    expected_next_order_at, avg_days_between_orders,
    predicted_order_count, predicted_gender, predicted_age_years,
    confidence, data_sufficiency, model_version, payload, computed_at
) VALUES (
    $1::uuid, $2::uuid,
    $3, $4,
    $5, $6,
    $7, NULLIF($8,''), $9,
    $10, NULLIF($11,''), $12, $13::jsonb, COALESCE($14, now())
)
ON CONFLICT (tenant_id, subscriber_id) DO UPDATE SET
    clv_predicted_cents      = EXCLUDED.clv_predicted_cents,
    churn_risk_score         = EXCLUDED.churn_risk_score,
    expected_next_order_at   = EXCLUDED.expected_next_order_at,
    avg_days_between_orders  = EXCLUDED.avg_days_between_orders,
    predicted_order_count    = EXCLUDED.predicted_order_count,
    predicted_gender         = EXCLUDED.predicted_gender,
    predicted_age_years      = EXCLUDED.predicted_age_years,
    confidence               = EXCLUDED.confidence,
    data_sufficiency         = EXCLUDED.data_sufficiency,
    model_version            = EXCLUDED.model_version,
    payload                  = EXCLUDED.payload,
    computed_at              = EXCLUDED.computed_at`,
		tenantID, p.SubscriberID,
		p.CLVPredictedCents, p.ChurnRiskScore,
		p.ExpectedNextOrderAt, p.AvgDaysBetweenOrders,
		p.PredictedOrderCount, p.PredictedGender, p.PredictedAgeYears,
		p.Confidence, p.DataSufficiency, p.ModelVersion, payloadJSON, nullableTime(p.ComputedAt),
	)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ListRuns returns the recent training-run audit rows.
func (r *Repo) ListRuns(ctx context.Context, tenantID string, limit int) ([]Run, error) {
	if r == nil || r.Pool == nil {
		return []Run{}, nil
	}
	if limit <= 0 || limit > 200 {
		limit = 25
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, model_key, model_version, status,
       input_window_days, scored_profiles, insufficient_profiles,
       metrics, error, started_at, completed_at, created_at
FROM subscriber_prediction_runs
WHERE tenant_id = $1::uuid
ORDER BY created_at DESC
LIMIT $2`, tenantID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Run{}
	for rows.Next() {
		run, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, run)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// InsertRunPlaceholder records that a recompute was requested. Today
// it stamps `skipped_insufficient_data` so the audit trail captures
// the intent without lying about training output. Once the worker is
// real this will be split into InsertRunPending +
// MarkRunSucceeded/MarkRunFailed.
func (r *Repo) InsertRunPlaceholder(ctx context.Context, tenantID, modelKey, modelVersion string, windowDays int) (Run, error) {
	if r == nil || r.Pool == nil {
		return Run{}, errors.New("sto_predictive_clv: nil pool")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return Run{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	now := time.Now().UTC()
	row := tx.QueryRow(ctx, `
INSERT INTO subscriber_prediction_runs (
    tenant_id, model_key, model_version, status,
    input_window_days, started_at, completed_at
) VALUES (
    $1::uuid, $2, $3, 'skipped_insufficient_data',
    $4, $5, $5
)
RETURNING id::text, model_key, model_version, status,
          input_window_days, scored_profiles, insufficient_profiles,
          metrics, error, started_at, completed_at, created_at`,
		tenantID, modelKey, modelVersion, windowDays, now)
	run, err := scanRun(row)
	if err != nil {
		return Run{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Run{}, err
	}
	return run, nil
}

// ---- scan helpers ----

// rowScanner is the smallest surface both pgx.Row and pgx.Rows expose;
// lets scanPrediction / scanRun work in both list + single-row paths.
type rowScanner interface {
	Scan(dest ...any) error
}

func scanPrediction(row rowScanner) (Prediction, error) {
	var (
		p            Prediction
		clv          *int64
		churn        *float64
		edono        *time.Time
		atbo         *float64
		orders       *float64
		gender       string
		age          *int
		confidence   *float64
		sufficiency  string
		modelVersion string
		payloadBytes []byte
		computedAt   time.Time
		subscriberID string
	)
	if err := row.Scan(
		&subscriberID, &clv, &churn,
		&edono, &atbo, &orders,
		&gender, &age,
		&confidence, &sufficiency,
		&modelVersion, &payloadBytes, &computedAt,
	); err != nil {
		return Prediction{}, err
	}
	p.SubscriberID = subscriberID
	p.CLVPredictedCents = clv
	p.ChurnRiskScore = churn
	p.ExpectedNextOrderAt = edono
	p.AvgDaysBetweenOrders = atbo
	p.PredictedOrderCount = orders
	p.PredictedGender = gender
	p.PredictedAgeYears = age
	p.Confidence = confidence
	p.DataSufficiency = sufficiency
	p.ModelVersion = modelVersion
	p.ComputedAt = computedAt
	if len(payloadBytes) > 0 {
		_ = json.Unmarshal(payloadBytes, &p.Payload)
	}
	return p, nil
}

func scanRun(row rowScanner) (Run, error) {
	var (
		r            Run
		metricsBytes []byte
		started      *time.Time
		completed    *time.Time
	)
	if err := row.Scan(
		&r.ID, &r.ModelKey, &r.ModelVersion, &r.Status,
		&r.InputWindowDays, &r.ScoredProfiles, &r.InsufficientProfiles,
		&metricsBytes, &r.Error, &started, &completed, &r.CreatedAt,
	); err != nil {
		return Run{}, err
	}
	r.StartedAt = started
	r.CompletedAt = completed
	if len(metricsBytes) > 0 {
		_ = json.Unmarshal(metricsBytes, &r.Metrics)
	}
	return r, nil
}

func marshalPayload(payload map[string]any) ([]byte, error) {
	if len(payload) == 0 {
		return []byte("{}"), nil
	}
	return json.Marshal(payload)
}

func nullableTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t
}
