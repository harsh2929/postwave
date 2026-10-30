// SPDX-License-Identifier: AGPL-3.0-only
//
// G18 (campaigns 2026): per-campaign anomaly detection. The workspace
// anomaly detector (anomalies.go) keys on (tenant, metric, day) — this
// is the per-campaign hourly variant. It flags hours where a metric
// (opens/clicks/unsubs) deviates strongly from the campaign's own hourly
// distribution via a z-score, so an operator watching a live send sees
// "click rate this hour is 3σ below the campaign's typical hour".
//
// v1 computes on-demand from the hourly time-series (G1) — stateless,
// no persistence. A persisted (tenant, campaign, metric, hour) table +
// live-SSE emission are the documented follow-ups.

package analytics

import (
	"context"
	"errors"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// CampaignAnomaly is one flagged hour for one metric.
type CampaignAnomaly struct {
	Hour      string  `json:"hour"`
	Metric    string  `json:"metric"` // opens | clicks | unsubs
	Value     int     `json:"value"`
	Mean      float64 `json:"mean"`
	ZScore    float64 `json:"z_score"`
	Direction string  `json:"direction"` // spike | drop
}

// CampaignAnomaliesResult wraps the detected anomalies.
type CampaignAnomaliesResult struct {
	CampaignID  string            `json:"campaign_id"`
	Anomalies   []CampaignAnomaly `json:"anomalies"`
	From        *time.Time        `json:"from,omitempty"`
	To          *time.Time        `json:"to,omitempty"`
	AsOf        time.Time         `json:"as_of"`
	TimeZone    string            `json:"timezone"`
	Granularity string            `json:"granularity"`
	Truncated   bool              `json:"truncated"`
}

// anomalyZThreshold: |z| at or above this flags an anomaly. 2.5 ≈ the
// 99th percentile — conservative enough to avoid noise on small sends.
const anomalyZThreshold = 2.5

// anomalyMinSamples: need a few hours of data before a z-score means
// anything.
const anomalyMinSamples = 6

// detectCampaignAnomalies runs a per-metric z-score over the hourly
// buckets and returns the hours that breach the threshold. Pure +
// deterministic so it's unit-testable without a DB.
func detectCampaignAnomalies(buckets []HourBucket) []CampaignAnomaly {
	out := []CampaignAnomaly{}
	if len(buckets) < anomalyMinSamples {
		return out
	}
	metrics := []struct {
		name string
		get  func(HourBucket) int
	}{
		{"opens", func(b HourBucket) int { return b.Opens }},
		{"clicks", func(b HourBucket) int { return b.Clicks }},
		{"unsubs", func(b HourBucket) int { return b.Unsubs }},
	}
	for _, m := range metrics {
		var sum float64
		for _, b := range buckets {
			sum += float64(m.get(b))
		}
		mean := sum / float64(len(buckets))
		var sqSum float64
		for _, b := range buckets {
			d := float64(m.get(b)) - mean
			sqSum += d * d
		}
		std := math.Sqrt(sqSum / float64(len(buckets)))
		if std == 0 {
			continue // flat series — nothing anomalous
		}
		for _, b := range buckets {
			v := m.get(b)
			z := (float64(v) - mean) / std
			if math.Abs(z) < anomalyZThreshold {
				continue
			}
			dir := "spike"
			if z < 0 {
				dir = "drop"
			}
			out = append(out, CampaignAnomaly{
				Hour:      b.Hour.UTC().Format("2006-01-02T15:04:05Z"),
				Metric:    m.name,
				Value:     v,
				Mean:      math.Round(mean*100) / 100,
				ZScore:    math.Round(z*100) / 100,
				Direction: dir,
			})
		}
	}
	return out
}

// CampaignAnomalies GET /api/v1/campaigns/{id}/anomalies
func (d *Deps) CampaignAnomalies(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "campaign id required"))
		return
	}
	ts, err := d.Repo.CampaignTimeseries(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, errEnv("campaign_not_found", "campaign not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	anomalies := detectCampaignAnomalies(ts.Buckets)
	// A GET is observational only. Live/SSE workers may explicitly persist
	// anomaly snapshots through RecordCampaignAnomalies, but refreshing this
	// read endpoint must not rewrite detected_at or mutate tenant state.
	writeJSON(w, http.StatusOK, CampaignAnomaliesResult{
		CampaignID:  id,
		Anomalies:   anomalies,
		From:        ts.From,
		To:          ts.To,
		AsOf:        ts.AsOf,
		TimeZone:    ts.TimeZone,
		Granularity: ts.Granularity,
		Truncated:   ts.Truncated,
	})
}

// RecordCampaignAnomalies upserts detected anomalies keyed on
// (tenant, campaign, metric, hour_bucket). Idempotent — re-detecting the
// same hour updates the row in place rather than duplicating.
func (r *Repo) RecordCampaignAnomalies(ctx context.Context, tenantID, campaignID string, anomalies []CampaignAnomaly) error {
	if len(anomalies) == 0 {
		return nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, a := range anomalies {
		if _, err := tx.Exec(ctx, `
INSERT INTO campaign_anomalies
    (tenant_id, campaign_id, metric, hour_bucket, value, mean, z_score, direction, detected_at)
VALUES ($1::uuid, $2::uuid, $3, $4::timestamptz, $5, $6, $7, $8, now())
ON CONFLICT (tenant_id, campaign_id, metric, hour_bucket) DO UPDATE
   SET value = EXCLUDED.value, mean = EXCLUDED.mean,
       z_score = EXCLUDED.z_score, direction = EXCLUDED.direction,
       detected_at = now()`,
			tenantID, campaignID, a.Metric, a.Hour, a.Value, a.Mean, a.ZScore, a.Direction); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
