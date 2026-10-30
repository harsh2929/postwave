// SPDX-License-Identifier: AGPL-3.0-only
//
// G15 (campaigns 2026): per-campaign conversion goal results. Computes
// conversion_count / conversion_rate / attributed_revenue for the
// campaign's configured goal_event within goal_window_hours of the send,
// from the conversions table (migration 0049). Distinct from the
// analytics revenue report, which is hardcoded to a 7-day window over
// paid_subscriptions only.

package campaigns

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// GoalResults is the response of GET /campaigns/{id}/goal-results.
type GoalResults struct {
	CampaignID          string  `json:"campaign_id"`
	GoalEvent           string  `json:"goal_event"`
	GoalWindowHours     int     `json:"goal_window_hours"`
	Configured          bool    `json:"configured"`
	ConversionCount     int     `json:"conversion_count"`
	ConvertedRecipients int     `json:"converted_recipients"`
	Recipients          int     `json:"recipients"`
	ConversionRate      float64 `json:"conversion_rate"`
	AttributedRevenue   int64   `json:"attributed_revenue_cents"`
	Currency            string  `json:"currency,omitempty"`
	RevenueStatus       string  `json:"revenue_status"`
}

// MountGoalResults wires GET /api/v1/campaigns/{id}/goal-results.
func MountGoalResults(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Get("/api/v1/campaigns/{id}/goal-results", d.goalResults)
}

func (d *Deps) goalResults(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	campaignID := chi.URLParam(r, "id")

	c, err := d.Repo.Get(r.Context(), t.ID, campaignID)
	if err != nil {
		if err == ErrNotFound {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "campaign not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	out := GoalResults{
		CampaignID:      campaignID,
		GoalEvent:       c.GoalEvent,
		GoalWindowHours: c.GoalWindowHours,
		Configured:      c.GoalEvent != "" && c.GoalWindowHours > 0,
		RevenueStatus:   "none",
	}
	if !out.Configured {
		writeJSON(w, http.StatusOK, out)
		return
	}

	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Recipients (deliverable denominator) = distinct subscribers sent.
	if err := tx.QueryRow(r.Context(), `
SELECT count(DISTINCT subscriber_email)::int
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid AND event_type = 'sent'`,
		t.ID, campaignID,
	).Scan(&out.Recipients); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	// Match identified conversions to that recipient's first actual send.
	// The old max(at) across all recipients started everyone's window when
	// the LAST recipient was sent, dropping legitimate early conversions.
	// Explicitly campaign-attributed anonymous conversions use the campaign's
	// first send as their conservative fallback anchor. No send means no goal
	// result; never turn a report-query error into a credible-looking zero.
	var currency *string
	err = tx.QueryRow(r.Context(), `
WITH recipient_sends AS (
  SELECT lower(subscriber_email::text) AS email, min(at) AS first_sent_at
    FROM campaign_report_events
   WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid AND event_type = 'sent'
     AND subscriber_email IS NOT NULL
   GROUP BY lower(subscriber_email::text)
), first_send AS (
  SELECT min(at) AS first_sent_at
    FROM campaign_report_events
   WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid AND event_type = 'sent'
), matched AS (
  SELECT c.subscriber_email, c.amount_cents, c.currency
  FROM conversions c
  CROSS JOIN first_send first_campaign_send
  LEFT JOIN recipient_sends sent
    ON sent.email = lower(c.subscriber_email::text)
 WHERE c.tenant_id = $1::uuid
   AND c.campaign_id = $2::uuid
   AND c.event_name = $3
   AND (c.subscriber_email IS NULL OR sent.email IS NOT NULL)
   AND c.occurred_at >= COALESCE(sent.first_sent_at, first_campaign_send.first_sent_at)
	AND c.occurred_at <= COALESCE(sent.first_sent_at, first_campaign_send.first_sent_at) + make_interval(hours => $4)
), totals AS (
  SELECT count(*)::int AS conversions,
         count(DISTINCT subscriber_email)::int AS converted_recipients,
         COALESCE(sum(amount_cents), 0)::bigint AS revenue,
         count(DISTINCT currency) FILTER (WHERE amount_cents IS NOT NULL) AS currencies,
         count(*) FILTER (WHERE amount_cents IS NOT NULL AND (currency IS NULL OR btrim(currency) = '')) AS missing_currency,
         min(currency) FILTER (WHERE amount_cents IS NOT NULL) AS currency
    FROM matched
)
SELECT conversions, converted_recipients,
       CASE WHEN currencies = 1 AND missing_currency = 0 THEN revenue ELSE 0 END,
       CASE WHEN currencies = 1 AND missing_currency = 0 THEN currency ELSE NULL END,
       CASE WHEN missing_currency > 0 THEN 'missing_currency'
            WHEN currencies > 1 THEN 'mixed_currency'
            WHEN currencies = 1 THEN 'single_currency'
            ELSE 'none' END
  FROM totals`,
		t.ID, campaignID, out.GoalEvent, out.GoalWindowHours,
	).Scan(&out.ConversionCount, &out.ConvertedRecipients, &out.AttributedRevenue, &currency, &out.RevenueStatus)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if currency != nil {
		out.Currency = *currency
	}
	if out.Recipients > 0 {
		out.ConversionRate = float64(out.ConvertedRecipients) / float64(out.Recipients)
	}
	writeJSON(w, http.StatusOK, out)
}
