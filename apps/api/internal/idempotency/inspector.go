// SPDX-License-Identifier: AGPL-3.0-only
//
// Inspector + replay surface for the per-tenant idempotency cache.
//
// The middleware stores every Idempotency-Key-bearing request's response so
// duplicate sends short-circuit. This file exposes that cache so operators
// can browse what's been cached (debug "why is this request returning 409
// idempotency_key_in_progress?"), see aggregate dedupe analytics (how often
// the cache is hit), and surface key-collision events (same key, different
// body — the 422 mismatch case).
//
// Replay semantics: GET /api/v1/idempotency/keys/{key}/replay returns the
// cached response *to the operator* (not to the original client). This is
// purely diagnostic — the operator wants to see what the API previously
// returned without triggering the underlying mutation. Stripe's Dashboard
// works the same way.
//
// Privacy: response bodies often contain customer data, so the routes
// require ScopeAdmin and the body preview is byte-capped at 64KB before
// being returned in JSON (the full bytes stay in storage).

package idempotency

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	// maxBodyPreviewBytes caps how many bytes of response body we return
	// in inspector responses. Larger bodies are stored fine but truncated
	// here so /keys/{key} doesn't return arbitrary multi-MB payloads.
	maxBodyPreviewBytes = 64 << 10

	// defaultListLimit is the page size when ?limit= is omitted.
	defaultListLimit = 50
	// maxListLimit caps ?limit= so callers can't request unbounded pages.
	maxListLimit = 200

	// A pre-fix response for this route can contain the only plaintext copy of
	// a signing secret. Migration 2031 removes every legacy row; the inspector
	// also withholds the exact canonical route so a rollout ordering mistake can
	// never preview or replay that credential.
	revealOnceIngestSecretIssueRoute = "POST /api/v1/conversions/ingest-secrets"
)

func inspectorRouteVisible(route string) bool {
	return route != revealOnceIngestSecretIssueRoute
}

// InspectorDeps wires the inspector handlers to the DB pool. The pool is
// the same one the rest of apps/api uses; we hold it directly because the
// inspector needs aggregate queries that the Store/Repo abstraction
// doesn't expose (and shouldn't — it's a middleware contract, not a
// reporting one).
type InspectorDeps struct {
	Pool *db.Pool
	// Logger sinks structured error logs server-side so handlers can return
	// a generic 500 envelope to the client (via httperror.WriteInternal)
	// without echoing err.Error() back. Nil-safe at the call site.
	Logger *slog.Logger
}

// MountInspectorRoutes mounts the read-only + replay routes under
// /api/v1/idempotency. All routes require ScopeAdmin because cached
// responses may contain sensitive content.
func MountInspectorRoutes(r chi.Router, d *InspectorDeps) {
	if d == nil || d.Pool == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/idempotency/keys", d.List)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/idempotency/keys/{key}", d.Get)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/idempotency/keys/{key}/replay", d.Replay)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/idempotency/stats", d.Stats)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Delete("/api/v1/idempotency/keys/{key}", d.Delete)
}

// RecordSummary is the inspector's serialisable shape. The response body
// is omitted from list responses (preview only available on the per-key
// detail endpoint) to keep page payloads small.
type RecordSummary struct {
	Key            string     `json:"key"`
	Route          string     `json:"route"`
	RequestHash    string     `json:"request_hash"`
	ResponseStatus *int       `json:"response_status,omitempty"`
	State          string     `json:"state"` // pending | completed | expired
	CreatedAt      time.Time  `json:"created_at"`
	ExpiresAt      time.Time  `json:"expires_at"`
	CompletedAt    *time.Time `json:"completed_at,omitempty"`
}

// RecordDetail extends RecordSummary with the response body preview +
// stored headers.
type RecordDetail struct {
	RecordSummary
	ResponseHeaders   http.Header `json:"response_headers,omitempty"`
	BodyPreview       string      `json:"body_preview,omitempty"`
	BodyBytes         int         `json:"body_bytes,omitempty"`
	BodyTruncated     bool        `json:"body_truncated,omitempty"`
	BodyContentType   string      `json:"body_content_type,omitempty"`
	OperatorReplayURL string      `json:"operator_replay_url,omitempty"`
}

