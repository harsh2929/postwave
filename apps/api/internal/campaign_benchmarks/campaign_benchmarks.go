// SPDX-License-Identifier: AGPL-3.0-only
//
// Package campaign_benchmarks compares a single campaign's
// performance against the tenant's rolling-window baseline.
//
// The operator question this answers: "is this campaign actually
// good?" Industry benchmarks (Mailchimp, Postmark, SendGrid
// publish broad averages) are too noisy for actionable comparison
// — every tenant's audience is different. The right baseline is
// "the tenant's own last 90 days", which is what this package
// reports.
//
// Surfaces:
//
//   GET /api/v1/campaigns/{id}/benchmark?baseline_days=90
//
// Per metric we report:
//   * value          this campaign's rate
//   * baseline       tenant's rolling average (last N days, ex-this)
//   * delta          value - baseline
//   * delta_pct      (value - baseline) / baseline * 100
//   * percentile     where this value falls in the rolling distribution
//                    (a quick "top 10%? bottom?" signal)

package campaign_benchmarks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Deps wires the HTTP surface.
type Deps struct {
	Pool   *db.Pool
	Logger *slog.Logger
	Now    func() time.Time
}

// MountRoutes registers the read endpoint.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(read).Get("/api/v1/campaigns/{id}/benchmark", d.Get)
}

// Metric is one row of the benchmark report.
type Metric struct {
	Name       string   `json:"name"`
	Value      float64  `json:"value"`
	Baseline   float64  `json:"baseline"`
	Delta      float64  `json:"delta"`
	DeltaPct   *float64 `json:"delta_pct"`
	Percentile *int     `json:"percentile"`
	Verdict    string   `json:"verdict,omitempty"` // 'above' | 'on_par' | 'below'
	Available  bool     `json:"available"`
	Reason     string   `json:"reason,omitempty"`
}

const benchmarkMinSampleSize = 5

type response struct {
	CampaignID                string    `json:"campaign_id"`
	BaselineDays              int       `json:"baseline_days"`
	BaselineFrom              time.Time `json:"baseline_from"`
	BaselineTo                time.Time `json:"baseline_to"`
	AsOf                      time.Time `json:"as_of"`
	TimeZone                  string    `json:"timezone"`
	BaselineSelection         string    `json:"baseline_selection"`
	This                      rates     `json:"this"`
	TenantBaseline            rates     `json:"tenant_baseline"`
	BaselineSampleSize        int       `json:"baseline_sample_size"`
	MinimumSampleSize         int       `json:"minimum_sample_size"`
	BaselineAvailable         bool      `json:"baseline_available"`
	BaselineUnavailableReason string    `json:"baseline_unavailable_reason,omitempty"`
	Metrics                   []Metric  `json:"metrics"`
}

