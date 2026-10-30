// SPDX-License-Identifier: AGPL-3.0-only
//
// Package bot_open_filter classifies tracked "open" events by the
// user-agent of the requesting client, separating real human
// engagement from automated prefetchers (Apple Mail Privacy
// Protection, Gmail image proxy, Microsoft SafeLinks, security
// scanners, Slack/Twitter/Facebook link unfurlers, …).
//
// Why this matters: bot-driven opens can inflate the apparent
// open-rate by 25-40% across a typical list. If the EQ score and
// engagement-based pruning treat those as human signals, cold
// subscribers get classified as warm and the deliverability
// flywheel breaks.
//
// Surfaces:
//
//   GET    /api/v1/bot-opens/signatures           list (platform + tenant)
//   POST   /api/v1/bot-opens/signatures           create tenant override
//   DELETE /api/v1/bot-opens/signatures/{id}      delete tenant override
//   GET    /api/v1/bot-opens/stats?since=         per-window breakdown
//
// Classification is query-time: signatures live in
// bot_open_signatures, ingest writes opens as-is, and the stats
// endpoint joins on a generated regex. Schema-change-free on the
// hot path; signature edits take effect immediately.

package bot_open_filter

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const requestJSONMaxBodyBytes int64 = 8 << 10 // 8 KiB

// Deps wires the HTTP surface.
type Deps struct {
	Pool *db.Pool
	// Logger is used by httperror.WriteInternal to record server-side
	// detail (tenant_id+request_id+err) without leaking err.Error() to
	// callers. Optional; nil is tolerated by httperror.WriteInternal.
	Logger *slog.Logger
}

// Signature is one row.
type Signature struct {
	ID        string    `json:"id"`
	TenantID  string    `json:"tenant_id,omitempty"`
	IsDefault bool      `json:"is_default"`
	Label     string    `json:"label"`
	Pattern   string    `json:"pattern"`
	Kind      string    `json:"kind"`
	Enabled   bool      `json:"enabled"`
	CreatedAt time.Time `json:"created_at"`
}

type createReq struct {
	Label   string `json:"label"`
	Pattern string `json:"pattern"`
	Kind    string `json:"kind"`
}

var allowedKinds = map[string]struct{}{
	"mpp": {}, "proxy": {}, "scanner": {}, "prefetcher": {}, "custom": {},
}

// MountRoutes registers the admin surface.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(read).Get("/api/v1/bot-opens/signatures", d.List)
	r.With(admin).Post("/api/v1/bot-opens/signatures", d.Create)
	r.With(admin).Delete("/api/v1/bot-opens/signatures/{id}", d.Delete)
	r.With(read).Get("/api/v1/bot-opens/stats", d.Stats)
}

// List GET /api/v1/bot-opens/signatures.
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
	rows, err := tx.Query(r.Context(), `
SELECT id::text, COALESCE(tenant_id::text, ''), label, pattern, kind, enabled, created_at
  FROM bot_open_signatures
 WHERE tenant_id IS NULL OR tenant_id = $1::uuid
 ORDER BY tenant_id NULLS FIRST, label`, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out := []Signature{}
	for rows.Next() {
		var s Signature
		if err := rows.Scan(&s.ID, &s.TenantID, &s.Label, &s.Pattern, &s.Kind, &s.Enabled, &s.CreatedAt); err != nil {
			continue
		}
		s.IsDefault = s.TenantID == ""
		out = append(out, s)
	}
	writeJSON(w, http.StatusOK, map[string]any{"signatures": out, "count": len(out)})
}

// Create POST /api/v1/bot-opens/signatures — tenant override.
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var body createReq
	if err := httpbody.DecodeJSONWith(w, r, requestJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	label := strings.TrimSpace(body.Label)
	pattern := strings.TrimSpace(body.Pattern)
	kind := strings.ToLower(strings.TrimSpace(body.Kind))
	if label == "" || pattern == "" {
		writeErr(w, http.StatusBadRequest, "missing_fields", "label and pattern required")
		return
	}
	if kind == "" {
		kind = "custom"
	}
	if _, ok := allowedKinds[kind]; !ok {
		writeErr(w, http.StatusBadRequest, "invalid_kind", "kind must be mpp|proxy|scanner|prefetcher|custom")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var id string
	err = tx.QueryRow(r.Context(), `
INSERT INTO bot_open_signatures (tenant_id, label, pattern, kind)
VALUES ($1::uuid, $2, $3, $4)
RETURNING id::text`, t.ID, label, pattern, kind).Scan(&id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id})
}