// Stats is the aggregate dashboard payload.
type Stats struct {
	Total         int           `json:"total"`
	Pending       int           `json:"pending"`
	Completed     int           `json:"completed"`
	Expired       int           `json:"expired"`
	ByRoute       []RouteCount  `json:"by_route"`
	ByStatusClass []StatusClass `json:"by_status_class"`
	ByDay         []DayCount    `json:"by_day"`
	HotKeys       []HotKey      `json:"hot_keys"` // keys hit most frequently
	GeneratedAt   time.Time     `json:"generated_at"`
}

type RouteCount struct {
	Route string `json:"route"`
	Count int    `json:"count"`
}

type StatusClass struct {
	Class string `json:"class"` // "2xx" | "3xx" | "4xx" | "5xx" | "pending"
	Count int    `json:"count"`
}

type DayCount struct {
	Day   string `json:"day"` // YYYY-MM-DD
	Count int    `json:"count"`
}

type HotKey struct {
	Key   string `json:"key"`
	Route string `json:"route"`
	// HashesSeen is the number of distinct request_hashes ever recorded
	// for this key. >1 indicates a key-collision pattern (same key,
	// different bodies) which surfaces as 422 in the middleware.
	HashesSeen int `json:"hashes_seen"`
}

// List GET /api/v1/idempotency/keys?route=&state=&limit=
func (d *InspectorDeps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	q := r.URL.Query()
	route := q.Get("route")
	state := q.Get("state") // empty | pending | completed | expired
	limit := parseLimit(q.Get("limit"))

	rows, err := d.listRecords(r.Context(), t.ID, route, state, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"records": rows,
		"limit":   limit,
	})
}

// Get GET /api/v1/idempotency/keys/{key}
func (d *InspectorDeps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	key := chi.URLParam(r, "key")
	if key == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_key", "key path param required"))
		return
	}
	rec, err := d.getDetail(r.Context(), t.ID, key)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "no record for key"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, rec)
}

// Replay GET /api/v1/idempotency/keys/{key}/replay
//
// Streams the cached response body back to the operator with its original
// status code and headers. Note: this does NOT re-execute the upstream
// handler; it returns whatever was cached.
func (d *InspectorDeps) Replay(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	key := chi.URLParam(r, "key")
	if key == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_key", "key path param required"))
		return
	}
	repo := &Repo{Pool: d.Pool}
	rec, err := repo.Get(r.Context(), t.ID, key)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "no record for key"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if !inspectorRouteVisible(rec.Route) {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "no record for key"))
		return
	}
	if rec.ResponseStatus == 0 {
		writeJSON(w, http.StatusConflict, errEnv("replay_pending",
			"record exists but is still in-progress; no response cached yet"))
		return
	}

	// Copy headers byte-identically so replays remain faithful.
	if len(rec.ResponseHeaders) > 0 {
		for k, vs := range rec.ResponseHeaders {
			for _, v := range vs {
				w.Header().Add(k, v)
			}
		}
	} else if w.Header().Get("Content-Type") == "" {
		// Best-guess fallback when headers weren't recorded.
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
	}
	// Stamp a header so operators / SDKs can see this came from the
	// cache rather than a fresh execution.
	w.Header().Set("X-Postwave-Idempotency-Replay", "1")
	w.WriteHeader(rec.ResponseStatus)
	_, _ = w.Write(rec.ResponseBody)
}

// Stats GET /api/v1/idempotency/stats?days=7
func (d *InspectorDeps) Stats(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	days := 7
	if v := r.URL.Query().Get("days"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 90 {
			days = n
		}
	}
	s, err := d.computeStats(r.Context(), t.ID, days)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, s)
}

// Delete DELETE /api/v1/idempotency/keys/{key}
//
// Purges a cached record. Useful when a stuck pending claim is blocking
// retries (e.g. the original worker crashed before completing) or when
// QA needs to re-run a deterministic test.
func (d *InspectorDeps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	key := chi.URLParam(r, "key")
	if key == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_key", "key path param required"))
		return
	}
	deleted, err := d.deleteRecord(r.Context(), t.ID, key)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if !deleted {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "no record for key"))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- query helpers ---

