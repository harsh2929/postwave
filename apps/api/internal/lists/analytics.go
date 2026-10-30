// Package lists — analytics.go owns the per-list analytics surface.
//
// GAP-LS-046 + 060 + 118 (growth / source-mix / engagement-breakdown /
// per-row-engagement), GAP-LS-051 (campaigns-sent-to-this-list),
// GAP-LS-052 (unified activity timeline), GAP-LS-122 (health
// drilldown), and GAP-LS-143 (per-list deliverability score using the
// list_subscribers JOIN instead of the legacy tags @> approximation).
//
// All routes are list-scoped: /api/v1/lists/{id}/...
// All queries open their own WithTenant tx — RLS does the cross-tenant
// filtering. Bigint Listmonk ids are accepted via resolveListUUID so the
// desktop UI (which reads Listmonk's bigint) can hit these without a
// round-trip.

package lists

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

// MountAnalyticsRoutes registers the per-list analytics surface. Kept
// separate from MountRoutes so the existing surface stays untouched —
// the additive contract for this round of changes (GAP-LS-046..143).
func (d *Deps) MountAnalyticsRoutes(r chi.Router) {
	read := r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers))
	read.Get("/api/v1/lists/{id}/growth", d.Growth)
	read.Get("/api/v1/lists/{id}/source-mix", d.SourceMix)
	read.Get("/api/v1/lists/{id}/engagement-breakdown", d.EngagementBreakdown)
	read.Get("/api/v1/lists/{id}/per-row-engagement", d.PerRowEngagement)
	read.Get("/api/v1/lists/{id}/campaigns", d.CampaignsForList)
	read.Get("/api/v1/lists/{id}/activity", d.Activity)
	read.Get("/api/v1/lists/{id}/forms", d.FormsForList)
	read.Get("/api/v1/lists/{id}/automations", d.AutomationsForList)
	read.Get("/api/v1/lists/{id}/health-drilldown", d.HealthDrilldown)
	read.Get("/api/v1/lists/{id}/deliverability", d.Deliverability)
	read.Get("/api/v1/lists/{id}/health-history", d.HealthHistory)
}

// ----------------- shared helpers -----------------

// clampWindowDays mirrors list_health.clampWindowDays — kept private so
// analytics endpoints honour the same 7..365 contract without crossing a
// package boundary.
func clampWindowDays(raw string) int {
	const def, min, max = 30, 1, 365
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return def
	}
	if n < min {
		return min
	}
	if n > max {
		return max
	}
	return n
}

// parseWindowParam reads ?window= as either a plain integer (days) or
// a "30d" / "90d" / "365d" suffix. Falls through to clampWindowDays for
// the actual clamp.
func parseWindowParam(raw string) int {
	raw = strings.TrimSpace(strings.ToLower(raw))
	raw = strings.TrimSuffix(raw, "d")
	return clampWindowDays(raw)
}

// resolveListID is the analytics-side wrapper around resolveListUUID
// that 401s if no tenant is in context. Centralised so every handler
// here reads the same.
func (d *Deps) resolveListID(r *http.Request, w http.ResponseWriter) (string, string, bool) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return "", "", false
	}
	if d.Repo == nil || d.Repo.Pool == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", listsUnavailableMessage))
		return "", "", false
	}
	raw := strings.TrimSpace(chi.URLParam(r, "id"))
	if raw == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_id", "id required"))
		return "", "", false
	}
	listUUID, err := d.Repo.resolveListUUID(r.Context(), t.ID, raw)
	if err != nil {
		if errors.Is(err, ErrListIDNotMapped) {
			httperror.Write(w, http.StatusNotFound, "list_not_found", "list not found")
			return "", "", false
		}
		if errors.Is(err, ErrInvalidListID) {
			httperror.WriteValidation(w, "bad_id", "id must be a positive integer or UUID")
			return "", "", false
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return "", "", false
	}
	return t.ID, listUUID, true
}

// ----------------- GAP-LS-046: growth time-series -----------------

// GrowthPoint is one bucket on the growth chart.
type GrowthPoint struct {
	Date    string `json:"date"` // YYYY-MM-DD UTC
	Added   int64  `json:"added"`
	Removed int64  `json:"removed"`
	Net     int64  `json:"net"`
	Total   int64  `json:"total"` // running total at end of day
}