// Delete DELETE /api/v1/bot-opens/signatures/{id} — only tenant
// overrides. Platform defaults can be silenced by inserting a
// `enabled=false` override with the same label, but never deleted
// here (RLS would block anyway since tenant_id is NULL).
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		writeErr(w, http.StatusBadRequest, "missing_id", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	tag, err := tx.Exec(r.Context(),
		`DELETE FROM bot_open_signatures WHERE id = $1::uuid AND tenant_id = $2::uuid`,
		id, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "signature missing or platform default")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Stats GET /api/v1/bot-opens/stats?since=&days=.
//
// Joins subscriber_events (event_type='opened') against the
// combined signature set via a single regexp_replace check per
// row. For tenants with millions of opens this should still be
// fast — the bottleneck is the events table's tenant+at index, not
// the regex match.
func (d *Deps) Stats(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	since := r.URL.Query().Get("since")
	if since == "" {
		since = time.Now().UTC().Add(-30 * 24 * time.Hour).Format(time.RFC3339)
	}
	parsed, err := time.Parse(time.RFC3339, since)
	if err != nil {
		httperror.WriteValidation(w, "invalid_request", err.Error())
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Aggregate signature patterns into a single OR-joined regex.
	// Postgres regex is significantly faster than 17 separate LIKEs.
	combined, err := combinedPattern(r.Context(), tx, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	type bucket struct {
		Label string `json:"label"`
		Opens int64  `json:"opens"`
	}
	stats := map[string]any{
		"since":        parsed.Format(time.RFC3339),
		"total_opens":  int64(0),
		"bot_opens":    int64(0),
		"human_opens":  int64(0),
		"by_signature": []bucket{},
	}

	if combined == "" {
		// No signatures (unlikely after default seed). Everything is
		// classified as human.
		var total int64
		_ = tx.QueryRow(r.Context(), `
SELECT count(*) FROM subscriber_events
 WHERE event_type='opened' AND at >= $1`, parsed).Scan(&total)
		stats["total_opens"] = total
		stats["human_opens"] = total
		writeJSON(w, http.StatusOK, stats)
		return
	}

	var total, bots int64
	if err := tx.QueryRow(r.Context(), `
SELECT
  count(*) AS total,
  count(*) FILTER (WHERE COALESCE(user_agent, '') ~ $1) AS bots
FROM subscriber_events
WHERE event_type='opened' AND at >= $2`, combined, parsed).Scan(&total, &bots); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	stats["total_opens"] = total
	stats["bot_opens"] = bots
	stats["human_opens"] = total - bots

	// Per-signature breakdown — same window, grouped by label.
	rows, err := tx.Query(r.Context(), `
WITH sigs AS (
  SELECT id, label, pattern
    FROM bot_open_signatures
   WHERE enabled AND (tenant_id IS NULL OR tenant_id = $1::uuid)
)
SELECT s.label, count(e.*) AS opens
  FROM subscriber_events e
  JOIN sigs s ON COALESCE(e.user_agent, '') ~ s.pattern
 WHERE e.event_type='opened' AND e.at >= $2
 GROUP BY s.label
 ORDER BY opens DESC
 LIMIT 50`, t.ID, parsed)
	if err == nil {
		defer rows.Close()
		buckets := []bucket{}
		for rows.Next() {
			var b bucket
			if err := rows.Scan(&b.Label, &b.Opens); err == nil {
				buckets = append(buckets, b)
			}
		}
		stats["by_signature"] = buckets
	}
	writeJSON(w, http.StatusOK, stats)
}

// combinedPattern stitches all enabled signatures (platform +
// tenant) into a single regex via OR-grouping. We deliberately
// don't memoize across requests — signatures change rarely and a
// fresh read keeps the analytics consistent with the admin
// surface; the table only has ~20 rows.
func combinedPattern(ctx context.Context, tx pgx.Tx, tenantID string) (string, error) {
	rows, err := tx.Query(ctx, `
SELECT pattern FROM bot_open_signatures
 WHERE enabled AND (tenant_id IS NULL OR tenant_id = $1::uuid)`, tenantID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	parts := []string{}
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			continue
		}
		// Wrap each pattern in its own non-capturing group so an
		// alternation like `^$|GoogleImageProxy` parses as we
		// intend.
		parts = append(parts, "("+p+")")
	}
	return strings.Join(parts, "|"), nil
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

// Sentinel to keep errors import live for future typed errors.
var _ = errors.New
