// SPDX-License-Identifier: AGPL-3.0-only
//
// G1 (campaigns 2026): per-campaign hourly engagement time-series.
// CampaignReport returns point-in-time totals; this adds the shape of
// engagement over the campaign's life — hourly opens/clicks/unsubs —
// so the slideover can draw sparklines per KPI and the report tab a
// stacked area chart. Also the foundation G18 (per-campaign anomaly
// detection) reads.

package analytics

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// HourBucket is one hour of campaign engagement.
type HourBucket struct {
	Hour   time.Time `json:"hour"` // truncated to the hour, UTC
	Opens  int       `json:"opens"`
	Clicks int       `json:"clicks"`
	Unsubs int       `json:"unsubs"`
}

// CampaignTimeseriesResult is the gap-filled hourly series for a campaign.
type CampaignTimeseriesResult struct {
	CampaignID  string       `json:"campaign_id"`
	Buckets     []HourBucket `json:"buckets"`
	From        *time.Time   `json:"from,omitempty"`
	To          *time.Time   `json:"to,omitempty"`
	AsOf        time.Time    `json:"as_of"`
	TimeZone    string       `json:"timezone"`
	Granularity string       `json:"granularity"`
	Truncated   bool         `json:"truncated"`
}

// campaignTimeseriesMaxHours caps the series so a campaign that has
// dribbled events for months can't return an unbounded slice. 30 days
// of hourly buckets = 720 points, plenty for the chart.
const campaignTimeseriesMaxHours = 24 * 30

// CampaignTimeseries returns the newest bounded hourly opens/clicks/unsubs for
// a tenant-owned campaign. It intentionally delegates to an as-of variant so
// tests can pin future-event exclusion and response metadata deterministically.
func (r *Repo) CampaignTimeseries(ctx context.Context, tenantID, campaignID string) (*CampaignTimeseriesResult, error) {
	return r.campaignTimeseriesAt(ctx, tenantID, campaignID, time.Now().UTC())
}

func (r *Repo) campaignTimeseriesAt(
	ctx context.Context,
	tenantID string,
	campaignID string,
	asOf time.Time,
) (*CampaignTimeseriesResult, error) {
	asOf = asOf.UTC()
	tx, err := db.WithTenantOptions(ctx, r.Pool, tenantID, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Make missing and foreign campaign identifiers indistinguishable. An
	// aggregate over the events table alone would otherwise return a misleading
	// 200 with an empty series for both.
	var owned int
	if err := tx.QueryRow(ctx, `
SELECT 1
  FROM campaigns
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`, tenantID, campaignID).Scan(&owned); err != nil {
		return nil, fmt.Errorf("campaign timeseries ownership: %w", err)
	}

	result := &CampaignTimeseriesResult{
		CampaignID:  campaignID,
		Buckets:     []HourBucket{},
		AsOf:        asOf,
		TimeZone:    "UTC",
		Granularity: "hour",
	}

	var earliest, latest *time.Time
	if err := tx.QueryRow(ctx, `
SELECT MIN(date_trunc('hour', at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
       MAX(date_trunc('hour', at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid
   AND campaign_id = $2::uuid
   AND event_type IN ('opened','clicked','unsubscribed')
   AND at <= $3`, tenantID, campaignID, asOf).Scan(&earliest, &latest); err != nil {
		return nil, fmt.Errorf("campaign timeseries bounds: %w", err)
	}
	if earliest == nil || latest == nil {
		if err := tx.Commit(ctx); err != nil {
			return nil, fmt.Errorf("campaign timeseries commit: %w", err)
		}
		return result, nil
	}

	from := earliest.UTC()
	to := latest.UTC()
	newestWindowStart := to.Add(-time.Duration(campaignTimeseriesMaxHours-1) * time.Hour)
	if from.Before(newestWindowStart) {
		from = newestWindowStart
		result.Truncated = true
	}

	rows, err := tx.Query(ctx, `
SELECT date_trunc('hour', at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket,
       count(*) FILTER (WHERE event_type = 'opened')::int       AS opens,
       count(*) FILTER (WHERE event_type = 'clicked')::int      AS clicks,
       count(*) FILTER (WHERE event_type = 'unsubscribed')::int AS unsubs
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid
   AND campaign_id = $2::uuid
   AND event_type IN ('opened','clicked','unsubscribed')
   AND at >= $3
   AND at <= $4
 GROUP BY 1
 ORDER BY 1`, tenantID, campaignID, from, asOf)
	if err != nil {
		return nil, fmt.Errorf("campaign timeseries query: %w", err)
	}
	defer rows.Close()
	var observed []HourBucket
	for rows.Next() {
		var b HourBucket
		if err := rows.Scan(&b.Hour, &b.Opens, &b.Clicks, &b.Unsubs); err != nil {
			return nil, fmt.Errorf("campaign timeseries scan: %w", err)
		}
		observed = append(observed, b)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("campaign timeseries rows: %w", err)
	}

	from = from.UTC()
	to = to.UTC()
	result.From = &from
	result.To = &to
	result.Buckets = zeroFillHourlyBetween(observed, from, to)
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("campaign timeseries commit: %w", err)
	}
	return result, nil
}

// zeroFillHourly returns observed (assumed sorted, hour-truncated)
// expanded so every hour from the first to the last bucket is present,
// gaps filled with zero counts. If the lifetime exceeds the bound, the newest
// hours win; charts must never silently show the oldest month as if it were the
// complete recorded lifetime.
// The existing conversions zero-fill is DAY-granular and not reusable.
func zeroFillHourly(observed []HourBucket) []HourBucket {
	if len(observed) == 0 {
		return []HourBucket{}
	}
	start := observed[0].Hour.UTC()
	end := observed[len(observed)-1].Hour.UTC()
	newestWindowStart := end.Add(-time.Duration(campaignTimeseriesMaxHours-1) * time.Hour)
	if start.Before(newestWindowStart) {
		start = newestWindowStart
	}
	return zeroFillHourlyBetween(observed, start, end)
}

func zeroFillHourlyBetween(observed []HourBucket, start, end time.Time) []HourBucket {
	start = start.UTC()
	end = end.UTC()
	if end.Before(start) {
		return []HourBucket{}
	}
	byHour := make(map[time.Time]HourBucket, len(observed))
	for _, b := range observed {
		byHour[b.Hour.UTC()] = b
	}
	out := make([]HourBucket, 0, campaignTimeseriesMaxHours)
	for h, n := start, 0; !h.After(end) && n < campaignTimeseriesMaxHours; h, n = h.Add(time.Hour), n+1 {
		if b, ok := byHour[h]; ok {
			b.Hour = h
			out = append(out, b)
		} else {
			out = append(out, HourBucket{Hour: h})
		}
	}
	return out
}

// CampaignTimeseries GET /api/v1/campaigns/{id}/timeseries
func (d *Deps) CampaignTimeseries(w http.ResponseWriter, r *http.Request) {
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
	res, err := d.Repo.CampaignTimeseries(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, errEnv("campaign_not_found", "campaign not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, res)
}