// Growth GET /api/v1/lists/{id}/growth?window=30d
//
// Daily buckets of added/removed/net + the running total. The running
// total is computed by subtracting net for every day BACKWARD from the
// current snapshot count — that way today's total == current list
// membership count, no matter how far back the window goes.
func (d *Deps) Growth(w http.ResponseWriter, r *http.Request) {
	tenantID, listUUID, ok := d.resolveListID(r, w)
	if !ok {
		return
	}
	windowDays := parseWindowParam(r.URL.Query().Get("window"))

	tx, txErr := db.WithTenant(r.Context(), d.Repo.Pool, tenantID)
	if txErr != nil {
		httperror.WriteInternal(w, d.Logger, txErr, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Current list size: rows where removed_at IS NULL.
	var current int64
	if err := tx.QueryRow(r.Context(), `
SELECT count(*) FROM list_subscribers
 WHERE tenant_id = $1::uuid AND list_id = $2::uuid AND removed_at IS NULL`,
		tenantID, listUUID).Scan(&current); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	since := time.Now().UTC().Add(-time.Duration(windowDays) * 24 * time.Hour)
	rows, txErr := tx.Query(r.Context(), `
WITH adds AS (
    SELECT (added_at AT TIME ZONE 'UTC')::date AS d, count(*)::bigint AS n
      FROM list_subscribers
     WHERE tenant_id = $1::uuid AND list_id = $2::uuid AND added_at >= $3
     GROUP BY (added_at AT TIME ZONE 'UTC')::date
), removes AS (
    SELECT (removed_at AT TIME ZONE 'UTC')::date AS d, count(*)::bigint AS n
      FROM list_subscribers
     WHERE tenant_id = $1::uuid AND list_id = $2::uuid AND removed_at >= $3
     GROUP BY (removed_at AT TIME ZONE 'UTC')::date
), days AS (
    SELECT generate_series($3::date, (now() AT TIME ZONE 'UTC')::date, '1 day'::interval)::date AS d
)
SELECT to_char(days.d, 'YYYY-MM-DD') AS date,
       COALESCE(adds.n, 0)   AS added,
       COALESCE(removes.n, 0) AS removed
  FROM days
  LEFT JOIN adds    ON adds.d = days.d
  LEFT JOIN removes ON removes.d = days.d
 ORDER BY days.d ASC`,
		tenantID, listUUID, since)
	if txErr != nil {
		httperror.WriteInternal(w, d.Logger, txErr, r.Context())
		return
	}
	defer rows.Close()

	type rawDay struct {
		date    string
		added   int64
		removed int64
	}
	collected := make([]rawDay, 0, windowDays)
	for rows.Next() {
		var rd rawDay
		if err := rows.Scan(&rd.date, &rd.added, &rd.removed); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		collected = append(collected, rd)
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	// Walk backward to assign each day a running total. End-of-today
	// total == current. Then total[i-1] == total[i] - net[i].
	points := make([]GrowthPoint, len(collected))
	runningTotal := current
	for i := len(collected) - 1; i >= 0; i-- {
		net := collected[i].added - collected[i].removed
		points[i] = GrowthPoint{
			Date:    collected[i].date,
			Added:   collected[i].added,
			Removed: collected[i].removed,
			Net:     net,
			Total:   runningTotal,
		}
		runningTotal -= net
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"list_id":     listUUID,
		"window_days": windowDays,
		"current":     current,
		"points":      points,
	})
}

// ----------------- GAP-LS-060: source mix -----------------

// SourceMix GET /api/v1/lists/{id}/source-mix
//
// Returns counts by source for currently-active members. The source
// column on list_subscribers is the CHECK enum from migration 0249
// (form/api/csv/integration/admin/migration/listmonk_event).
func (d *Deps) SourceMix(w http.ResponseWriter, r *http.Request) {
	tenantID, listUUID, ok := d.resolveListID(r, w)
	if !ok {
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	rows, err := tx.Query(r.Context(), `
SELECT source, count(*)::bigint
  FROM list_subscribers
 WHERE tenant_id = $1::uuid AND list_id = $2::uuid AND removed_at IS NULL
 GROUP BY source`,
		tenantID, listUUID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()

	// Initialise the known buckets at zero so the response always has
	// the same shape (UI doesn't have to guess which keys exist).
	mix := map[string]int64{
		"form":           0,
		"api":            0,
		"csv":            0,
		"integration":    0,
		"admin":          0,
		"migration":      0,
		"listmonk_event": 0,
	}
	for rows.Next() {
		var src string
		var n int64
		if err := rows.Scan(&src, &n); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		mix[src] = n
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"list_id": listUUID,
		"sources": mix,
	})
}

// ----------------- GAP-LS-060: engagement breakdown -----------------

// EngagementBreakdown GET /api/v1/lists/{id}/engagement-breakdown?window=30d
//
// Counts opens/clicks/unsubs/complaints/bounces over the window,
// restricted to subscribers currently on the list (list_subscribers
// JOIN). Matches the shape the desktop slideover renders for the
// "engagement" tab.
func (d *Deps) EngagementBreakdown(w http.ResponseWriter, r *http.Request) {
	tenantID, listUUID, ok := d.resolveListID(r, w)
	if !ok {
		return
	}
	windowDays := parseWindowParam(r.URL.Query().Get("window"))
	since := time.Now().UTC().Add(-time.Duration(windowDays) * 24 * time.Hour)

	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var opens, clicks, unsubs, complaints, bounces int64
	err = tx.QueryRow(r.Context(), `
SELECT
  count(*) FILTER (WHERE se.event_type = 'opened')        AS opens,
  count(*) FILTER (WHERE se.event_type = 'clicked')       AS clicks,
  count(*) FILTER (WHERE se.event_type = 'unsubscribed')  AS unsubs,
  count(*) FILTER (WHERE se.event_type = 'complained')    AS complaints,
  count(*) FILTER (WHERE se.event_type = 'bounced')       AS bounces
FROM subscriber_events se
WHERE se.tenant_id = $1::uuid
  AND se.at >= $2
  AND se.subscriber_email IN (
      SELECT email FROM list_subscribers
       WHERE tenant_id = $1::uuid
         AND list_id = $3::uuid
         AND removed_at IS NULL
         AND email IS NOT NULL
  )`, tenantID, since, listUUID).Scan(&opens, &clicks, &unsubs, &complaints, &bounces)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"list_id":     listUUID,
		"window_days": windowDays,
		"opens":       opens,
		"clicks":      clicks,
		"unsubs":      unsubs,
		"complaints":  complaints,
		"bounces":     bounces,
	})
}

// ----------------- GAP-LS-118: per-row engagement -----------------

// PerRowEngagement GET /api/v1/lists/{id}/per-row-engagement?subscriber_ids=a,b,c
//
// Per-subscriber open count, click count, last-campaign id, last-sent
// timestamp — sized to render the Members tab table. Caller passes up
// to 500 subscriber ids; we sanity-check the cap because the IN list
// is unbounded otherwise.
func (d *Deps) PerRowEngagement(w http.ResponseWriter, r *http.Request) {
	tenantID, listUUID, ok := d.resolveListID(r, w)
	if !ok {
		return
	}
	const maxIDs = 500
	raw := strings.TrimSpace(r.URL.Query().Get("subscriber_ids"))
	if raw == "" {
		writeJSON(w, http.StatusOK, map[string]any{"list_id": listUUID, "rows": []any{}})
		return
	}
	parts := strings.Split(raw, ",")
	if len(parts) > maxIDs {
		writeJSON(w, http.StatusBadRequest, errEnv("too_many_ids",
			fmt.Sprintf("subscriber_ids capped at %d", maxIDs)))
		return
	}
	ids := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			ids = append(ids, p)
		}
	}
	if len(ids) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"list_id": listUUID, "rows": []any{}})
		return
	}

	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	rows, err := tx.Query(r.Context(), `
SELECT s.id::text,
       s.email::text,
       count(se.*) FILTER (WHERE se.event_type = 'opened')  AS opens,
       count(se.*) FILTER (WHERE se.event_type = 'clicked') AS clicks,
       max(se.at) FILTER (WHERE se.event_type IN ('opened','clicked')) AS last_engaged_at
  FROM subscribers s
  LEFT JOIN subscriber_events se
    ON se.tenant_id = s.tenant_id
   AND se.subscriber_email = s.email
   AND se.at >= now() - interval '90 days'
 WHERE s.tenant_id = $1::uuid
   AND s.id::text = ANY($2::text[])
   AND EXISTS (SELECT 1 FROM list_subscribers ls
                WHERE ls.tenant_id = $1::uuid
                  AND ls.list_id = $3::uuid
                  AND ls.subscriber_id = s.id
                  AND ls.removed_at IS NULL)
 GROUP BY s.id, s.email`, tenantID, ids, listUUID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()

	type row struct {
		ID            string     `json:"id"`
		Email         string     `json:"email"`
		Opens         int64      `json:"opens"`
		Clicks        int64      `json:"clicks"`
		LastEngagedAt *time.Time `json:"last_engaged_at,omitempty"`
	}
	out := make([]row, 0, len(ids))
	for rows.Next() {
		var rrow row
		if err := rows.Scan(&rrow.ID, &rrow.Email, &rrow.Opens, &rrow.Clicks, &rrow.LastEngagedAt); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		out = append(out, rrow)
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"list_id": listUUID, "rows": out})
}

