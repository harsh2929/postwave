// Package webvitals receives anonymous Core Web Vitals telemetry from
// the public web app (apps/web) and stores rows in web_vitals_events.
//
// Why a dedicated package:
//   - The endpoint is anonymous (no tenant header, no auth) — the rest
//     of the API is tenant-scoped by default. Keeping the handler in
//     its own package makes the auth deviation explicit and reviewable.
//   - The ingest path is rate-limited per-IP via an in-memory token
//     bucket. We don't want that limiter sitting in the gateway-wide
//     middleware stack — it's tuned for telemetry traffic, not
//     authenticated API traffic.
//   - Rollups + dashboards live elsewhere (analytics package). The
//     ingest is intentionally write-only.
//
// Wire in apps/api/main.go via:
//
//	r.Group(func(r chi.Router) {
//	    r.Method(http.MethodPost, "/api/internal/web-vitals", handler)
//	    r.Method(http.MethodOptions, "/api/internal/web-vitals", handler)
//	})
package webvitals

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	runtimeobservability "github.com/postwave/postwave/packages/runtime/observability"
)

const (
	maxBodyBytes            int64 = 64 << 10
	maxBatchEvents                = 20
	rateLimitEventCapacity        = 100
	rateLimitBucketCapacity       = 10_000
	rateLimitWindow               = time.Minute
	rateLimitBucketTTL            = 10 * rateLimitWindow
)

var errTooManyEvents = errors.New("too many web-vitals events")

const ingestPath = "/api/internal/web-vitals"

type eventExecutor interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

// Deps wires the handler to its dependencies.
type Deps struct {
	Pool   *pgxpool.Pool
	Logger *slog.Logger
	// AllowedOrigins is the CORS allow-list applied to OPTIONS preflights
	// and to the Access-Control-Allow-Origin response header. Empty means
	// "no CORS headers emitted" — sendBeacon and same-origin fetch still
	// work, but cross-origin browser fetches will fail. In production the
	// list should contain only the canonical web origin (e.g.
	// "https://app.moosewave.com").
	AllowedOrigins []string
	// TrustForwardedIPHeaders uses the process-wide trusted-proxy CIDR
	// configuration when resolving the rate-limit identity. A true value alone
	// never trusts a header: middleware.ResolveClientIPString also requires the
	// untouched TCP peer to be in that reviewed proxy set.
	TrustForwardedIPHeaders bool
	// Now is the clock used for rate-limit bookkeeping. Tests override
	// this to assert deterministic bucket refills; production leaves it
	// nil so we fall back to time.Now.
	Now func() time.Time
}

// Handler accepts POST requests carrying a single metric or a JSON
// array of metrics, validates the field types, applies the per-IP rate
// limit, and inserts rows into web_vitals_events.
type Handler struct {
	deps     *Deps
	executor eventExecutor
	limiter  *ipRateLimiter
}

// NewHandler returns an http.Handler that ingests web-vitals events.
func NewHandler(d *Deps) *Handler {
	if d == nil {
		d = &Deps{}
	}
	if d.Now == nil {
		d.Now = time.Now
	}
	handler := &Handler{
		deps: d,
		limiter: newIPRateLimiterWithBucketCapacity(
			rateLimitEventCapacity,
			rateLimitWindow,
			rateLimitBucketCapacity,
			d.Now,
		),
	}
	if d.Pool != nil {
		handler.executor = d.Pool
	}
	return handler
}

// metricEvent is the input shape we accept. We deliberately keep the
// schema loose (extra fields are ignored, missing fields default to
// zero/empty) — the web-vitals.js library evolves quickly and we'd
// rather drop unknown keys than 400 the client.
type metricEvent struct {
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	Value          float64 `json:"value"`
	Rating         string  `json:"rating"`
	NavigationType string  `json:"navigationType"`
	Page           string  `json:"page"`
	SessionID      string  `json:"session_id"`
	TS             int64   `json:"ts"`
}

