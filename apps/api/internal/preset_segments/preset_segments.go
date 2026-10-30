// SPDX-License-Identifier: AGPL-3.0-only
//
// Package preset_segments exposes one-click "engagement segment"
// counts that operators reach for constantly: "engaged in last
// 30 days", "cold for 90 days", "new in last 7 days", etc.
//
// The existing segments package handles arbitrary custom
// definitions; this package is the curated short-list. The
// presets are computed via raw SQL against subscribers +
// subscriber_events so they don't need to be materialized into
// the `segments` table to count — answering "how big is each
// bucket today?" is the common operator question this addresses.
//
// Each preset returns:
//
//   * key            machine-friendly id ('engaged_30d', etc.)
//   * label          human label
//   * count          live count for this tenant
//   * description    one-line operator-facing explanation
//
// Surfaces:
//
//   GET /api/v1/preset-segments              all preset counts (single round-trip)
//   GET /api/v1/preset-segments/{key}/list   page through the actual subscribers

package preset_segments

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

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
}

// Preset is one preset definition.
type Preset struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Description string `json:"description"`
	Count       int64  `json:"count"`
}

// preset registry. Each preset carries two parallel SQL fragments:
//
//   - filterExpr — used inside `count(*) FILTER (WHERE ...)` in the
//     bulk List query. It references the `engagement` CTE (alias
//     `ev`) which is pre-aggregated once per (tenant, subscriber);
//     this avoids the per-row correlated subqueries the old shape
//     required.
//   - predicate — the original per-subscriber predicate, kept for the
//     ListSubscribers paging endpoint. That path already filters by
//     status and LIMIT/OFFSET so the correlated-subquery cost stays
//     bounded; rewriting it on the CTE would also work but would
//     materialize the CTE for every page request.
//
// Both strings are embedded directly — never interpolate user input.
//
// Neither fragment decides WHO is in scope: every query ANDs the rule with
// audiencePopulation, so a preset cannot forget the archive exclusion.
type presetDef struct {
	key         string
	label       string
	description string
	filterExpr  string // count(*) FILTER expression against subscribers s LEFT JOIN engagement ev
	predicate   string // per-row predicate for the paged list endpoint
}

// audiencePopulation is the population every preset is evaluated over: the
// same definition saved segments use (segments.DefinitionPopulation(false) —
// active contacts only, archived excluded). The recipes used to count
// archived contacts, so a card could disagree with the segment its "Review
// recipe" produced; on staging "New (joined in last 7 days)" listed only
// archived contacts.
const audiencePopulation = `s.archived_at IS NULL`

var presets = []presetDef{
	{
		key:         "engaged_30d",
		label:       "Engaged (last 30 days)",
		description: "subscribers with at least one open or click in the last 30 days",
		filterExpr:  `s.status = 'enabled' AND COALESCE(ev.has_engagement_30d, false)`,
		predicate: `s.status = 'enabled' AND EXISTS (
			SELECT 1 FROM subscriber_events e
			WHERE e.tenant_id = s.tenant_id AND e.subscriber_email = s.email
			  AND e.event_type IN ('opened','clicked')
			  AND e.at >= now() - INTERVAL '30 days')`,
	},
	{
		key:         "cold_90d",
		label:       "Cold (no activity for 90 days)",
		description: "enabled subscribers with no open/click in the last 90 days; sunset candidates",
		filterExpr:  `s.status = 'enabled' AND NOT COALESCE(ev.has_engagement_90d, false)`,
		predicate: `s.status = 'enabled' AND NOT EXISTS (
			SELECT 1 FROM subscriber_events e
			WHERE e.tenant_id = s.tenant_id AND e.subscriber_email = s.email
			  AND e.event_type IN ('opened','clicked')
			  AND e.at >= now() - INTERVAL '90 days')`,
	},
	{
		// "Joined" is created_at: the directory's Joined column and the
		// builder's "joined in the last N days" rule read the same field. The
		// rule has no status condition — a contact added today is new whether
		// or not it has confirmed yet, exactly as a saved "joined" segment
		// counts it. (It used to require status = 'enabled', so the unconfirmed
		// contacts added through the dialog, paste and import never counted.)
		// The description is also the builder seed: the rules compiler turns
		// "joined in the last 7 days" into created_at >= now-7d.
		key:         "new_7d",
		label:       "New (joined in last 7 days)",
		description: "Contacts who joined in the last 7 days",
		filterExpr:  `s.created_at >= now() - INTERVAL '7 days'`,
		predicate:   `s.created_at >= now() - INTERVAL '7 days'`,
	},
	{
		key:         "new_30d",
		label:       "New (joined in last 30 days)",
		description: "Contacts who joined in the last 30 days",
		filterExpr:  `s.created_at >= now() - INTERVAL '30 days'`,
		predicate:   `s.created_at >= now() - INTERVAL '30 days'`,
	},
	{
		key:         "frequent_clickers",
		label:       "Frequent clickers (3+ clicks in 90 days)",
		description: "the high-engagement core; best target for re-engagement / paid upsell",
		filterExpr:  `s.status = 'enabled' AND COALESCE(ev.clicks_90d_count, 0) >= 3`,
		predicate: `s.status = 'enabled' AND (
			SELECT count(*) FROM subscriber_events e
			WHERE e.tenant_id = s.tenant_id AND e.subscriber_email = s.email
			  AND e.event_type = 'clicked'
			  AND e.at >= now() - INTERVAL '90 days') >= 3`,
	},
	{
		key:         "never_opened",
		label:       "Never opened any campaign",
		description: "subscribers who've never opened — likely bots, dead inboxes, or wrong-list signups",
		filterExpr:  `s.status = 'enabled' AND NOT COALESCE(ev.has_opened_ever, false)`,
		predicate: `s.status = 'enabled' AND NOT EXISTS (
			SELECT 1 FROM subscriber_events e
			WHERE e.tenant_id = s.tenant_id AND e.subscriber_email = s.email
			  AND e.event_type = 'opened')`,
	},
	{
		key:         "double_optin_verified",
		label:       "Double opt-in subscribers",
		description: "highest-trust subscribers — verified consent",
		filterExpr:  `s.status = 'enabled' AND s.consent_source = 'double_optin'`,
		predicate:   `s.status = 'enabled' AND s.consent_source = 'double_optin'`,
	},
}

