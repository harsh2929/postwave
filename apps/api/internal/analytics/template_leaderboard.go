// SPDX-License-Identifier: AGPL-3.0-only
//
// template_leaderboard.go — GET /api/v1/analytics/template-leaderboard.
//
// Ranks campaign templates by the engagement of the campaigns built
// from them: campaigns_used, sent, opens, clicks plus derived
// open_rate / click_rate, over a trailing ?days= window (default 90),
// capped at the top 50 by sends.
//
// Attribution:
//
//   campaigns.source_template_id is the canonical lineage written by the
//   create-from-template flow. It always wins, including when a subject is
//   edited or multiple templates share one subject. Campaigns created before
//   that column was populated may use the explicitly marked legacy fallback:
//
//     1. c.delivery_settings->>'template_id' when present, else
//     2. exact non-empty subject match.
//
//   Legacy matching is considered only when source_template_id IS NULL, so a
//   stale subject/delivery setting can never override or compete with exact
//   lineage. Each campaign attributes to at most one tenant-visible template.
//   Campaigns matching no template are simply absent — the endpoint
//   reports template performance, not campaign coverage.
//
// Cost: the events table is scanned once for the bounded window, then grouped
// by campaign + delivery identity before attribution. A delivery identity uses
// message_id when present, otherwise normalized subscriber_email, otherwise a
// conservative source/provider-event/id fallback. Opens and clicks count once
// and only when that identity also has a sent event inside the same window, so
// retries and historical sends cannot produce rates above 100%.

package analytics

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// templateLeaderboardCap bounds the response size.
const templateLeaderboardCap = 50

const (
	templateLeaderboardDefaultDays = 90
	templateLeaderboardMaxDays     = 365
)

var errInvalidTemplateLeaderboardDays = errors.New("template leaderboard days must be between 1 and 365")

const templateLeaderboardQuery = `
WITH window_events AS (
  -- One bounded base-table scan. Prefer message identity; email is the stable
  -- fallback for older events. The final fallback is intentionally row-unique:
  -- without a message or recipient identity we cannot safely attribute an
  -- open/click to a different sent event.
  SELECT campaign_id, event_type,
         CASE
           WHEN NULLIF(BTRIM(message_id), '') IS NOT NULL
             THEN 'message:' || BTRIM(message_id)
           WHEN NULLIF(BTRIM(subscriber_email::text), '') IS NOT NULL
             THEN 'email:' || LOWER(BTRIM(subscriber_email::text))
           ELSE 'provider:' || COALESCE(NULLIF(BTRIM(source), ''), 'unknown')
                || ':' || COALESCE(NULLIF(BTRIM(provider_event_id), ''), id::text)
         END AS delivery_identity
   FROM campaign_report_events
   WHERE tenant_id = $1::uuid
     AND at >= now() - make_interval(days => $2::int)
     AND event_type IN ('sent', 'opened', 'clicked')
),
delivery_events AS (
  SELECT campaign_id, delivery_identity,
         BOOL_OR(event_type = 'sent')    AS was_sent,
         BOOL_OR(event_type = 'opened')  AS was_opened,
         BOOL_OR(event_type = 'clicked') AS was_clicked
    FROM window_events
   GROUP BY campaign_id, delivery_identity
),
ev AS (
  SELECT campaign_id,
         COUNT(*) FILTER (WHERE was_sent)::int                 AS sent,
         COUNT(*) FILTER (WHERE was_sent AND was_opened)::int  AS opens,
         COUNT(*) FILTER (WHERE was_sent AND was_clicked)::int AS clicks
    FROM delivery_events
   GROUP BY campaign_id
  HAVING BOOL_OR(was_sent)
),
attributed AS (
  SELECT t.id AS template_id, t.name AS template_name,
         ev.campaign_id, ev.sent, ev.opens, ev.clicks
    FROM ev
    JOIN campaigns c
      ON c.id = ev.campaign_id AND c.tenant_id = $1::uuid
    JOIN LATERAL (
      SELECT tpl.id, tpl.name
        FROM campaign_templates tpl
       WHERE (tpl.tenant_id = $1::uuid OR tpl.tenant_id IS NULL)
         AND tpl.review_status <> 'rejected'
         AND (
           tpl.id = c.source_template_id
           OR (
             c.source_template_id IS NULL
             AND (
               COALESCE(c.delivery_settings->>'template_id', '') = tpl.id::text
               OR (tpl.subject <> '' AND tpl.subject = c.subject)
             )
           )
         )
       ORDER BY
         (tpl.id = c.source_template_id) DESC,
         (COALESCE(c.delivery_settings->>'template_id', '') = tpl.id::text) DESC,
         (tpl.tenant_id IS NOT NULL) DESC,
         tpl.created_at
       LIMIT 1
    ) t ON true
)
SELECT template_id::text, template_name,
       COUNT(DISTINCT campaign_id)::int AS campaigns_used,
       COALESCE(SUM(sent), 0)::int,
       COALESCE(SUM(opens), 0)::int,
       COALESCE(SUM(clicks), 0)::int
  FROM attributed
 GROUP BY template_id, template_name
 ORDER BY SUM(sent) DESC, campaigns_used DESC, template_name
 LIMIT $3::int`

// TemplateLeaderboardItem is one ranked template.
type TemplateLeaderboardItem struct {
	TemplateID    string  `json:"template_id"`
	TemplateName  string  `json:"template_name"`
	CampaignsUsed int     `json:"campaigns_used"`
	Sent          int     `json:"sent"`
	Opens         int     `json:"opens"`
	Clicks        int     `json:"clicks"`
	OpenRate      float64 `json:"open_rate"`
	ClickRate     float64 `json:"click_rate"`
}

// safeRate returns n/d rounded to 4 decimal places, 0 when d == 0.
// Pure — unit-tested.
func safeRate(n, d int) float64 {
	if d <= 0 || n <= 0 {
		return 0
	}
	if n >= d {
		return 1
	}
	return float64(int64(float64(n)/float64(d)*10000+0.5)) / 10000
}

// TemplateLeaderboard aggregates per-template campaign engagement for
// the trailing window. See the file header for attribution semantics.
func (s *Service) TemplateLeaderboard(ctx context.Context, tenantID string, days int) ([]TemplateLeaderboardItem, error) {
	if days < 1 || days > templateLeaderboardMaxDays {
		return nil, errInvalidTemplateLeaderboardDays
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, templateLeaderboardQuery, tenantID, days, templateLeaderboardCap)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []TemplateLeaderboardItem{}
	for rows.Next() {
		var it TemplateLeaderboardItem
		if err := rows.Scan(&it.TemplateID, &it.TemplateName,
			&it.CampaignsUsed, &it.Sent, &it.Opens, &it.Clicks); err != nil {
			return nil, err
		}
		it.OpenRate = safeRate(it.Opens, it.Sent)
		it.ClickRate = safeRate(it.Clicks, it.Sent)
		out = append(out, it)
	}
	return out, rows.Err()
}

// TemplateLeaderboardHandler GET /api/v1/analytics/template-leaderboard?days=90.
func (d *ExtendedDeps) TemplateLeaderboardHandler(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	days := templateLeaderboardDefaultDays
	if raw := strings.TrimSpace(r.URL.Query().Get("days")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > templateLeaderboardMaxDays {
			writeErr(w, http.StatusBadRequest, "bad_days", "days must be an integer between 1 and 365")
			return
		}
		days = n
	}
	items, err := d.Service.TemplateLeaderboard(r.Context(), t.ID, days)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSONResp(w, http.StatusOK, map[string]any{"items": items})
}
