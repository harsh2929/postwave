package predictive

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

var ErrNotFound = errors.New("predictive: not found")

type Repo struct {
	Pool *db.Pool
	// Logger receives Recompute's record of a CLV model fallback. Nil means
	// slog.Default().
	Logger *slog.Logger
}

type ProfileAnalytics struct {
	Prediction Prediction `json:"prediction"`
	RFM        RFMScore   `json:"rfm"`
}

func (r *Repo) ListProfiles(ctx context.Context, tenantID, segment string, limit int) ([]ProfileAnalytics, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT p.email::text, COALESCE(p.subscriber_id::text, ''),
       p.historic_clv_cents, p.predicted_clv_cents, p.total_clv_cents,
       p.churn_risk::float8, p.predicted_order_count::float8,
       p.average_days_between_orders::float8, p.expected_next_order_at,
       p.predicted_gender, p.confidence::float8, p.data_sufficiency,
       p.explanation, p.churn_drivers, p.calculated_at,
       COALESCE(r.recency_days, -1), COALESCE(r.frequency, 0),
       COALESCE(r.monetary_cents, 0), COALESCE(r.recency_score, 1),
       COALESCE(r.frequency_score, 1), COALESCE(r.monetary_score, 1),
       COALESCE(r.rfm_score, '111'), COALESCE(r.segment_key, 'insufficient_data'),
       COALESCE(r.calculated_at, p.calculated_at)
FROM profile_predictions p
LEFT JOIN profile_rfm_scores r
  ON r.tenant_id = p.tenant_id AND lower(r.email::text) = lower(p.email::text)
WHERE p.tenant_id = $1::uuid
  AND ($2 = '' OR r.segment_key = $2)
ORDER BY p.total_clv_cents DESC, p.calculated_at DESC
LIMIT $3`, tenantID, strings.TrimSpace(segment), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ProfileAnalytics{}
	for rows.Next() {
		item, err := scanProfileAnalytics(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) GetProfile(ctx context.Context, tenantID, email string) (*ProfileAnalytics, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
SELECT p.email::text, COALESCE(p.subscriber_id::text, ''),
       p.historic_clv_cents, p.predicted_clv_cents, p.total_clv_cents,
       p.churn_risk::float8, p.predicted_order_count::float8,
       p.average_days_between_orders::float8, p.expected_next_order_at,
       p.predicted_gender, p.confidence::float8, p.data_sufficiency,
       p.explanation, p.churn_drivers, p.calculated_at,
       COALESCE(r.recency_days, -1), COALESCE(r.frequency, 0),
       COALESCE(r.monetary_cents, 0), COALESCE(r.recency_score, 1),
       COALESCE(r.frequency_score, 1), COALESCE(r.monetary_score, 1),
       COALESCE(r.rfm_score, '111'), COALESCE(r.segment_key, 'insufficient_data'),
       COALESCE(r.calculated_at, p.calculated_at)
FROM profile_predictions p
LEFT JOIN profile_rfm_scores r
  ON r.tenant_id = p.tenant_id AND lower(r.email::text) = lower(p.email::text)
WHERE p.tenant_id = $1::uuid AND lower(p.email::text) = lower($2)
LIMIT 1`, tenantID, strings.TrimSpace(email))
	out, err := scanProfileAnalytics(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// CLVTier is a coarse value-band count for the CLV dashboard (SUB-127).
type CLVTier struct {
	Key          string  `json:"key"`
	Label        string  `json:"label"`
	Profiles     int     `json:"profiles"`
	AvgTotalCLV  int     `json:"avg_total_clv_cents"`
	AvgChurnRisk float64 `json:"avg_churn_risk"`
}

// CLVPercentiles holds total_clv_cents percentile cut points across the
// scored snapshot (SUB-127).
type CLVPercentiles struct {
	P10 int `json:"p10_cents"`
	P25 int `json:"p25_cents"`
	P50 int `json:"p50_cents"`
	P75 int `json:"p75_cents"`
	P90 int `json:"p90_cents"`
	P99 int `json:"p99_cents"`
}

// CLVProfilePreview is a compact example profile for the dashboard
// preview carousel (SUB-127).
type CLVProfilePreview struct {
	Email         string  `json:"email"`
	SubscriberID  string  `json:"subscriber_id,omitempty"`
	TotalCLVCents int     `json:"total_clv_cents"`
	ChurnRisk     float64 `json:"churn_risk"`
	SegmentKey    string  `json:"segment_key,omitempty"`
}

// CLVDistribution is the aggregated CLV dashboard payload (SUB-127): a
// single round-trip serving distribution stats so the frontend never has
// to scan every profile row.
type CLVDistribution struct {
	ProfileCount      int                 `json:"profile_count"`
	ScoredProfiles    int                 `json:"scored_profiles"`
	TotalCLVCents     int64               `json:"total_clv_cents"`
	PredictedCLVCents int64               `json:"predicted_clv_cents"`
	AvgTotalCLVCents  int                 `json:"avg_total_clv_cents"`
	Percentiles       CLVPercentiles      `json:"percentiles"`
	Tiers             []CLVTier           `json:"tiers"`
	TopProfiles       []CLVProfilePreview `json:"top_profiles"`
	AtRiskProfiles    []CLVProfilePreview `json:"at_risk_profiles"`
	LastCalculatedAt  *time.Time          `json:"last_calculated_at,omitempty"`
}

// clvTierDefs defines the value bands; mirrors Klaviyo's predicted-CLV
// dashboard tiers (Champions / At-Risk / Low-Value style banding driven
// by total_clv percentile + churn risk).
var clvTierDefs = []struct {
	Key, Label string
}{
	{"champions", "Champions"},
	{"high_value", "High value"},
	{"mid_value", "Mid value"},
	{"low_value", "Low value"},
	{"at_risk", "At risk"},
}

// GetCLVDistribution computes aggregated CLV dashboard stats over the
// current profile_predictions snapshot for the tenant (SUB-127). All work
// happens in Postgres so the frontend gets a small, pre-aggregated payload.
func (r *Repo) GetCLVDistribution(ctx context.Context, tenantID string, previewLimit int) (*CLVDistribution, error) {
	// Zero is an explicit data-minimisation request from aggregate-only clients:
	// compute the distribution without selecting email/subscriber previews.
	if previewLimit < 0 || previewLimit > 50 {
		previewLimit = 10
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	out := &CLVDistribution{
		Tiers:          []CLVTier{},
		TopProfiles:    []CLVProfilePreview{},
		AtRiskProfiles: []CLVProfilePreview{},
	}

	// Headline aggregates + percentiles in one pass.
	var lastCalc *time.Time
	if err := tx.QueryRow(ctx, `
SELECT
  count(*)::int,
  count(*) FILTER (WHERE data_sufficiency <> 'insufficient')::int,
  COALESCE(sum(total_clv_cents), 0)::bigint,
  COALESCE(sum(predicted_clv_cents), 0)::bigint,
  COALESCE(avg(total_clv_cents), 0)::int,
  COALESCE(percentile_cont(0.10) WITHIN GROUP (ORDER BY total_clv_cents), 0)::int,
  COALESCE(percentile_cont(0.25) WITHIN GROUP (ORDER BY total_clv_cents), 0)::int,
  COALESCE(percentile_cont(0.50) WITHIN GROUP (ORDER BY total_clv_cents), 0)::int,
  COALESCE(percentile_cont(0.75) WITHIN GROUP (ORDER BY total_clv_cents), 0)::int,
  COALESCE(percentile_cont(0.90) WITHIN GROUP (ORDER BY total_clv_cents), 0)::int,
  COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY total_clv_cents), 0)::int,
  max(calculated_at)
FROM profile_predictions
WHERE tenant_id = $1::uuid`, tenantID).Scan(
		&out.ProfileCount, &out.ScoredProfiles, &out.TotalCLVCents,
		&out.PredictedCLVCents, &out.AvgTotalCLVCents,
		&out.Percentiles.P10, &out.Percentiles.P25, &out.Percentiles.P50,
		&out.Percentiles.P75, &out.Percentiles.P90, &out.Percentiles.P99,
		&lastCalc); err != nil {
		return nil, err
	}
	out.LastCalculatedAt = lastCalc
	if out.ProfileCount == 0 {
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return out, nil
	}

	// Tier banding: classify each profile by total_clv percentile rank and
	// churn risk. at_risk wins when churn_risk is high regardless of value.
	tierRows, err := tx.Query(ctx, `
WITH ranked AS (
  SELECT total_clv_cents,
         churn_risk::float8 AS churn_risk,
         percent_rank() OVER (ORDER BY total_clv_cents) AS pr
  FROM profile_predictions
  WHERE tenant_id = $1::uuid
),
tiered AS (
  SELECT
    CASE
      WHEN churn_risk >= 0.6 AND total_clv_cents > 0 THEN 'at_risk'
      WHEN pr >= 0.9 THEN 'champions'
      WHEN pr >= 0.7 THEN 'high_value'
      WHEN pr >= 0.4 THEN 'mid_value'
      ELSE 'low_value'
    END AS tier_key,
    total_clv_cents,
    churn_risk
  FROM ranked
)
SELECT tier_key, count(*)::int, COALESCE(avg(total_clv_cents), 0)::int,
       COALESCE(avg(churn_risk), 0)::float8
FROM tiered
GROUP BY tier_key`, tenantID)
	if err != nil {
		return nil, err
	}
	tierByKey := map[string]CLVTier{}
	for tierRows.Next() {
		var key string
		var profiles, avgCLV int
		var avgChurn float64
		if err := tierRows.Scan(&key, &profiles, &avgCLV, &avgChurn); err != nil {
			tierRows.Close()
			return nil, err
		}
		tierByKey[key] = CLVTier{Key: key, Profiles: profiles, AvgTotalCLV: avgCLV, AvgChurnRisk: avgChurn}
	}
	tierRows.Close()
	if err := tierRows.Err(); err != nil {
		return nil, err
	}
	// Emit tiers in a stable, defined order (zero-fill missing tiers).
	for _, def := range clvTierDefs {
		t := tierByKey[def.Key]
		t.Key = def.Key
		t.Label = def.Label
		out.Tiers = append(out.Tiers, t)
	}

	// Top profiles by total CLV.
	out.TopProfiles, err = clvPreviews(ctx, tx, tenantID, previewLimit, `
ORDER BY p.total_clv_cents DESC, p.calculated_at DESC`)
	if err != nil {
		return nil, err
	}
	// At-risk high-value profiles: high churn risk, positive value.
	out.AtRiskProfiles, err = clvPreviews(ctx, tx, tenantID, previewLimit, `
AND p.churn_risk >= 0.6 AND p.total_clv_cents > 0
ORDER BY p.total_clv_cents DESC, p.churn_risk DESC`)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func clvPreviews(ctx context.Context, tx pgx.Tx, tenantID string, limit int, extra string) ([]CLVProfilePreview, error) {
	rows, err := tx.Query(ctx, `
SELECT p.email::text, COALESCE(p.subscriber_id::text, ''),
       p.total_clv_cents, p.churn_risk::float8,
       COALESCE(r.segment_key, '')
FROM profile_predictions p
LEFT JOIN profile_rfm_scores r
  ON r.tenant_id = p.tenant_id AND lower(r.email::text) = lower(p.email::text)
WHERE p.tenant_id = $1::uuid `+extra+`
LIMIT $2`, tenantID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CLVProfilePreview{}
	for rows.Next() {
		var item CLVProfilePreview
		if err := rows.Scan(&item.Email, &item.SubscriberID, &item.TotalCLVCents,
			&item.ChurnRisk, &item.SegmentKey); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

// DataSufficiencyBucket is one bucket (insufficient / limited / sufficient)
// of the tenant-wide data-sufficiency report (SUB-129).
type DataSufficiencyBucket struct {
	Count      int     `json:"count"`
	Percentage float64 `json:"percentage"`
}

// DataSufficiencyReport is the tenant-wide rollup of which predictions are
// reliable per profile bucket (SUB-129). Read from
// profile_prediction_sufficiency_rollup; the percentages are derived on read
// (count / total) so a stored percentage can never drift from its own counts.
type DataSufficiencyReport struct {
	Insufficient DataSufficiencyBucket `json:"insufficient"`
	Limited      DataSufficiencyBucket `json:"limited"`
	Sufficient   DataSufficiencyBucket `json:"sufficient"`
	Total        int                   `json:"total"`
	LastUpdated  *time.Time            `json:"last_updated,omitempty"`
}

// GetDataSufficiency returns the tenant-wide data-sufficiency distribution
// from the rollup table (SUB-129). When the tenant has never been rolled up
// (no recompute yet), it returns a zeroed report with a nil LastUpdated
// rather than an error so the report surface renders an empty state cleanly.
func (r *Repo) GetDataSufficiency(ctx context.Context, tenantID string) (*DataSufficiencyReport, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	out := &DataSufficiencyReport{}
	var lastUpdated *time.Time
	err = tx.QueryRow(ctx, `
SELECT insufficient_count, limited_count, sufficient_count, total_count, last_updated
  FROM profile_prediction_sufficiency_rollup
 WHERE tenant_id = $1::uuid`, tenantID).Scan(
		&out.Insufficient.Count, &out.Limited.Count, &out.Sufficient.Count,
		&out.Total, &lastUpdated)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			return out, nil
		}
		return nil, err
	}
	out.LastUpdated = lastUpdated
	if out.Total > 0 {
		out.Insufficient.Percentage = sufficiencyPct(out.Insufficient.Count, out.Total)
		out.Limited.Percentage = sufficiencyPct(out.Limited.Count, out.Total)
		out.Sufficient.Percentage = sufficiencyPct(out.Sufficient.Count, out.Total)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// sufficiencyPct returns count/total as a 0..100 percentage, guarding against
// division by zero. Pure helper so the rounding rule is unit-testable.
func sufficiencyPct(count, total int) float64 {
	if total <= 0 {
		return 0
	}
	return float64(count) / float64(total) * 100.0
}

// refreshSufficiencyRollup recomputes the tenant's data-sufficiency
// distribution from the current profile_predictions snapshot and upserts it
// into profile_prediction_sufficiency_rollup (SUB-129). Called inside the
// Recompute transaction after upsertPredictions so the rollup always reflects
// the freshly-scored snapshot. Runs on the same tx so it is atomic with the
// recompute.
func refreshSufficiencyRollup(ctx context.Context, tx pgx.Tx, tenantID string) error {
	_, err := tx.Exec(ctx, `
INSERT INTO profile_prediction_sufficiency_rollup
    (tenant_id, insufficient_count, limited_count, sufficient_count, total_count, last_updated)
SELECT $1::uuid,
       count(*) FILTER (WHERE data_sufficiency = 'insufficient')::int,
       count(*) FILTER (WHERE data_sufficiency = 'limited')::int,
       count(*) FILTER (WHERE data_sufficiency = 'sufficient')::int,
       count(*)::int,
       now()
  FROM profile_predictions
 WHERE tenant_id = $1::uuid
ON CONFLICT (tenant_id) DO UPDATE SET
    insufficient_count = EXCLUDED.insufficient_count,
    limited_count      = EXCLUDED.limited_count,
    sufficient_count   = EXCLUDED.sufficient_count,
    total_count        = EXCLUDED.total_count,
    last_updated       = EXCLUDED.last_updated`, tenantID)
	return err
}

func (r *Repo) RFMSegments(ctx context.Context, tenantID string) ([]map[string]any, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT segment_key, count(*)::int, COALESCE(avg(monetary_cents), 0)::int
FROM profile_rfm_scores
WHERE tenant_id = $1::uuid
GROUP BY segment_key
ORDER BY count(*) DESC, segment_key`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var key string
		var count int
		var avg int
		if err := rows.Scan(&key, &count, &avg); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{
			"segment_key":        key,
			"profiles":           count,
			"avg_monetary_cents": avg,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) Recompute(ctx context.Context, tenantID string, windowDays int) (*RunResult, error) {
	if windowDays <= 0 {
		windowDays = 365
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	now := time.Now().UTC()
	var run ModelRun
	metrics := map[string]any{"window_days": windowDays}
	metricsRaw, _ := json.Marshal(metrics)
	err = tx.QueryRow(ctx, `
INSERT INTO predictive_model_runs
    (tenant_id, model_key, model_version, status, input_window_days, metrics, started_at, completed_at)
VALUES
    ($1::uuid, 'predictive_profile_suite', 'heuristic-v1', 'completed', $2, $3::jsonb, $4, $4)
RETURNING id::text, tenant_id::text, model_key, model_version, status,
       input_window_days, scored_profiles, insufficient_profiles, metrics,
       error, started_at, completed_at, created_at`, tenantID, windowDays, string(metricsRaw), now).Scan(
		&run.ID, &run.TenantID, &run.ModelKey, &run.ModelVersion, &run.Status,
		&run.InputWindowDays, &run.ScoredProfiles, &run.InsufficientProfiles,
		&metricsRaw, &run.Error, &run.StartedAt, &run.CompletedAt, &run.CreatedAt)
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(metricsRaw, &run.Metrics)

	signals, err := loadProfileSignals(ctx, tx, tenantID, windowDays)
	if err != nil {
		return nil, err
	}
	rfm := ComputeRFMScores(signals, now)
	// G-11: fit the population BG/NBD model once over the tenant's customer
	// base and use its per-customer forecasts, falling back to the heuristic
	// when the model cannot be fitted — PredictBatchBGNBD handles both and
	// preserves every non-CLV field (churn, drivers, data-sufficiency) from
	// ComputePrediction. The fit's outcome goes into the run's metrics.
	predictions, fit := PredictBatchBGNBD(signals, now)
	fitMetrics, err := json.Marshal(bgnbdRunMetrics(fit))
	if err != nil {
		return nil, err
	}
	insufficient := 0
	for _, p := range predictions {
		if p.DataSufficiency == "insufficient" {
			insufficient++
		}
	}
	if err := upsertPredictions(ctx, tx, tenantID, run.ID, predictions); err != nil {
		return nil, err
	}
	// SUB-129: refresh the tenant-wide data-sufficiency rollup from the
	// freshly-upserted snapshot, atomically with the recompute.
	if err := refreshSufficiencyRollup(ctx, tx, tenantID); err != nil {
		return nil, err
	}
	if err := upsertRFM(ctx, tx, tenantID, run.ID, rfm); err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx, `
UPDATE predictive_model_runs
   SET scored_profiles = $3,
       insufficient_profiles = $4,
       metrics = metrics || $5::jsonb
 WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING metrics`, tenantID, run.ID, len(predictions), insufficient, string(fitMetrics)).Scan(&metricsRaw); err != nil {
		return nil, err
	}
	run.Metrics = nil
	if err := json.Unmarshal(metricsRaw, &run.Metrics); err != nil {
		return nil, err
	}
	run.ScoredProfiles = len(predictions)
	run.InsufficientProfiles = insufficient
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	r.logBGNBDFallback(ctx, tenantID, run.ID, fit)
	return &RunResult{Run: run, Predictions: len(predictions), RFMScores: len(rfm)}, nil
}

// bgnbdRunMetrics is what a model run's metrics record about its BG/NBD fit:
// clv_model, the model its CLV forecasts came from (customers without an
// order history are scored by the heuristic either way; each prediction's
// explanation names its own model), and bgnbd_customers, how many customers
// the fit saw. When the heuristic was kept, bgnbd_fallback_reason is
// BGNBDFit.FallbackReason and bgnbd_fallback_error the full error, with the
// values involved.
func bgnbdRunMetrics(fit BGNBDFit) map[string]any {
	metrics := map[string]any{
		"clv_model":       clvModelBGNBD,
		"bgnbd_customers": fit.Customers,
	}
	if !fit.Fitted() {
		metrics["clv_model"] = clvModelHeuristic
		metrics["bgnbd_fallback_reason"] = fit.FallbackReason()
		metrics["bgnbd_fallback_error"] = fit.Err.Error()
	}
	return metrics
}

// logBGNBDFallback records a committed run whose CLV forecasts stayed on the
// heuristic. A tenant whose data cannot support a fit (too few customers, or
// none who bought again) is an ordinary state, logged at debug level: most
// tenants are in it, and the recompute workers visit every tenant, so an
// info line per tenant per pass would bury the rejections that matter. The
// run's metrics say so either way. Any other rejection is a fit that broke
// down on data that supports one, logged as a warning.
func (r *Repo) logBGNBDFallback(ctx context.Context, tenantID, runID string, fit BGNBDFit) {
	if fit.Fitted() {
		return
	}
	level := slog.LevelWarn
	if fit.dataCannotSupportFit() {
		level = slog.LevelDebug
	}
	r.logger().Log(ctx, level, "predictive: BG/NBD fit not used; CLV forecasts stay on "+clvModelHeuristic,
		"tenant_id", tenantID,
		"run_id", runID,
		"reason", fit.FallbackReason(),
		"customers", fit.Customers,
		"err", fit.Err.Error())
}

func (r *Repo) logger() *slog.Logger {
	if r != nil && r.Logger != nil {
		return r.Logger
	}
	return slog.Default()
}

func loadProfileSignals(ctx context.Context, tx pgx.Tx, tenantID string, windowDays int) ([]ProfileSignals, error) {
	rows, err := tx.Query(ctx, `
WITH commerce AS (
  SELECT lower(customer_email::text) AS email,
         count(*)::int AS order_count,
         COALESCE(sum(total_cents), 0)::int AS historic_clv_cents,
         min(ordered_at) AS first_order_at,
         max(ordered_at) AS last_order_at
    FROM commerce_orders
   WHERE tenant_id = $1::uuid
     AND customer_email IS NOT NULL
     AND status IN ('paid','refunded')
     AND ordered_at >= now() - ($2::int * interval '1 day')
   GROUP BY lower(customer_email::text)
)
SELECT COALESCE(c.email, lower(s.email::text)) AS email,
       COALESCE(s.id::text, '') AS subscriber_id,
       COALESCE(c.historic_clv_cents, 0),
       COALESCE(c.order_count, 0),
       c.first_order_at,
       c.last_order_at,
       s.churn_score
  FROM commerce c
  FULL OUTER JOIN subscribers s
    ON lower(s.email::text) = c.email AND s.tenant_id = $1::uuid
 WHERE COALESCE(c.email, lower(s.email::text)) IS NOT NULL
 LIMIT 50000`, tenantID, windowDays)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ProfileSignals{}
	for rows.Next() {
		var item ProfileSignals
		if err := rows.Scan(&item.Email, &item.SubscriberID, &item.HistoricCLVCents,
			&item.OrderCount, &item.FirstOrderAt, &item.LastOrderAt, &item.ChurnScore); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func upsertPredictions(ctx context.Context, tx pgx.Tx, tenantID, runID string, items []Prediction) error {
	for _, item := range items {
		explanation, _ := json.Marshal(item.Explanation)
		drivers := item.ChurnDrivers
		if drivers == nil {
			drivers = []ChurnDriver{}
		}
		churnDrivers, _ := json.Marshal(drivers)
		_, err := tx.Exec(ctx, `
INSERT INTO profile_predictions
    (tenant_id, subscriber_id, email, model_run_id, historic_clv_cents,
     predicted_clv_cents, total_clv_cents, churn_risk, predicted_order_count,
     average_days_between_orders, expected_next_order_at, predicted_gender,
     confidence, data_sufficiency, explanation, churn_drivers, calculated_at)
VALUES
    ($1::uuid, NULLIF($2, '')::uuid, $3, $4::uuid, $5, $6, $7, $8, $9,
     $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17)
ON CONFLICT (tenant_id, email) DO UPDATE SET
    subscriber_id = EXCLUDED.subscriber_id,
    model_run_id = EXCLUDED.model_run_id,
    historic_clv_cents = EXCLUDED.historic_clv_cents,
    predicted_clv_cents = EXCLUDED.predicted_clv_cents,
    total_clv_cents = EXCLUDED.total_clv_cents,
    churn_risk = EXCLUDED.churn_risk,
    predicted_order_count = EXCLUDED.predicted_order_count,
    average_days_between_orders = EXCLUDED.average_days_between_orders,
    expected_next_order_at = EXCLUDED.expected_next_order_at,
    predicted_gender = EXCLUDED.predicted_gender,
    confidence = EXCLUDED.confidence,
    data_sufficiency = EXCLUDED.data_sufficiency,
    explanation = EXCLUDED.explanation,
    churn_drivers = EXCLUDED.churn_drivers,
    calculated_at = EXCLUDED.calculated_at,
    updated_at = now()`,
			tenantID, item.SubscriberID, item.Email, runID, item.HistoricCLVCents,
			item.PredictedCLVCents, item.TotalCLVCents, item.ChurnRisk,
			item.PredictedOrderCount, item.AverageDaysBetweenOrders,
			item.ExpectedNextOrderAt, item.PredictedGender, item.Confidence,
			item.DataSufficiency, string(explanation), string(churnDrivers), item.CalculatedAt)
		if err != nil {
			return err
		}
	}
	return nil
}

func upsertRFM(ctx context.Context, tx pgx.Tx, tenantID, runID string, items []RFMScore) error {
	for _, item := range items {
		_, err := tx.Exec(ctx, `
INSERT INTO profile_rfm_scores
    (tenant_id, subscriber_id, email, model_run_id, recency_days, frequency,
     monetary_cents, recency_score, frequency_score, monetary_score,
     rfm_score, segment_key, calculated_at)
VALUES
    ($1::uuid, NULLIF($2, '')::uuid, $3, $4::uuid, $5, $6,
     $7, $8, $9, $10, $11, $12, $13)
ON CONFLICT (tenant_id, email) DO UPDATE SET
    subscriber_id = EXCLUDED.subscriber_id,
    model_run_id = EXCLUDED.model_run_id,
    recency_days = EXCLUDED.recency_days,
    frequency = EXCLUDED.frequency,
    monetary_cents = EXCLUDED.monetary_cents,
    recency_score = EXCLUDED.recency_score,
    frequency_score = EXCLUDED.frequency_score,
    monetary_score = EXCLUDED.monetary_score,
    rfm_score = EXCLUDED.rfm_score,
    segment_key = EXCLUDED.segment_key,
    calculated_at = EXCLUDED.calculated_at,
    updated_at = now()`,
			tenantID, item.SubscriberID, item.Email, runID, item.RecencyDays,
			item.Frequency, item.MonetaryCents, item.RecencyScore,
			item.FrequencyScore, item.MonetaryScore, item.RFMScore,
			item.SegmentKey, item.CalculatedAt)
		if err != nil {
			return err
		}
	}
	return nil
}

func scanProfileAnalytics(row pgx.Row) (*ProfileAnalytics, error) {
	var out ProfileAnalytics
	var avgDays *float64
	var recency int
	var explanation []byte
	var churnDrivers []byte
	if err := row.Scan(&out.Prediction.Email, &out.Prediction.SubscriberID,
		&out.Prediction.HistoricCLVCents, &out.Prediction.PredictedCLVCents,
		&out.Prediction.TotalCLVCents, &out.Prediction.ChurnRisk,
		&out.Prediction.PredictedOrderCount, &avgDays,
		&out.Prediction.ExpectedNextOrderAt, &out.Prediction.PredictedGender,
		&out.Prediction.Confidence, &out.Prediction.DataSufficiency,
		&explanation, &churnDrivers, &out.Prediction.CalculatedAt,
		&recency, &out.RFM.Frequency, &out.RFM.MonetaryCents,
		&out.RFM.RecencyScore, &out.RFM.FrequencyScore, &out.RFM.MonetaryScore,
		&out.RFM.RFMScore, &out.RFM.SegmentKey, &out.RFM.CalculatedAt); err != nil {
		return nil, err
	}
	out.Prediction.AverageDaysBetweenOrders = avgDays
	out.Prediction.Explanation = map[string]any{}
	_ = json.Unmarshal(explanation, &out.Prediction.Explanation)
	out.Prediction.ChurnDrivers = []ChurnDriver{}
	if len(churnDrivers) > 0 {
		_ = json.Unmarshal(churnDrivers, &out.Prediction.ChurnDrivers)
	}
	out.RFM.Email = out.Prediction.Email
	out.RFM.SubscriberID = out.Prediction.SubscriberID
	if recency >= 0 {
		out.RFM.RecencyDays = &recency
	}
	return &out, nil
}