// MountRoutes registers the admin endpoints.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(read).Get("/api/v1/preset-segments", d.List)
	r.With(read).Get("/api/v1/preset-segments/{key}/list", d.ListSubscribers)
}

// List GET /api/v1/preset-segments.
//
// Single round-trip: every preset's count via one CTE-wrapped
// SELECT. Cheaper than seven separate queries.
//
// Performance: the prior implementation embedded seven correlated
// EXISTS / COUNT subqueries inside `count(*) FILTER (...)` clauses,
// which Postgres evaluates as nested-loop semi-joins — effectively
// one subscriber_events scan per subscriber row per preset. On
// workspaces with >100k subscribers and millions of events that
// degrades into O(rows × events) work. We now pre-aggregate
// subscriber_events once into the `engagement` CTE (single pass,
// hash-aggregated by subscriber_email) and LEFT JOIN it onto
// subscribers, turning each FILTER expression into a trivial
// boolean/integer comparison. Expected speedup: ~10–100x on
// workspaces with >100k subscribers; on small tenants the planner
// converges on the same cheap shape so there's no regression.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Build a single SELECT with one count() FILTER per preset.
	// filterExpr fragments reference the `engagement` CTE alias `ev`;
	// presets that don't read engagement columns are unaffected by
	// the LEFT JOIN.
	selects := []string{}
	for _, p := range presets {
		selects = append(selects, "count(*) FILTER (WHERE "+p.filterExpr+") AS "+p.key)
	}
	q := `
WITH engagement AS (
    SELECT
        e.subscriber_email,
        bool_or(e.event_type IN ('opened','clicked')
                AND e.at >= now() - INTERVAL '30 days') AS has_engagement_30d,
        bool_or(e.event_type IN ('opened','clicked')
                AND e.at >= now() - INTERVAL '90 days') AS has_engagement_90d,
        count(*) FILTER (WHERE e.event_type = 'clicked'
                         AND e.at >= now() - INTERVAL '90 days') AS clicks_90d_count,
        bool_or(e.event_type = 'opened') AS has_opened_ever
      FROM subscriber_events e
     WHERE e.tenant_id = $1::uuid
     GROUP BY e.subscriber_email
)
SELECT ` + strings.Join(selects, ", ") + `
  FROM subscribers s
  LEFT JOIN engagement ev ON ev.subscriber_email = s.email
 WHERE s.tenant_id = $1::uuid AND ` + audiencePopulation

	row := tx.QueryRow(r.Context(), q, t.ID)
	dest := make([]int64, len(presets))
	destPtrs := make([]any, len(presets))
	for i := range dest {
		destPtrs[i] = &dest[i]
	}
	if err := row.Scan(destPtrs...); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	out := make([]Preset, len(presets))
	for i, p := range presets {
		out[i] = Preset{
			Key:         p.key,
			Label:       p.label,
			Description: p.description,
			Count:       dest[i],
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"presets": out,
		"count":   len(out),
	})
}

// ListSubscribers GET /api/v1/preset-segments/{key}/list?limit=&offset=.
func (d *Deps) ListSubscribers(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	key := chi.URLParam(r, "key")
	def := findPreset(key)
	if def == nil {
		writeErr(w, http.StatusNotFound, "unknown_preset", "")
		return
	}
	limit := 200
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 1000 {
			limit = n
		}
	}
	offset := 0
	if v := r.URL.Query().Get("offset"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			offset = n
		}
	}

	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	rows, err := tx.Query(r.Context(), `
SELECT s.id::text, s.email::text, s.created_at, s.status
  FROM subscribers s
 WHERE s.tenant_id = $1::uuid AND `+audiencePopulation+` AND (`+def.predicate+`)
 ORDER BY s.created_at DESC
 LIMIT $2 OFFSET $3`, t.ID, limit, offset)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	type sub struct {
		ID        string `json:"id"`
		Email     string `json:"email"`
		CreatedAt string `json:"created_at"`
		Status    string `json:"status"`
	}
	out := []sub{}
	for rows.Next() {
		var s sub
		var created interface{}
		if err := rows.Scan(&s.ID, &s.Email, &created, &s.Status); err != nil {
			continue
		}
		s.CreatedAt = stringifyTime(created)
		out = append(out, s)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"preset":      def.key,
		"label":       def.label,
		"subscribers": out,
		"count":       len(out),
		"limit":       limit,
		"offset":      offset,
	})
}

func findPreset(key string) *presetDef {
	for i := range presets {
		if presets[i].key == key {
			return &presets[i]
		}
	}
	return nil
}

func stringifyTime(v interface{}) string {
	if t, ok := v.(interface{ Format(string) string }); ok {
		return t.Format("2006-01-02T15:04:05Z07:00")
	}
	return ""
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}

// keep context + pgx + errors imports honest in case future
// preset definitions need typed-error handling.
var (
	_ = context.Background
	_ = pgx.ErrNoRows
	_ = errors.New
)