// ServeHTTP handles POST + OPTIONS. Anything else is 405.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	applyPrivateResponseHeaders(w)
	h.applyCORS(w, r)
	switch r.Method {
	case http.MethodOptions:
		w.WriteHeader(http.StatusNoContent)
		return
	case http.MethodPost:
		// fallthrough to handler
	default:
		w.Header().Set("Allow", "POST, OPTIONS")
		writeJSONError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}

	ip := middleware.ResolveClientIPString(r, h.deps.TrustForwardedIPHeaders)
	// Charge one request token before parsing so malformed and oversized bodies
	// cannot bypass the anonymous-ingest budget. Valid batches pay the remaining
	// event cost after their bounded shape is known.
	if !h.limiter.allow(ip, 1) {
		w.Header().Set("Retry-After", "60")
		writeJSONError(w, http.StatusTooManyRequests, "rate_limited", "rate limited")
		return
	}

	body, err := httpbody.ReadAtMost(r.Body, maxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "payload_too_large", "payload too large")
			return
		}
		writeJSONError(w, http.StatusBadRequest, "bad_body", "bad body")
		return
	}

	events, err := decodeEvents(body)
	if err != nil {
		if errors.Is(err, errTooManyEvents) {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "too_many_events", "too many events")
			return
		}
		writeJSONError(w, http.StatusBadRequest, "invalid_json", "invalid json")
		return
	}
	if len(events) > 1 && !h.limiter.allow(ip, len(events)-1) {
		w.Header().Set("Retry-After", "60")
		writeJSONError(w, http.StatusTooManyRequests, "rate_limited", "rate limited")
		return
	}
	if len(events) == 0 {
		// Empty array / null body — accept silently so the client's
		// sendBeacon doesn't think it failed.
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if h.executor != nil {
		if err := h.insert(r.Context(), r, events); err != nil {
			if h.deps.Logger != nil {
				h.deps.Logger.Warn("webvitals insert failed", "err", err)
			}
			// Telemetry must never raise into the user's session. The
			// browser doesn't read the response body anyway (sendBeacon
			// is fire-and-forget), so a 204 keeps clients quiet even on
			// our failures.
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func applyPrivateResponseHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

// ProtectResponses stamps the anonymous ingest boundary before API-wide CORS
// can answer a preflight and before the router can emit a 404/405. A real
// browser preflight is completed here with the endpoint's narrower exact-origin
// policy: go-chi/cors otherwise terminates OPTIONS before ServeHTTP can replace
// the gateway-wide grant. Handler-level stamping remains defense in depth for
// direct use and non-preflight requests.
func ProtectResponses(allowedOrigins []string) func(http.Handler) http.Handler {
	// Own a stable copy so a caller cannot mutate the security policy after the
	// middleware chain has been constructed.
	origins := append([]string(nil), allowedOrigins...)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r == nil || r.URL == nil || r.URL.Path != ingestPath {
				next.ServeHTTP(w, r)
				return
			}
			applyPrivateResponseHeaders(w)
			if r.Method == http.MethodOptions &&
				r.Header.Get("Access-Control-Request-Method") != "" {
				applyCORS(w, r, origins)
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func writeJSONError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]map[string]string{
		"error": {
			"code":    code,
			"message": message,
		},
	})
}

// decodeEvents accepts either a single object or a JSON array. We
// silently coerce empty / null bodies to a zero-length slice so a
// best-effort sendBeacon flush doesn't 400.
func decodeEvents(body []byte) ([]metricEvent, error) {
	body = trimSpace(body)
	if len(body) == 0 || string(body) == "null" {
		return nil, nil
	}
	switch body[0] {
	case '[':
		var arr []metricEvent
		if err := json.Unmarshal(body, &arr); err != nil {
			return nil, err
		}
		if len(arr) > maxBatchEvents {
			return nil, errTooManyEvents
		}
		return arr, nil
	case '{':
		var single metricEvent
		if err := json.Unmarshal(body, &single); err != nil {
			return nil, err
		}
		return []metricEvent{single}, nil
	default:
		return nil, errors.New("expected object or array")
	}
}

func trimSpace(b []byte) []byte {
	i, j := 0, len(b)
	for i < j && isSpace(b[i]) {
		i++
	}
	for j > i && isSpace(b[j-1]) {
		j--
	}
	return b[i:j]
}

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r'
}

// insert writes one row per event. Session id is optional. The anonymous body
// has no authority to attribute telemetry to a tenant, so tenant_id is always
// stored as NULL even if an unknown tenant_id member is present in the JSON.
// We deliberately do NOT call db.WithTenant — this is global telemetry without
// RLS (see migration 0083).
func (h *Handler) insert(ctx context.Context, r *http.Request, events []metricEvent) error {
	ua := r.UserAgent()
	if len(ua) > 512 {
		ua = ua[:512]
	}
	now := h.deps.Now().UTC()
	for _, ev := range events {
		name := strings.TrimSpace(ev.Name)
		if name == "" || len(name) > 32 {
			continue
		}
		page := safePagePathForStorage(ev.Page)
		rating := truncate(ev.Rating, 32)
		nav := truncate(ev.NavigationType, 32)
		session := truncate(firstNonEmpty(ev.SessionID, ev.ID), 128)
		at := metricAt(ev, now)

		const q = `
	INSERT INTO web_vitals_events
	    (session_id, tenant_id, metric_name, value, rating, navigation_type, page_path, user_agent, at)
	VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9)`
		if _, err := h.executor.Exec(ctx, q,
			nullable(session), nil, name, ev.Value,
			nullable(rating), nullable(nav), nullable(page), nullable(ua), at,
		); err != nil {
			return err
		}
	}
	return nil
}

func safePagePathForStorage(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	parsed, err := url.Parse(path)
	if err != nil {
		return ""
	}
	// page is a path dimension, never a URL dimension. Discard origin,
	// userinfo, query, and fragment from untrusted public-ingest payloads before
	// applying route-aware credential/PII redaction.
	path = parsed.Path
	if path == "" {
		return ""
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return truncate(runtimeobservability.RedactSensitivePath(path), 1024)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func metricAt(ev metricEvent, now time.Time) time.Time {
	if ev.TS <= 0 {
		return now
	}
	at := time.UnixMilli(ev.TS).UTC()
	if at.After(now.Add(5*time.Minute)) || at.Before(now.Add(-30*24*time.Hour)) {
		return now
	}
	return at
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func truncate(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) > max {
		return s[:max]
	}
	return s
}

func (h *Handler) applyCORS(w http.ResponseWriter, r *http.Request) {
	applyCORS(w, r, h.deps.AllowedOrigins)
}

func applyCORS(w http.ResponseWriter, r *http.Request, allowedOrigins []string) {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return
	}
	// This handler has a narrower origin contract than the API-wide CORS
	// middleware. Clear any upstream grant before applying that contract so an
	// origin cannot inherit access merely because another API route allows it.
	w.Header().Del("Access-Control-Allow-Origin")
	w.Header().Del("Access-Control-Allow-Credentials")
	w.Header().Del("Access-Control-Allow-Methods")
	w.Header().Del("Access-Control-Allow-Headers")
	w.Header().Del("Access-Control-Max-Age")
	w.Header().Add("Vary", "Origin")
	if r.Method == http.MethodOptions {
		w.Header().Add("Vary", "Access-Control-Request-Method")
		w.Header().Add("Vary", "Access-Control-Request-Headers")
	}
	allowed := false
	for _, allowedOrigin := range allowedOrigins {
		if allowedOrigin == origin {
			allowed = true
			break
		}
	}
	if !allowed {
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Access-Control-Allow-Credentials", "true")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

// ---------- in-memory token bucket per IP -----------------------------

type ipBucket struct {
	tokens float64
	last   time.Time
}

type ipRateLimiter struct {
	buckets  *middleware.BoundedBuckets[*ipBucket]
	capacity float64
	window   time.Duration
	now      func() time.Time
}

func newIPRateLimiter(capacity int, window time.Duration, now func() time.Time) *ipRateLimiter {
	return newIPRateLimiterWithBucketCapacity(capacity, window, rateLimitBucketCapacity, now)
}

func newIPRateLimiterWithBucketCapacity(capacity int, window time.Duration, bucketCapacity int, now func() time.Time) *ipRateLimiter {
	if now == nil {
		now = time.Now
	}
	return &ipRateLimiter{
		buckets:  middleware.NewBoundedBuckets[*ipBucket]("web_vitals", bucketCapacity, rateLimitBucketTTL),
		capacity: float64(capacity),
		window:   window,
		now:      now,
	}
}

func (l *ipRateLimiter) allow(ip string, cost int) bool {
	if ip == "" {
		ip = "unknown"
	}
	if cost < 1 {
		cost = 1
	}
	now := l.now()
	allowed := false
	l.buckets.Update(ip, now, func(b *ipBucket, hit bool) *ipBucket {
		if !hit || b == nil {
			b = &ipBucket{tokens: l.capacity, last: now}
		}
		// Refill: capacity tokens per `window`. Fractional refills are fine.
		elapsed := now.Sub(b.last).Seconds()
		if elapsed > 0 {
			b.tokens += (l.capacity / l.window.Seconds()) * elapsed
			if b.tokens > l.capacity {
				b.tokens = l.capacity
			}
			b.last = now
		}
		charge := float64(cost)
		if charge <= l.capacity && b.tokens >= charge {
			b.tokens -= charge
			allowed = true
		}
		return b
	})
	return allowed
}