func (d *InspectorDeps) listRecords(ctx context.Context, tenantID, route, state string, limit int) ([]RecordSummary, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// State filter is enforced in SQL so the page boundary lines up with
	// the requested view (otherwise filtering in Go after a LIMIT N pull
	// would yield short pages).
	stateFilter := ""
	args := []any{tenantID, revealOnceIngestSecretIssueRoute}
	switch state {
	case "pending":
		stateFilter = " AND response_status IS NULL AND expires_at > now()"
	case "completed":
		stateFilter = " AND response_status IS NOT NULL AND expires_at > now()"
	case "expired":
		stateFilter = " AND expires_at <= now()"
	}
	if route != "" {
		stateFilter += " AND route = $" + strconv.Itoa(len(args)+1)
		args = append(args, route)
	}
	args = append(args, limit)
	sql := `
SELECT key, route, request_hash, response_status, created_at, expires_at
 FROM idempotency_records
 WHERE tenant_id = $1::uuid
   AND route <> $2` + stateFilter + `
 ORDER BY created_at DESC
 LIMIT $` + strconv.Itoa(len(args))

	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]RecordSummary, 0, limit)
	for rows.Next() {
		var rec RecordSummary
		var status *int
		if err := rows.Scan(&rec.Key, &rec.Route, &rec.RequestHash, &status,
			&rec.CreatedAt, &rec.ExpiresAt); err != nil {
			return nil, err
		}
		rec.ResponseStatus = status
		rec.State = inferState(status, rec.ExpiresAt)
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (d *InspectorDeps) getDetail(ctx context.Context, tenantID, key string) (*RecordDetail, error) {
	repo := &Repo{Pool: d.Pool}
	rec, err := repo.Get(ctx, tenantID, key)
	if err != nil {
		return nil, err
	}
	if !inspectorRouteVisible(rec.Route) {
		return nil, ErrNotFound
	}
	d_ := &RecordDetail{
		RecordSummary: RecordSummary{
			Key:         rec.Key,
			Route:       rec.Route,
			RequestHash: rec.RequestHash,
			CreatedAt:   rec.CreatedAt,
			ExpiresAt:   rec.ExpiresAt,
		},
		ResponseHeaders: rec.ResponseHeaders,
	}
	if rec.ResponseStatus != 0 {
		s := rec.ResponseStatus
		d_.ResponseStatus = &s
	}
	d_.State = inferState(d_.ResponseStatus, rec.ExpiresAt)

	d_.BodyBytes = len(rec.ResponseBody)
	if len(rec.ResponseBody) > 0 {
		body := rec.ResponseBody
		if len(body) > maxBodyPreviewBytes {
			body = body[:maxBodyPreviewBytes]
			d_.BodyTruncated = true
		}
		d_.BodyPreview = string(body)
	}
	if rec.ResponseHeaders != nil {
		d_.BodyContentType = rec.ResponseHeaders.Get("Content-Type")
	}
	d_.OperatorReplayURL = "/api/v1/idempotency/keys/" + url.PathEscape(rec.Key) + "/replay"
	return d_, nil
}

func (d *InspectorDeps) computeStats(ctx context.Context, tenantID string, days int) (*Stats, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Headline totals + state buckets in one round trip.
	stats := Stats{GeneratedAt: time.Now().UTC()}
	row := tx.QueryRow(ctx, `
SELECT
  COUNT(*),
  COUNT(*) FILTER (WHERE response_status IS NULL AND expires_at > now()),
  COUNT(*) FILTER (WHERE response_status IS NOT NULL AND expires_at > now()),
  COUNT(*) FILTER (WHERE expires_at <= now())
FROM idempotency_records
WHERE tenant_id = $1::uuid
  AND route <> $2`, tenantID, revealOnceIngestSecretIssueRoute)
	if err := row.Scan(&stats.Total, &stats.Pending, &stats.Completed, &stats.Expired); err != nil {
		return nil, err
	}

	// By route (top 20).
	rows, err := tx.Query(ctx, `
SELECT route, COUNT(*) AS n
 FROM idempotency_records
 WHERE tenant_id = $1::uuid
   AND route <> $2
 GROUP BY route
 ORDER BY n DESC
 LIMIT 20`, tenantID, revealOnceIngestSecretIssueRoute)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var rc RouteCount
		if err := rows.Scan(&rc.Route, &rc.Count); err != nil {
			rows.Close()
			return nil, err
		}
		stats.ByRoute = append(stats.ByRoute, rc)
	}
	rows.Close()

	// By status class.
	rows, err = tx.Query(ctx, `
SELECT CASE
         WHEN response_status IS NULL THEN 'pending'
         WHEN response_status BETWEEN 200 AND 299 THEN '2xx'
         WHEN response_status BETWEEN 300 AND 399 THEN '3xx'
         WHEN response_status BETWEEN 400 AND 499 THEN '4xx'
         WHEN response_status >= 500 THEN '5xx'
         ELSE 'other'
       END AS class,
       COUNT(*) AS n
  FROM idempotency_records
 WHERE tenant_id = $1::uuid
   AND route <> $2
 GROUP BY class
 ORDER BY class`, tenantID, revealOnceIngestSecretIssueRoute)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var sc StatusClass
		if err := rows.Scan(&sc.Class, &sc.Count); err != nil {
			rows.Close()
			return nil, err
		}
		stats.ByStatusClass = append(stats.ByStatusClass, sc)
	}
	rows.Close()

	// Per-day rollup over the requested window.
	rows, err = tx.Query(ctx, `
SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
       COUNT(*) AS n
  FROM idempotency_records
 WHERE tenant_id = $1::uuid
   AND route <> $2
   AND created_at >= now() - ($3 || ' days')::interval
 GROUP BY day
 ORDER BY day`, tenantID, revealOnceIngestSecretIssueRoute, strconv.Itoa(days))
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var dc DayCount
		if err := rows.Scan(&dc.Day, &dc.Count); err != nil {
			rows.Close()
			return nil, err
		}
		stats.ByDay = append(stats.ByDay, dc)
	}
	rows.Close()

	// Hot keys — same key, multiple request_hashes is a collision signal.
	// We GROUP BY key and count distinct hashes; >1 means this key was
	// re-used with different bodies (the middleware returns 422 in that
	// case but doesn't durably record the collision).
	rows, err = tx.Query(ctx, `
SELECT key, MAX(route), COUNT(DISTINCT request_hash) AS hashes_seen
  FROM idempotency_records
 WHERE tenant_id = $1::uuid
   AND route <> $2
 GROUP BY key
HAVING COUNT(DISTINCT request_hash) > 1
 ORDER BY hashes_seen DESC, key
 LIMIT 20`, tenantID, revealOnceIngestSecretIssueRoute)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var hk HotKey
		if err := rows.Scan(&hk.Key, &hk.Route, &hk.HashesSeen); err != nil {
			rows.Close()
			return nil, err
		}
		stats.HotKeys = append(stats.HotKeys, hk)
	}
	// A nil slice marshals to JSON null. Clients type this field as an array,
	// so the EMPTY case -- the healthy, ordinary one here -- handed them a null
	// that throws on the first .map(). An empty list is [].
	if stats.HotKeys == nil {
		stats.HotKeys = []HotKey{}
	}
	rows.Close()

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &stats, nil
}

func (d *InspectorDeps) deleteRecord(ctx context.Context, tenantID, key string) (bool, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
DELETE FROM idempotency_records
 WHERE tenant_id = $1::uuid AND key = $2`, tenantID, key)
	if err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// --- small helpers ---

func parseLimit(raw string) int {
	if raw == "" {
		return defaultListLimit
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return defaultListLimit
	}
	if n > maxListLimit {
		return maxListLimit
	}
	return n
}

func inferState(status *int, expires time.Time) string {
	if expires.Before(time.Now().UTC()) {
		return "expired"
	}
	if status == nil {
		return "pending"
	}
	return "completed"
}

// writeJSON / errEnv are defined in idempotency.go (middleware). Reused
// here for response shape consistency with the rest of the package.
