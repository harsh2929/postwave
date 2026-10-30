// SPDX-License-Identifier: AGPL-3.0-only
//
// Package tag_taxonomy extends the existing tags package with the
// read projections operators reach for after a tag explosion. Canonical
// membership comes only from subscriber_tags; subscribers.tags is a bounded
// compatibility projection and is never independently aggregated here.
//
// Surfaces:
//
//   GET    /api/v1/tag-taxonomy                       list with usage counts
//   GET    /api/v1/tag-taxonomy/subscribers           ?tag=&limit=
//   GET    /api/v1/tag-taxonomy/suggest               ?q=&limit= typeahead
//   POST   /api/v1/tag-taxonomy/merge                 body: {from, into}
//   POST   /api/v1/tag-taxonomy/rename                body: {from, to}
//
// Destructive legacy merge/rename routes remain mounted only to return a
// stable unsafe_mutation_disabled response. Supported renames go through the
// versioned tag-id PATCH contract so identity, ETag, history, and projections
// change atomically.

package tag_taxonomy

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/tags"
)

const requestJSONMaxBodyBytes int64 = 4 << 10

// Deps wires the HTTP surface.
type Deps struct {
	Pool    *db.Pool
	History *tags.History
	// Logger is used by httperror.WriteInternal so 5xx responses log the
	// underlying error (with tenant_id + request_id) instead of echoing
	// err.Error() back to the client. Wired by the caller; nil-safe at
	// the httperror call site.
	Logger *slog.Logger
}

// Usage is one row of the taxonomy listing.
type Usage struct {
	Tag         string    `json:"tag"`
	Subscribers int64     `json:"subscribers"`
	Registered  bool      `json:"registered"`
	CreatedAt   time.Time `json:"created_at,omitempty"`
}

type mergeReq struct {
	From string `json:"from"`
	Into string `json:"into"`
}

type renameReq struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// MountRoutes registers tenant audience endpoints with explicit subscriber
// read/write API-key scopes.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	write := apikeys.RequireScope(apikeys.ScopeWriteSubscribers)
	read := apikeys.RequireScope(apikeys.ScopeReadSubscribers)
	r.With(read).Get("/api/v1/tag-taxonomy", d.List)
	r.With(write).Post("/api/v1/tag-taxonomy/merge", d.Merge)
	r.With(write).Post("/api/v1/tag-taxonomy/rename", d.Rename)
	// Refined Tags PR 1: list subscribers with a given tag so the
	// Tag detail slideover can show who's actually in the bucket.
	r.With(read).Get("/api/v1/tag-taxonomy/subscribers", d.SubscribersWithTag)
	// Refined Tags PR 2: typeahead suggestions over the union of
	// registry + live usage. Powers the "Did you mean…?" hint in
	// the New tag modal and is reusable for subscriber tag pickers.
	r.With(read).Get("/api/v1/tag-taxonomy/suggest", d.Suggest)
	// D16#1: the Membership handler (analytics.go) existed but its route
	// was never mounted, so the desktop TagMembershipChart always 404'd.
	r.With(read).Get("/api/v1/tag-taxonomy/{tag_id}/membership", d.Membership)
}

// parseSmallInt is a defensive ASCII-only integer parser. Used for
// limit clamps where a bogus query param should fall back to a default
// rather than 500.
func parseSmallInt(s string) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + int(c-'0')
	}
	return n
}