// ----------------- GAP-LS-051: campaigns sent to this list -----------------

// CampaignSummary is one row in the campaigns-for-list response.
type CampaignSummary struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Subject    string     `json:"subject"`
	Status     string     `json:"status"`
	SentAt     *time.Time `json:"sent_at,omitempty"`
	Recipients int64      `json:"recipients"`
	Opens      int64      `json:"opens"`
	Clicks     int64      `json:"clicks"`
}

// CampaignsForList GET /api/v1/lists/{id}/campaigns
//
// Campaigns whose audience_list_id (Listmonk bigint) maps to this list
// (Moosewave uuid) via list_id_map. JOINs campaign_recipients for the
// counts. Limit 100 most-recent.
func (d *Deps) CampaignsForList(w http.ResponseWriter, r *http.Request) {
	tenantID, listUUID, ok := d.resolveListID(r, w)
	if !ok {
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	rows, err := tx.Query(r.Context(), `
WITH bigint_id AS (
    SELECT listmonk_bigint_id FROM list_id_map
     WHERE tenant_id = $1::uuid AND postwave_uuid = $2::uuid
),
matched AS (
    SELECT c.id, c.name, c.subject, c.status, c.sent_at
      FROM campaigns c, bigint_id
     WHERE c.tenant_id = $1::uuid
       AND c.audience_list_id = bigint_id.listmonk_bigint_id
     ORDER BY COALESCE(c.sent_at, c.updated_at) DESC
     LIMIT 100
)
SELECT m.id::text, m.name, m.subject, m.status, m.sent_at,
       count(cr.*)                                        AS recipients,
       count(se.*) FILTER (WHERE se.event_type = 'opened')  AS opens,
       count(se.*) FILTER (WHERE se.event_type = 'clicked') AS clicks
  FROM matched m
  LEFT JOIN campaign_recipients cr ON cr.campaign_id = m.id AND cr.tenant_id = $1::uuid
  LEFT JOIN subscriber_events se
    ON se.tenant_id = $1::uuid
   AND se.campaign_id = m.id
   AND se.event_type IN ('opened','clicked')
 GROUP BY m.id, m.name, m.subject, m.status, m.sent_at
 ORDER BY m.sent_at DESC NULLS LAST`, tenantID, listUUID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()

	out := make([]CampaignSummary, 0, 32)
	for rows.Next() {
		var c CampaignSummary
		if err := rows.Scan(&c.ID, &c.Name, &c.Subject, &c.Status, &c.SentAt, &c.Recipients, &c.Opens, &c.Clicks); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		out = append(out, c)
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"list_id": listUUID, "campaigns": out})
}

// ----------------- GAP-LS-052: unified activity timeline -----------------

// ActivityEvent is one row on the per-list audit timeline.
type ActivityEvent struct {
	At     time.Time      `json:"at"`
	Kind   string         `json:"kind"`
	Email  string         `json:"email,omitempty"`
	Detail map[string]any `json:"detail,omitempty"`
}

// Activity GET /api/v1/lists/{id}/activity?limit=100
//
// Unified feed: subscribes (list_subscribers.added_at), unsubscribes
// (list_subscribers.removed_at), suppression mutations
// (suppression_audit) and listmonk_events imports. The UNION ALL is
// already ordered by at DESC so the limit is honored at the end.
func (d *Deps) Activity(w http.ResponseWriter, r *http.Request) {
	tenantID, listUUID, ok := d.resolveListID(r, w)
	if !ok {
		return
	}
	limit := 100
	if v := strings.TrimSpace(r.URL.Query().Get("limit")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}

	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// One round-trip with UNION ALL — subscription adds, removes, and
	// suppression mutations whose subject email is currently / was once
	// on this list. The suppression branch uses an EXISTS subquery to
	// scope by list membership at any point in time.
	rows, err := tx.Query(r.Context(), `
( SELECT ls.added_at AS at, 'subscribed' AS kind, ls.email::text AS email,
         COALESCE(ls.source, '') AS detail_a, '' AS detail_b
    FROM list_subscribers ls
   WHERE ls.tenant_id = $1::uuid AND ls.list_id = $2::uuid
   ORDER BY ls.added_at DESC LIMIT $3 )
UNION ALL
( SELECT ls.removed_at AS at, 'unsubscribed' AS kind, ls.email::text AS email,
         COALESCE(ls.source, '') AS detail_a, '' AS detail_b
    FROM list_subscribers ls
   WHERE ls.tenant_id = $1::uuid AND ls.list_id = $2::uuid
     AND ls.removed_at IS NOT NULL
   ORDER BY ls.removed_at DESC LIMIT $3 )
UNION ALL
( SELECT sa.created_at AS at, 'suppression_' || sa.action AS kind,
         sa.email::text AS email,
         COALESCE(sa.reason, '') AS detail_a,
         COALESCE(sa.source_table, '') AS detail_b
    FROM suppression_audit sa
   WHERE sa.tenant_id = $1::uuid
     AND EXISTS (SELECT 1 FROM list_subscribers ls
                  WHERE ls.tenant_id = $1::uuid
                    AND ls.list_id = $2::uuid
                    AND ls.email = sa.email)
   ORDER BY sa.created_at DESC LIMIT $3 )
ORDER BY at DESC NULLS LAST
LIMIT $3`, tenantID, listUUID, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()

	out := make([]ActivityEvent, 0, limit)
	for rows.Next() {
		var at *time.Time
		var kind, email, detailA, detailB string
		if err := rows.Scan(&at, &kind, &email, &detailA, &detailB); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		if at == nil {
			continue
		}
		ev := ActivityEvent{At: *at, Kind: kind, Email: email}
		if detailA != "" || detailB != "" {
			ev.Detail = map[string]any{}
			if detailA != "" {
				ev.Detail["source"] = detailA
			}
			if detailB != "" {
				ev.Detail["table"] = detailB
			}
		}
		out = append(out, ev)
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"list_id": listUUID, "events": out})
}

// ----------------- GAP-LS-053: forms feeding this list -----------------

// FormSummary is one form-feeding-this-list row.
type FormSummary struct {
	ID        string    `json:"id"`
	Slug      string    `json:"slug"`
	Name      string    `json:"name"`
	Status    string    `json:"status"`
	OptInMode string    `json:"opt_in_mode"`
	UpdatedAt time.Time `json:"updated_at"`
}

// FormsForList GET /api/v1/lists/{id}/forms
//
// Forms whose settings->>'targetListId' equals the Listmonk bigint id
// that maps to this list. We resolve the bigint via list_id_map.
//
// Keyset pagination on (f.updated_at, f.id). updated_at is mutable, so a
// form edited concurrently with pagination may shift between pages —
// acceptable for this admin list. Default page size preserves the prior
// LIMIT 100 (no row-count regression when ?limit= is omitted).
func (d *Deps) FormsForList(w http.ResponseWriter, r *http.Request) {
	tenantID, listUUID, ok := d.resolveListID(r, w)
	if !ok {
		return
	}
	limit, cursor, paramsErr := pagination.ReadParamsWithDefault(r.URL.Query(), 100, pagination.MaxLimit)
	if paramsErr != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_cursor", "cursor is malformed"))
		return
	}
	tx, paramsErr := db.WithTenant(r.Context(), d.Repo.Pool, tenantID)
	if paramsErr != nil {
		httperror.WriteInternal(w, d.Logger, paramsErr, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// $1 tenant, $2 list, $3 limit+1; the keyset bound (when paging)
	// takes $4/$5.
	args := []any{tenantID, listUUID, limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (f.updated_at, f.id) < ($4::timestamptz, $5::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}

	// Two possible storage shapes: the targetListId in settings could
	// have been stored as a JSON number (most common) OR as a JSON
	// string (older import paths). Match both via ::text on the value.
	rows, err := tx.Query(r.Context(), `
WITH bigint_id AS (
    SELECT listmonk_bigint_id FROM list_id_map
     WHERE tenant_id = $1::uuid AND postwave_uuid = $2::uuid
)
SELECT f.id::text, f.slug::text, f.name, f.status,
       COALESCE(f.opt_in_mode, 'single'), f.updated_at
  FROM forms f, bigint_id
 WHERE f.tenant_id = $1::uuid
   AND f.settings IS NOT NULL
   AND (
        (f.settings ->> 'targetListId') = bigint_id.listmonk_bigint_id::text
   )
 `+keyset+`
 ORDER BY f.updated_at DESC, f.id DESC
 LIMIT $3`, args...)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()

	out := make([]FormSummary, 0, 16)
	for rows.Next() {
		var f FormSummary
		if err := rows.Scan(&f.ID, &f.Slug, &f.Name, &f.Status, &f.OptInMode, &f.UpdatedAt); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		out = append(out, f)
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	out, more := pagination.HasMore(out, limit)
	next := ""
	if more {
		last := out[len(out)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.UpdatedAt, ID: last.ID})
	}
	resp := map[string]any{"list_id": listUUID, "forms": out}
	if next != "" {
		resp["nextCursor"] = next
	}
	writeJSON(w, http.StatusOK, resp)
}

// ----------------- GAP-LS-054: automations gating on this list -----------------

// AutomationSummary is one entry on the automations-for-list response.
type AutomationSummary struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Status    string    `json:"status"`
	UpdatedAt time.Time `json:"updated_at"`
}

// AutomationsForList GET /api/v1/lists/{id}/automations
//
// Automations whose triggers/nodes/edges JSONB references this list's
// id. The match is intentionally broad — automation AST shapes vary by
// migration source — so we look for the listmonk bigint id AND the
// postwave uuid anywhere in the trigger/node tree via a text search.
//
// Keyset pagination on (updated_at, id). updated_at is mutable, so an
// automation edited concurrently with pagination may shift between pages
// — acceptable for this admin list. Default page size preserves the
// prior LIMIT 100 (no row-count regression when ?limit= is omitted).
func (d *Deps) AutomationsForList(w http.ResponseWriter, r *http.Request) {
	tenantID, listUUID, ok := d.resolveListID(r, w)
	if !ok {
		return
	}
	limit, cursor, err := pagination.ReadParamsWithDefault(r.URL.Query(), 100, pagination.MaxLimit)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_cursor", "cursor is malformed"))
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Resolve bigint mapping in-line — automations migrated from
	// Listmonk store the bigint id; native postwave automations would
	// store the uuid.
	var bigintID *int64
	if err := tx.QueryRow(r.Context(), `
SELECT listmonk_bigint_id FROM list_id_map
 WHERE tenant_id = $1::uuid AND postwave_uuid = $2::uuid`,
		tenantID, listUUID).Scan(&bigintID); err != nil && err != pgx.ErrNoRows {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	bigintNeedle := ""
	if bigintID != nil {
		bigintNeedle = strconv.FormatInt(*bigintID, 10)
	}

	// $1 tenant, $2 list, $3 bigintNeedle, $4 limit+1; the keyset bound
	// (when paging) takes $5/$6.
	args := []any{tenantID, listUUID, bigintNeedle, limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (updated_at, id) < ($5::timestamptz, $6::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}

	rows, paramsErr := tx.Query(r.Context(), `
SELECT id::text, name, status, updated_at
  FROM automations
 WHERE tenant_id = $1::uuid
   AND (
        triggers::text LIKE '%' || $2 || '%'
     OR nodes::text    LIKE '%' || $2 || '%'
     OR ($3 <> '' AND triggers::text LIKE '%' || $3 || '%')
     OR ($3 <> '' AND nodes::text    LIKE '%' || $3 || '%')
   )
 `+keyset+`
 ORDER BY updated_at DESC, id DESC
 LIMIT $4`, args...)
	if paramsErr != nil {
		httperror.WriteInternal(w, d.Logger, paramsErr, r.Context())
		return
	}
	defer rows.Close()

	out := make([]AutomationSummary, 0, 16)
	for rows.Next() {
		var a AutomationSummary
		if err := rows.Scan(&a.ID, &a.Name, &a.Status, &a.UpdatedAt); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	out, more := pagination.HasMore(out, limit)
	next := ""
	if more {
		last := out[len(out)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.UpdatedAt, ID: last.ID})
	}
	resp := map[string]any{"list_id": listUUID, "automations": out}
	if next != "" {
		resp["nextCursor"] = next
	}
	writeJSON(w, http.StatusOK, resp)
}

// ----------------- GAP-LS-122: health drilldown -----------------

// HealthDrilldown GET /api/v1/lists/{id}/health-drilldown?window=90d
//
// Joins the per-list health metrics back to the specific campaigns +
// events that drove them, so the UI can link from "bounce rate 4%" to
// the 12 campaigns whose bounces add up to that number.
func (d *Deps) HealthDrilldown(w http.ResponseWriter, r *http.Request) {
	tenantID, listUUID, ok := d.resolveListID(r, w)
	if !ok {
		return
	}
	windowDays := parseWindowParam(r.URL.Query().Get("window"))
	since := time.Now().UTC().Add(-time.Duration(windowDays) * 24 * time.Hour)

	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Top campaigns by bounce/complaint/unsub volume for the list.
	rows, err := tx.Query(r.Context(), `
WITH list_emails AS (
    SELECT email FROM list_subscribers
     WHERE tenant_id = $1::uuid AND list_id = $2::uuid AND removed_at IS NULL
)
SELECT c.id::text, c.name, c.subject,
       count(*) FILTER (WHERE se.event_type = 'bounced')      AS bounces,
       count(*) FILTER (WHERE se.event_type = 'complained')   AS complaints,
       count(*) FILTER (WHERE se.event_type = 'unsubscribed') AS unsubs
  FROM subscriber_events se
  JOIN list_emails le ON le.email = se.subscriber_email
  JOIN campaigns   c  ON c.id = se.campaign_id AND c.tenant_id = se.tenant_id
 WHERE se.tenant_id = $1::uuid
   AND se.at >= $3
   AND se.event_type IN ('bounced','complained','unsubscribed')
 GROUP BY c.id, c.name, c.subject
 ORDER BY (count(*) FILTER (WHERE se.event_type = 'bounced')
         + count(*) FILTER (WHERE se.event_type = 'complained')
         + count(*) FILTER (WHERE se.event_type = 'unsubscribed')) DESC
 LIMIT 25`, tenantID, listUUID, since)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()

	type campaignContribution struct {
		ID         string `json:"id"`
		Name       string `json:"name"`
		Subject    string `json:"subject"`
		Bounces    int64  `json:"bounces"`
		Complaints int64  `json:"complaints"`
		Unsubs     int64  `json:"unsubs"`
	}
	out := make([]campaignContribution, 0, 25)
	for rows.Next() {
		var c campaignContribution
		if err := rows.Scan(&c.ID, &c.Name, &c.Subject, &c.Bounces, &c.Complaints, &c.Unsubs); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		out = append(out, c)
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"list_id":       listUUID,
		"window_days":   windowDays,
		"top_campaigns": out,
		"description":   "campaigns ranked by total negative-engagement events on this list within the window",
	})
}

// ----------------- GAP-LS-143: per-list deliverability score -----------------

// Deliverability GET /api/v1/lists/{id}/deliverability?window_days=90
//
// Per-list deliverability score using the list_subscribers JOIN — the
// successor to the tags @> approximation in list_health.go. Preserves
// the Score response shape (same fields, same grade bands) so the
// existing UI can read it without changes.
//
// The actual scoring algorithm matches list_health.scoreAndGrade — we
// duplicate the bands inline rather than crossing a package boundary
// because list_health was tags-scoped and rewriting it would shift its
// public surface (and the GAP requires preserving that surface).
func (d *Deps) Deliverability(w http.ResponseWriter, r *http.Request) {
	tenantID, listUUID, ok := d.resolveListID(r, w)
	if !ok {
		return
	}
	windowDays := clampWindowDays(r.URL.Query().Get("window_days"))
	since := time.Now().UTC().Add(-time.Duration(windowDays) * 24 * time.Hour)

	s, err := d.Repo.ComputeListDeliverability(r.Context(), tenantID, listUUID, since, windowDays)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, s)
}

// ListDeliverability is the Score-shaped projection. Field names mirror
// list_health.Score so the desktop ListHealthBadge can render the
// per-list response identically.
type ListDeliverability struct {
	ListID             string   `json:"list_id"`
	WindowDays         int      `json:"window_days"`
	TotalSubscribers   int64    `json:"total_subscribers"`
	ActiveSubscribers  int64    `json:"active_subscribers"`
	EngagedSubscribers int64    `json:"engaged_subscribers"`
	BlocklistedCount   int64    `json:"blocklisted_count"`
	Bounces            int64    `json:"bounces"`
	Complaints         int64    `json:"complaints"`
	Unsubscribes       int64    `json:"unsubscribes"`
	BounceRate         float64  `json:"bounce_rate"`
	ComplaintRate      float64  `json:"complaint_rate"`
	UnsubscribeRate    float64  `json:"unsubscribe_rate"`
	EngagementRate     float64  `json:"engagement_rate"`
	SuppressionRate    float64  `json:"suppression_rate"`
	Score              int      `json:"score"`
	Grade              string   `json:"grade"`
	Notes              []string `json:"notes"`
}

// ComputeListDeliverability runs the per-list scoring against the
// list_subscribers JOIN. The query plan is similar to list_health but
// scoped via the JOIN instead of subscribers.tags @>.
func (r *Repo) ComputeListDeliverability(ctx context.Context, tenantID, listUUID string, since time.Time, windowDays int) (ListDeliverability, error) {
	out := ListDeliverability{ListID: listUUID, WindowDays: windowDays, Notes: []string{}}
	if r == nil || r.Pool == nil {
		return out, fmt.Errorf("lists: repo not configured")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Subscriber-level counts via the JOIN. Total counts every
	// non-removed list member; active narrows to status='enabled';
	// blocklisted narrows to status='blocklisted'.
	if err := tx.QueryRow(ctx, `
SELECT count(*)::bigint AS total,
       count(*) FILTER (WHERE s.status = 'enabled')     ::bigint AS active,
       count(*) FILTER (WHERE s.status = 'blocklisted') ::bigint AS blocklisted
  FROM list_subscribers ls
  JOIN subscribers s ON s.id = ls.subscriber_id
 WHERE ls.tenant_id = $1::uuid
   AND ls.list_id   = $2::uuid
   AND ls.removed_at IS NULL`,
		tenantID, listUUID).Scan(&out.TotalSubscribers, &out.ActiveSubscribers, &out.BlocklistedCount); err != nil {
		return out, err
	}

	// Window-scoped event counts. The IN subquery is the list JOIN
	// surfaced as an email predicate — identical to engagement
	// breakdown but with the (opened|clicked) DISTINCT for engagement.
	if err := tx.QueryRow(ctx, `
SELECT
  count(*) FILTER (WHERE se.event_type = 'bounced')      ::bigint AS bounces,
  count(*) FILTER (WHERE se.event_type = 'complained')   ::bigint AS complaints,
  count(*) FILTER (WHERE se.event_type = 'unsubscribed') ::bigint AS unsubs,
  count(DISTINCT se.subscriber_email) FILTER (
      WHERE se.event_type IN ('opened','clicked')
  )::bigint AS engaged
FROM subscriber_events se
WHERE se.tenant_id = $1::uuid
  AND se.at >= $2
  AND se.subscriber_email IN (
      SELECT email FROM list_subscribers
       WHERE tenant_id = $1::uuid
         AND list_id   = $3::uuid
         AND removed_at IS NULL
         AND email IS NOT NULL
  )`, tenantID, since, listUUID).Scan(&out.Bounces, &out.Complaints, &out.Unsubscribes, &out.EngagedSubscribers); err != nil {
		return out, err
	}
	if err := tx.Commit(ctx); err != nil {
		return out, err
	}

	denomActive := float64(out.ActiveSubscribers)
	if denomActive < 1 {
		denomActive = 1
	}
	denomTotal := float64(out.TotalSubscribers)
	if denomTotal < 1 {
		denomTotal = 1
	}
	out.BounceRate = float64(out.Bounces) / denomActive
	out.ComplaintRate = float64(out.Complaints) / denomActive
	out.UnsubscribeRate = float64(out.Unsubscribes) / denomActive
	out.EngagementRate = float64(out.EngagedSubscribers) / denomActive
	out.SuppressionRate = float64(out.BlocklistedCount) / denomTotal
	out.Score, out.Grade, out.Notes = listScoreAndGrade(out)
	return out, nil
}

// listScoreAndGrade mirrors list_health.scoreAndGrade. Duplicated on
// purpose: list_health is tag-scoped (preserved per GAP-LS-143's
// "preserve the existing API shape" note), and this scoring path needs
// the same thresholds without a cross-package coupling that would force
// list_health to widen.
func listScoreAndGrade(s ListDeliverability) (int, string, []string) {
	score := 100.0
	notes := []string{}
	if s.BounceRate > 0.005 {
		extraPP := (s.BounceRate - 0.005) * 100
		score -= extraPP * 2.0
		notes = append(notes, fmt.Sprintf("bounce rate %.2f%% over 0.5%% threshold", s.BounceRate*100))
	}
	if s.ComplaintRate > 0.0005 {
		extraPP := (s.ComplaintRate - 0.0005) * 100
		score -= extraPP * 50.0
		notes = append(notes, fmt.Sprintf("complaint rate %.3f%% over 0.05%% threshold", s.ComplaintRate*100))
	}
	if s.EngagementRate < 0.15 && s.ActiveSubscribers > 100 {
		gapPP := (0.15 - s.EngagementRate) * 100
		score -= gapPP * 0.5
		notes = append(notes, fmt.Sprintf("engagement %.1f%% below 15%% — consider sunset", s.EngagementRate*100))
	}
	if s.UnsubscribeRate > 0.02 {
		extraPP := (s.UnsubscribeRate - 0.02) * 100
		score -= extraPP * 1.5
		notes = append(notes, fmt.Sprintf("unsub rate %.2f%% above 2%% threshold", s.UnsubscribeRate*100))
	}
	if s.SuppressionRate > 0.05 {
		extraPP := (s.SuppressionRate - 0.05) * 100
		score -= extraPP * 0.5
		notes = append(notes, fmt.Sprintf("%.1f%% of subscribers are blocklisted", s.SuppressionRate*100))
	}
	if score < 0 {
		score = 0
	}
	rounded := int(score + 0.5)
	grade := "F"
	switch {
	case rounded >= 90:
		grade = "A"
	case rounded >= 75:
		grade = "B"
	case rounded >= 60:
		grade = "C"
	case rounded >= 40:
		grade = "D"
	}
	if len(notes) == 0 {
		notes = append(notes, "all health indicators within ESP-industry safe thresholds")
	}
	return rounded, grade, notes
}

// ----------------- GAP-LS-119: per-list health history -----------------

// HealthHistoryPoint is one daily snapshot from list_health_history.
type HealthHistoryPoint struct {
	SampledAt       time.Time `json:"sampled_at"`
	Score           int       `json:"score"`
	Grade           string    `json:"grade"`
	BounceRate      float64   `json:"bounce_rate"`
	ComplaintRate   float64   `json:"complaint_rate"`
	UnsubscribeRate float64   `json:"unsubscribe_rate"`
	EngagementRate  float64   `json:"engagement_rate"`
}

// HealthHistory GET /api/v1/lists/{id}/health-history?window_days=90
//
// Reads from list_health_history (migration 0251), populated by the
// daily history worker. Returns up to N=window_days snapshots ordered
// oldest -> newest so the chart can plot left-to-right.
func (d *Deps) HealthHistory(w http.ResponseWriter, r *http.Request) {
	tenantID, listUUID, ok := d.resolveListID(r, w)
	if !ok {
		return
	}
	windowDays := clampWindowDays(r.URL.Query().Get("window_days"))
	since := time.Now().UTC().Add(-time.Duration(windowDays) * 24 * time.Hour)

	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	rows, err := tx.Query(r.Context(), `
SELECT sampled_at, score, grade,
       bounce_rate::float8, complaint_rate::float8,
       unsubscribe_rate::float8, engagement_rate::float8
  FROM list_health_history
 WHERE tenant_id = $1::uuid
   AND list_id   = $2::uuid
   AND sampled_at >= $3
 ORDER BY sampled_at ASC`, tenantID, listUUID, since)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()

	out := make([]HealthHistoryPoint, 0, windowDays)
	for rows.Next() {
		var p HealthHistoryPoint
		if err := rows.Scan(&p.SampledAt, &p.Score, &p.Grade,
			&p.BounceRate, &p.ComplaintRate, &p.UnsubscribeRate, &p.EngagementRate); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		out = append(out, p)
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"list_id":     listUUID,
		"window_days": windowDays,
		"history":     out,
	})
}

// jsonOK is a tiny helper for the test suite to assert response shape
// without a roundtrip through writeJSON. Kept available for future
// internal callers; unused today.
var _ = json.Marshal