// Get GET /api/v1/campaigns/{id}/benchmark?baseline_days=90.
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "no tenant in context")
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_id", "missing campaign id")
		return
	}
	baselineDays := 90
	if v := strings.TrimSpace(r.URL.Query().Get("baseline_days")); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 14 || n > 365 {
			httperror.Write(w, http.StatusBadRequest, "invalid_baseline_days",
				"baseline_days must be an integer between 14 and 365")
			return
		}
		baselineDays = n
	}

	asOf := d.now().UTC()
	tx, err := db.WithTenantOptions(r.Context(), d.Pool, t.ID, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Per-campaign rates for THIS campaign.
	thisRates, err := campaignRates(r.Context(), tx, t.ID, id, asOf)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httperror.Write(w, http.StatusNotFound, "campaign_not_found", "campaign not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	// Rolling baseline = avg rate across this tenant's OTHER
	// campaigns finished in the last `baselineDays`. Excluding the
	// current one keeps the comparison fair.
	since := asOf.AddDate(0, 0, -baselineDays)
	baseline, samples, err := tenantBaseline(r.Context(), tx, t.ID, id, since, asOf)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, fmt.Errorf("campaign benchmark commit: %w", err), r.Context())
		return
	}

	sampleSize := len(samples)
	metrics := []Metric{
		buildMetric("open_rate", thisRates.OpenRate, baseline.OpenRate, metricDistribution(samples, func(r rates) float64 { return r.OpenRate })),
		buildMetric("click_rate", thisRates.ClickRate, baseline.ClickRate, metricDistribution(samples, func(r rates) float64 { return r.ClickRate })),
		buildMetric("bounce_rate", thisRates.BounceRate, baseline.BounceRate, metricDistribution(samples, func(r rates) float64 { return r.BounceRate })),
		buildMetric("complaint_rate", thisRates.ComplaintRate, baseline.ComplaintRate, metricDistribution(samples, func(r rates) float64 { return r.ComplaintRate })),
		buildMetric("unsubscribe_rate", thisRates.UnsubscribeRate, baseline.UnsubscribeRate, metricDistribution(samples, func(r rates) float64 { return r.UnsubscribeRate })),
	}
	out := response{
		CampaignID:         id,
		BaselineDays:       baselineDays,
		BaselineFrom:       since,
		BaselineTo:         asOf,
		AsOf:               asOf,
		TimeZone:           "UTC",
		BaselineSelection:  "sent_campaigns_by_last_recipient_sent_at",
		This:               thisRates,
		TenantBaseline:     baseline,
		BaselineSampleSize: sampleSize,
		MinimumSampleSize:  benchmarkMinSampleSize,
		BaselineAvailable:  sampleSize >= benchmarkMinSampleSize,
		Metrics:            metrics,
	}
	if !out.BaselineAvailable {
		out.BaselineUnavailableReason = "insufficient_baseline_sample"
	}
	w.Header().Set("Cache-Control", "private, no-store")
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) now() time.Time {
	if d != nil && d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

type rates struct {
	Recipients      int64   `json:"recipients"`
	OpenRate        float64 `json:"open_rate"`
	ClickRate       float64 `json:"click_rate"`
	BounceRate      float64 `json:"bounce_rate"`
	ComplaintRate   float64 `json:"complaint_rate"`
	UnsubscribeRate float64 `json:"unsubscribe_rate"`
}

func campaignRates(ctx context.Context, tx pgx.Tx, tenantID, campaignID string, asOf time.Time) (rates, error) {
	var out rates
	var recip, opens, clicks, bounces, complaints, unsubs int64
	// The denominator is the sent/delivered recipient cohort, never "any actor
	// with any event". Numerators are constrained to that same cohort and to
	// facts observed at or before as_of.
	err := tx.QueryRow(ctx, `
WITH target AS (
  SELECT id
    FROM campaigns
   WHERE tenant_id = $1::uuid
     AND id = $2::uuid
),
denominator AS (
  SELECT lower(cr.subscriber_email::text) AS email
    FROM campaign_recipients cr
    JOIN target t ON t.id = cr.campaign_id
   WHERE cr.tenant_id = $1::uuid
     AND cr.status = 'sent'
     AND (cr.sent_at IS NULL OR cr.sent_at <= $3)
  UNION
  SELECT lower(se.subscriber_email::text) AS email
    FROM subscriber_events se
    JOIN target t ON t.id = se.campaign_id
   WHERE se.tenant_id = $1::uuid
     AND se.event_type IN ('sent','delivered')
     AND se.at <= $3
)
SELECT
  count(DISTINCT d.email) AS recip,
  count(DISTINCT d.email) FILTER (WHERE se.event_type='opened')       AS opens,
  count(DISTINCT d.email) FILTER (WHERE se.event_type='clicked')      AS clicks,
  count(DISTINCT d.email) FILTER (WHERE se.event_type='bounced')      AS bounces,
  count(DISTINCT d.email) FILTER (WHERE se.event_type='complained')   AS complaints,
  count(DISTINCT d.email) FILTER (WHERE se.event_type='unsubscribed') AS unsubs
FROM target t
LEFT JOIN denominator d ON true
LEFT JOIN subscriber_events se
  ON se.tenant_id = $1::uuid
 AND se.campaign_id = t.id
 AND lower(se.subscriber_email::text) = d.email
 AND se.at <= $3
GROUP BY t.id`, tenantID, campaignID, asOf).Scan(
		&recip, &opens, &clicks, &bounces, &complaints, &unsubs)
	if err != nil {
		return out, fmt.Errorf("campaign rates: %w", err)
	}
	out.Recipients = recip
	den := float64(recip)
	if den == 0 {
		den = 1
	}
	out.OpenRate = float64(opens) / den
	out.ClickRate = float64(clicks) / den
	out.BounceRate = float64(bounces) / den
	out.ComplaintRate = float64(complaints) / den
	out.UnsubscribeRate = float64(unsubs) / den
	return out, nil
}

// tenantBaseline computes one equally-weighted sample per completed campaign.
// "Completed" is status=sent with an observed final successful recipient
// sent_at inside [since, asOf]. That completion proxy is populated by the send
// loop even though historical campaign rows do not consistently set
// campaigns.finished_at. All facts are upper-bounded by asOf.
func tenantBaseline(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	excludeID string,
	since time.Time,
	asOf time.Time,
) (rates, []rates, error) {
	rows, err := tx.Query(ctx, `
WITH eligible_campaigns AS (
  SELECT c.id,
         max(cr.sent_at) AS completed_at
    FROM campaigns c
    JOIN campaign_recipients cr
      ON cr.tenant_id = c.tenant_id
     AND cr.campaign_id = c.id
     AND cr.status = 'sent'
     AND cr.sent_at IS NOT NULL
     AND cr.sent_at <= $4
   WHERE c.tenant_id = $1::uuid
     AND c.id <> $2::uuid
     AND c.status = 'sent'
   GROUP BY c.id
  HAVING max(cr.sent_at) >= $3
     AND max(cr.sent_at) <= $4
),
denominator AS (
  SELECT ec.id AS campaign_id, lower(cr.subscriber_email::text) AS email
    FROM eligible_campaigns ec
    JOIN campaign_recipients cr
      ON cr.tenant_id = $1::uuid
     AND cr.campaign_id = ec.id
     AND cr.status = 'sent'
     AND cr.sent_at <= $4
  UNION
  SELECT ec.id AS campaign_id, lower(se.subscriber_email::text) AS email
    FROM eligible_campaigns ec
    JOIN subscriber_events se
      ON se.tenant_id = $1::uuid
     AND se.campaign_id = ec.id
     AND se.event_type IN ('sent','delivered')
     AND se.at <= $4
),
per_campaign AS (
  SELECT ec.id AS campaign_id,
         count(DISTINCT d.email)::float8 AS recip,
         count(DISTINCT d.email) FILTER (WHERE se.event_type='opened')::float8       AS opens,
         count(DISTINCT d.email) FILTER (WHERE se.event_type='clicked')::float8      AS clicks,
         count(DISTINCT d.email) FILTER (WHERE se.event_type='bounced')::float8      AS bounces,
         count(DISTINCT d.email) FILTER (WHERE se.event_type='complained')::float8   AS complaints,
         count(DISTINCT d.email) FILTER (WHERE se.event_type='unsubscribed')::float8 AS unsubs
    FROM eligible_campaigns ec
    JOIN denominator d ON d.campaign_id = ec.id
    LEFT JOIN subscriber_events se
      ON se.tenant_id = $1::uuid
     AND se.campaign_id = ec.id
     AND lower(se.subscriber_email::text) = d.email
     AND se.at <= $4
   GROUP BY ec.id
  HAVING count(DISTINCT d.email) > 0
)
SELECT recip::int8,
       opens/recip   AS open_rate,
       clicks/recip  AS click_rate,
       bounces/recip AS bounce_rate,
       complaints/recip AS complaint_rate,
       unsubs/recip  AS unsub_rate
  FROM per_campaign
 ORDER BY campaign_id`, tenantID, excludeID, since, asOf)
	if err != nil {
		return rates{}, nil, fmt.Errorf("tenant benchmark baseline query: %w", err)
	}
	defer rows.Close()
	samples := []rates{}
	var sumOpen, sumClick, sumBounce, sumComp, sumUnsub float64
	var sumRecipients int64
	n := 0
	for rows.Next() {
		var sample rates
		if err := rows.Scan(
			&sample.Recipients,
			&sample.OpenRate,
			&sample.ClickRate,
			&sample.BounceRate,
			&sample.ComplaintRate,
			&sample.UnsubscribeRate,
		); err != nil {
			return rates{}, nil, fmt.Errorf("tenant benchmark baseline scan: %w", err)
		}
		samples = append(samples, sample)
		sumRecipients += sample.Recipients
		sumOpen += sample.OpenRate
		sumClick += sample.ClickRate
		sumBounce += sample.BounceRate
		sumComp += sample.ComplaintRate
		sumUnsub += sample.UnsubscribeRate
		n++
	}
	if err := rows.Err(); err != nil {
		return rates{}, nil, fmt.Errorf("tenant benchmark baseline rows: %w", err)
	}
	if n == 0 {
		return rates{}, samples, nil
	}
	return rates{
		Recipients:      sumRecipients / int64(n),
		OpenRate:        sumOpen / float64(n),
		ClickRate:       sumClick / float64(n),
		BounceRate:      sumBounce / float64(n),
		ComplaintRate:   sumComp / float64(n),
		UnsubscribeRate: sumUnsub / float64(n),
	}, samples, nil
}

func buildMetric(name string, value, baseline float64, dist []float64) Metric {
	m := Metric{
		Name:     name,
		Value:    value,
		Baseline: baseline,
	}
	m.Delta = value - baseline
	if baseline != 0 {
		deltaPct := (m.Delta / baseline) * 100
		m.DeltaPct = &deltaPct
	}
	if len(dist) < benchmarkMinSampleSize {
		m.Reason = "insufficient_baseline_sample"
		return m
	}
	m.Available = true
	percentileValue := percentile(value, dist)
	m.Percentile = &percentileValue
	switch {
	case baseline == 0 && value > 0:
		m.Verdict = "above"
	case baseline == 0:
		m.Verdict = "on_par"
	case *m.DeltaPct >= 10:
		m.Verdict = "above"
	case *m.DeltaPct <= -10:
		m.Verdict = "below"
	default:
		m.Verdict = "on_par"
	}
	// For inverse metrics (bounce, complaint, unsub), invert the verdict.
	switch name {
	case "bounce_rate", "complaint_rate", "unsubscribe_rate":
		switch m.Verdict {
		case "above":
			m.Verdict = "below"
		case "below":
			m.Verdict = "above"
		}
	}
	return m
}

func metricDistribution(samples []rates, value func(rates) float64) []float64 {
	out := make([]float64, 0, len(samples))
	for _, sample := range samples {
		out = append(out, value(sample))
	}
	return out
}

func percentile(value float64, dist []float64) int {
	if len(dist) == 0 {
		return 0
	}
	below := 0
	for _, v := range dist {
		if v < value {
			below++
		}
	}
	return int(float64(below) * 100 / float64(len(dist)))
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
