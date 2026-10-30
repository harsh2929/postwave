// SPDX-License-Identifier: AGPL-3.0-only
//
// fatigue.go — GET /api/v1/analytics/fatigue?days=30.
//
// The sends-vs-decay curve: bucket the tenant's mailed subscribers
// into deciles by how many emails they received in the window, then
// report per-decile open and unsubscribe rates. A healthy program
// shows flat-ish open rates across deciles; mailbox fatigue shows
// open rate sagging and unsub rate climbing in the top deciles.
//
// The SQL, documented step by step:
//
//   recipient_campaign_outcomes — one row per campaign-recipient pair.
//   Repeated provider rows collapse into booleans for sent, opened, and
//   unsubscribed. This is the fatigue exposure unit: one campaign sent
//   to one recipient, regardless of duplicate webhook delivery.
//
//   per_sub — one row per mailed subscriber in the window:
//     sends  = unique campaign-recipient pairs with a sent event
//     opens  = sent pairs that also have at least one opened event
//     unsubs = sent pairs that also have at least one unsubscribed event
//   Positive outcomes without a matching sent exposure in the selected
//   window are excluded. This keeps both rates bounded to [0,1] without
//   hiding data quality problems behind an output clamp.
//   HAVING sends > 0 — subscribers with no sent exposure in the window
//   have no fatigue exposure and would distort the curve at decile 1.
//
//   deciled — NTILE(10) OVER (ORDER BY sends): equal-population
//   deciles by send volume. Ties on `sends` straddle bucket borders
//   (NTILE semantics); the [min,max] range in each bucket label makes
//   that visible rather than hiding it.
//
//   final SELECT — per decile: the observed sends range, subscriber
//   count, and summed opens/sends/unsubs from which the rates are
//   derived in Go:
//     open_rate  = sum(opens)  / sum(sends)   (opened send exposures)
//     unsub_rate = sum(unsubs) / sum(sends)   (unsubscribed exposures)
//   Both rates share the sends denominator so the two curves are
//   directly comparable on one chart.
//
// Cost: one aggregated pass over the window's events grouped by
// subscriber_email + campaign_id (campaign_report_events is partitioned
// on `at` and carries tenant/campaign and tenant/subscriber indexes),
// then window-function math over the per-subscriber rollup. Tenants
// with fewer than 10 mailed subscribers get fewer buckets — surfaced
// verbatim.

package analytics

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const fatigueMaxDays = 365

var errInvalidFatigueDays = errors.New(
	"fatigue days must be between 1 and 365",
)

// FatigueDecile is one send-volume bucket of the fatigue curve.
type FatigueDecile struct {
	SendsBucket string  `json:"sends_bucket"`
	Subscribers int     `json:"subscribers"`
	OpenRate    float64 `json:"open_rate"`
	UnsubRate   float64 `json:"unsub_rate"`
}

// sendsBucketLabel renders the per-decile sends range ("3-5", or the
// single value "4" when min == max). Pure — unit-tested.
func sendsBucketLabel(lo, hi int) string {
	if lo == hi {
		return strconv.Itoa(lo)
	}
	return fmt.Sprintf("%d-%d", lo, hi)
}

// Fatigue computes the per-decile sends-vs-engagement curve for the
// trailing window. SQL documented in the file header.
func (s *Service) Fatigue(ctx context.Context, tenantID string, days int) ([]FatigueDecile, error) {
	if days < 1 || days > fatigueMaxDays {
		return nil, errInvalidFatigueDays
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
WITH recipient_campaign_outcomes AS (
  SELECT subscriber_email,
         campaign_id,
         BOOL_OR(event_type = 'sent')         AS was_sent,
         BOOL_OR(event_type = 'opened')       AS was_opened,
         BOOL_OR(event_type = 'unsubscribed') AS was_unsubscribed
    FROM campaign_report_events
   WHERE tenant_id = $1::uuid
     AND at >= now() - make_interval(days => $2::int)
     AND subscriber_email IS NOT NULL
   GROUP BY subscriber_email, campaign_id
),
per_sub AS (
  SELECT subscriber_email,
         COUNT(*) FILTER (WHERE was_sent)::int                    AS sends,
         COUNT(*) FILTER (WHERE was_sent AND was_opened)::int     AS opens,
         COUNT(*) FILTER (WHERE was_sent AND was_unsubscribed)::int AS unsubs
    FROM recipient_campaign_outcomes
   GROUP BY subscriber_email
  HAVING COUNT(*) FILTER (WHERE was_sent) > 0
),
deciled AS (
  SELECT sends, opens, unsubs,
         NTILE(10) OVER (ORDER BY sends) AS decile
    FROM per_sub
)
SELECT MIN(sends)::int  AS sends_min,
       MAX(sends)::int  AS sends_max,
       COUNT(*)::int    AS subscribers,
       SUM(sends)::int  AS total_sends,
       SUM(opens)::int  AS total_opens,
       SUM(unsubs)::int AS total_unsubs
  FROM deciled
 GROUP BY decile
 ORDER BY decile`, tenantID, days)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []FatigueDecile{}
	for rows.Next() {
		var lo, hi, subs, sends, opens, unsubs int
		if err := rows.Scan(&lo, &hi, &subs, &sends, &opens, &unsubs); err != nil {
			return nil, err
		}
		out = append(out, FatigueDecile{
			SendsBucket: sendsBucketLabel(lo, hi),
			Subscribers: subs,
			OpenRate:    safeRate(opens, sends),
			UnsubRate:   safeRate(unsubs, sends),
		})
	}
	return out, rows.Err()
}

// FatigueHandler GET /api/v1/analytics/fatigue?days=30.
func (d *ExtendedDeps) FatigueHandler(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	days := 30
	if raw := strings.TrimSpace(r.URL.Query().Get("days")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 || n > fatigueMaxDays {
			writeErr(
				w,
				http.StatusBadRequest,
				"bad_days",
				"days must be an integer between 1 and 365",
			)
			return
		}
		days = n
	}
	deciles, err := d.Service.Fatigue(r.Context(), t.ID, days)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSONResp(w, http.StatusOK, map[string]any{"deciles": deciles})
}