// SubscribersWithTag GET /api/v1/tag-taxonomy/subscribers?tag=<name>&limit=50
//
// Returns a capped projection of the subscribers carrying the tag.
// Limit clamped to [1, 200]. Default 50. Sort newest-first by id so
// the response is stable across calls without an expensive sort.
func (d *Deps) SubscribersWithTag(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	tagName := strings.TrimSpace(r.URL.Query().Get("tag"))
	if tagName == "" {
		writeErr(w, http.StatusBadRequest, "missing_tag", "tag query param required")
		return
	}
	limit := 50
	if v := strings.TrimSpace(r.URL.Query().Get("limit")); v != "" {
		if n := parseSmallInt(v); n > 0 && n <= 200 {
			limit = n
		}
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT subscriber.id::text, subscriber.email, COALESCE(subscriber.status, ''),
       subscriber.created_at
  FROM tags AS tag
  JOIN subscriber_tags AS membership
    ON membership.tenant_id = tag.tenant_id
   AND membership.tag_id = tag.id
  JOIN subscribers AS subscriber
    ON subscriber.tenant_id = membership.tenant_id
   AND subscriber.id = membership.subscriber_id
 WHERE tag.tenant_id = $1::uuid
   AND tag.name = $2::citext
   AND tag.archived_at IS NULL
 ORDER BY membership.applied_at DESC, subscriber.id
LIMIT $3`, t.ID, tagName, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	type subRow struct {
		ID        string    `json:"id"`
		Email     string    `json:"email"`
		Status    string    `json:"status"`
		CreatedAt time.Time `json:"created_at"`
	}
	out := []subRow{}
	for rows.Next() {
		var s subRow
		if err := rows.Scan(&s.ID, &s.Email, &s.Status, &s.CreatedAt); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tag": tagName, "items": out})
}

// List GET /api/v1/tag-taxonomy.
//
// Aggregates the canonical join against the registry. Migration 1774
// registers legacy labels before installing tenant-safe foreign keys, so an
// unregistered canonical membership is structurally impossible.
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
SELECT tag.name::text,
       count(membership.tag_id)::bigint AS subscribers,
       true AS registered,
       tag.created_at
  FROM tags AS tag
  LEFT JOIN subscriber_tags AS membership
    ON membership.tenant_id = tag.tenant_id
   AND membership.tag_id = tag.id
 WHERE tag.tenant_id = $1::uuid
   AND tag.archived_at IS NULL
 GROUP BY tag.id, tag.name, tag.created_at
 ORDER BY subscribers DESC, lower(tag.name::text), tag.id
 LIMIT 1000`, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out := []Usage{}
	for rows.Next() {
		var u Usage
		var created *time.Time
		if err := rows.Scan(&u.Tag, &u.Subscribers, &u.Registered, &created); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		if created != nil {
			u.CreatedAt = *created
		}
		out = append(out, u)
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// Refined Tags PR 2: respond with `items` (matching the client
	// type + every other list endpoint) and keep `tags`+`count` as
	// aliases for any older caller that snapshotted the old shape.
	writeJSON(w, http.StatusOK, map[string]any{
		"items": out,
		"tags":  out,
		"count": len(out),
	})
}

// Suggest GET /api/v1/tag-taxonomy/suggest?q=<substr>&limit=10.
//
// Returns up to N live registry rows ranked by canonical membership count.
//
// Limit clamped to [1, 50], default 10. Case-insensitive substring
// match via ILIKE — fine for the small per-tenant tag catalogue (≪ 10k
// distinct labels in practice).
func (d *Deps) Suggest(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	limit := 10
	if v := strings.TrimSpace(r.URL.Query().Get("limit")); v != "" {
		if n := parseSmallInt(v); n > 0 && n <= 50 {
			limit = n
		}
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	rows, err := tx.Query(r.Context(), `
SELECT tag.name::text,
       count(membership.tag_id)::bigint AS subscribers,
       true AS registered
  FROM tags AS tag
  LEFT JOIN subscriber_tags AS membership
    ON membership.tenant_id = tag.tenant_id
   AND membership.tag_id = tag.id
 WHERE tag.tenant_id = $1::uuid
   AND tag.archived_at IS NULL
   AND ($2 = '' OR tag.name ILIKE '%' || $2 || '%')
 GROUP BY tag.id, tag.name
 ORDER BY subscribers DESC, lower(tag.name::text), tag.id
 LIMIT $3`, t.ID, q, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	type suggestion struct {
		Tag         string `json:"tag"`
		Subscribers int64  `json:"subscribers"`
		Registered  bool   `json:"registered"`
	}
	out := []suggestion{}
	for rows.Next() {
		var s suggestion
		if err := rows.Scan(&s.Tag, &s.Subscribers, &s.Registered); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out, "q": q})
}

// Merge validates the legacy request envelope, then refuses the unsafe
// destructive operation without changing data.
func (d *Deps) Merge(w http.ResponseWriter, r *http.Request) {
	_, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var body mergeReq
	if err := httpbody.DecodeJSONWith(w, r, requestJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		// httpbody.DecodeJSON returns operator-safe text + a stable code in
		// httperror.IsValidationCode's allowlist (payload_too_large/bad_json).
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	from := strings.TrimSpace(body.From)
	into := strings.TrimSpace(body.Into)
	if from == "" || into == "" {
		writeErr(w, http.StatusBadRequest, "missing_fields", "from and into required")
		return
	}
	if from == into {
		writeErr(w, http.StatusBadRequest, "same_tag", "from and into are identical")
		return
	}

	writeErr(w, http.StatusConflict, "unsafe_mutation_disabled",
		"Tag merge requires an authoritative impact plan, one idempotent commit, and a signed receipt; no data was changed.")
}

// Rename validates the legacy request envelope, then directs callers to the
// supported strong-ETag PATCH /api/v1/tags/{id} contract.
func (d *Deps) Rename(w http.ResponseWriter, r *http.Request) {
	_, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var body renameReq
	if err := httpbody.DecodeJSONWith(w, r, requestJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		// httpbody.DecodeJSON returns operator-safe text + a stable code in
		// httperror.IsValidationCode's allowlist (payload_too_large/bad_json).
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	from := strings.TrimSpace(body.From)
	to := strings.TrimSpace(body.To)
	if from == "" || to == "" {
		writeErr(w, http.StatusBadRequest, "missing_fields", "from and to required")
		return
	}
	if from == to {
		writeErr(w, http.StatusBadRequest, "same_tag", "from and to are identical")
		return
	}

	writeErr(w, http.StatusConflict, "unsafe_mutation_disabled",
		"Legacy taxonomy rename is disabled; use versioned PATCH /api/v1/tags/{id} with If-Match.")
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
