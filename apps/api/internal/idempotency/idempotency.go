// SPDX-License-Identifier: AGPL-3.0-only
//
// Package idempotency provides a per-route middleware that turns mutating
// requests into replayable ones via the Idempotency-Key header. The contract
// matches Stripe's: same key + same request returns the cached response; same
// key + different request returns 422; missing header skips caching.
package idempotency

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
)

const (
	// HeaderName is the canonical request header we read.
	HeaderName = "Idempotency-Key"
	// ReplayedHeaderName is the canonical public response marker.
	ReplayedHeaderName = "Idempotent-Replayed"
	// LegacyReplayedHeaderName remains emitted for existing integrations.
	LegacyReplayedHeaderName = "Idempotent-Replay"
	// InternalReplayHeaderName is retained for in-process budget accounting
	// and older clients. New clients should read ReplayedHeaderName.
	InternalReplayHeaderName = "X-Idempotent-Replay"
	// RevalidateResponseHeaderName is an internal handler-to-middleware signal:
	// the response describes mutable durable state and must not be cached. The
	// middleware removes it before writing the public response. SMS reply 202s
	// use this so a later provider callback can turn same-key recovery into the
	// current persisted 201 receipt without another provider dispatch.
	RevalidateResponseHeaderName = "X-Postwave-Idempotency-Revalidate"
)

// DefaultTTL is how long replayable rows live before the janitor sweeps them.
const DefaultTTL = 24 * time.Hour

// MaxKeyLength keeps accidental huge headers out of the primary key.
const MaxKeyLength = 255

// ValidKey applies the canonical request-identity contract shared by replay
// middleware and handler-owned durable ledgers: 1-255 valid UTF-8 bytes, no
// surrounding whitespace, and no Unicode control characters.
func ValidKey(key string) bool {
	if key == "" || len(key) > MaxKeyLength || !utf8.ValidString(key) || strings.TrimSpace(key) != key {
		return false
	}
	for _, r := range key {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// MaxReplayBodyBytes caps the body buffered for request hashing. Route-level
// handlers still apply tighter limits where appropriate; this is the
// middleware backstop for idempotent mutations. Sized to the largest idempotent
// route (transactional email with attachments, 40 MiB) so an Idempotency-Key
// retry of a large send isn't 413'd here before reaching the handler — smaller
// routes stay bounded by their own per-handler caps.
const MaxReplayBodyBytes int64 = 40 << 20 // 40 MiB

// Record is the persisted row. response_body is stored as bytea so we can
// replay exact bytes (not just JSON). ResponseHeaders is persisted as jsonb
// so Content-Type, Location, Set-Cookie etc. round-trip byte-identical.
type Record struct {
	Key             string
	TenantID        string
	Route           string
	RequestHash     string
	ResponseStatus  int
	ResponseBody    []byte
	ResponseHeaders http.Header
	CreatedAt       time.Time
	ExpiresAt       time.Time
}

// ErrNotFound is returned by Store implementations when a record is absent.
var ErrNotFound = errors.New("idempotency: not found")

// Store is the persistence surface. The pgx Repo in this package implements
// it; tests can fake it.
type Store interface {
	Get(ctx context.Context, tenantID, key string) (*Record, error)
	Claim(ctx context.Context, rec *Record) (bool, error)
	Complete(ctx context.Context, rec *Record) error
	DeletePending(ctx context.Context, tenantID, key string) error
}

// Tenanted is the subset of middleware.Tenant we read. Defining it locally
// keeps this package independent of the middleware package.
type Tenanted interface {
	ID() string
}

// TenantResolver pulls the active tenant id out of a request context. The
// caller wires this to middleware.TenantFromContext.
type TenantResolver func(*http.Request) (string, bool)

// ReplayScopeResolver optionally narrows one raw Idempotency-Key to a concrete
// authenticated principal for routes whose durable resource ownership is
// actor-private. The returned scope is hashed with the caller's key before it
// reaches Store; it is never persisted or returned in plaintext.
type ReplayScopeResolver func(*http.Request) (string, bool)

// ReplayBypass decides whether this exact request must execute the current
// handler instead of consulting any previously cached response. It supports
// fail-closed containment changes and body-carrying read endpoints that must
// never enter the durable mutation replay ledger. A bypassed request is neither
// claimed nor recorded by this middleware.
type ReplayBypass func(*http.Request, []byte) bool

// HandlerOwnedReplay selects routes whose handler persists the complete
// principal-scoped replay state itself. Process still validates/scopes the key
// and bounds/replays the request body, but performs no generic Get/Claim/
// Complete/DeletePending calls. This avoids a split-brain response ledger.
type HandlerOwnedReplay func(*http.Request, []byte) bool

// ReplayBodyLimit selects a route-specific pre-hash cap. It runs before any
// request body is buffered or a generic/handler-owned replay ledger is touched.
// Returning <=0 uses MaxReplayBodyBytes.
type ReplayBodyLimit func(*http.Request) int64

type storageKeyContextKey struct{}
type requestHashContextKey struct{}

// StorageKeyFromContext returns the tenant/principal-scoped, one-way replay
// key selected by Process. Send handlers use it for their own pre-provider
// intent uniqueness without persisting or re-hashing the caller's raw key.
func StorageKeyFromContext(ctx context.Context) (string, bool) {
	value, ok := ctx.Value(storageKeyContextKey{}).(string)
	return value, ok && value != ""
}

// RequestHashFromContext returns the exact method+target+raw-body digest
// calculated by Process. Handler-owned replay ledgers persist this value to
// distinguish omitted fields, JSON representation changes, and path changes.
func RequestHashFromContext(ctx context.Context) (string, bool) {
	value, ok := ctx.Value(requestHashContextKey{}).(string)
	return value, ok && len(value) == 64
}

// Process wraps `next` so requests carrying an Idempotency-Key are checked
// against the store before running the handler. The handler's deterministic
// response is recorded for replay. If recording fails after execution, the
// pending claim is retained so an uncertain side effect cannot be repeated.
func Process(
	store Store,
	resolveTenant TenantResolver,
	resolveReplayScope ...ReplayScopeResolver,
) func(http.Handler) http.Handler {
	return process(store, resolveTenant, nil, nil, nil, resolveReplayScope...)
}

// ProcessWithReplayBypass is Process with an explicit emergency containment
// predicate. Prefer Process for ordinary routes; the bypass must only select
// handlers that are guaranteed not to perform the formerly cached side effect.
func ProcessWithReplayBypass(
	store Store,
	resolveTenant TenantResolver,
	bypass ReplayBypass,
	resolveReplayScope ...ReplayScopeResolver,
) func(http.Handler) http.Handler {
	return process(store, resolveTenant, bypass, nil, nil, resolveReplayScope...)
}

// ProcessWithHandlerOwnedReplay is Process with a narrowly selected durable
// handler-owned replay ledger. The selector must never include a route whose
// handler lacks its own atomic uniqueness/equivalence checks.
func ProcessWithHandlerOwnedReplay(
	store Store,
	resolveTenant TenantResolver,
	owned HandlerOwnedReplay,
	resolveReplayScope ...ReplayScopeResolver,
) func(http.Handler) http.Handler {
	return process(store, resolveTenant, nil, owned, nil, resolveReplayScope...)
}

// ProcessWithHandlerOwnedReplayAndBodyLimit adds a route-specific pre-hash
// body limit to handler-owned replay. It is intended for narrow JSON effects
// such as SMS replies whose wire contract is far smaller than the global
// attachment-capable replay maximum.
func ProcessWithHandlerOwnedReplayAndBodyLimit(
	store Store,
	resolveTenant TenantResolver,
	owned HandlerOwnedReplay,
	bodyLimit ReplayBodyLimit,
	resolveReplayScope ...ReplayScopeResolver,
) func(http.Handler) http.Handler {
	return process(store, resolveTenant, nil, owned, bodyLimit, resolveReplayScope...)
}

// ProcessWithReplayBypassAndHandlerOwnedReplayAndBodyLimit composes an
// emergency cached-response bypass for structurally held effects with the
// narrow handler-owned replay/body-limit contracts used by other routes in the
// same chi group. A path-only bypass that returns true for a nil body is
// evaluated before body reads and replay-store access; body-sensitive bypasses
// are evaluated again after the bounded hash. Thus an historical cached
// success or malformed legacy body cannot escape/obscure a deployed hold.
func ProcessWithReplayBypassAndHandlerOwnedReplayAndBodyLimit(
	store Store,
	resolveTenant TenantResolver,
	bypass ReplayBypass,
	owned HandlerOwnedReplay,
	bodyLimit ReplayBodyLimit,
	resolveReplayScope ...ReplayScopeResolver,
) func(http.Handler) http.Handler {
	return process(store, resolveTenant, bypass, owned, bodyLimit, resolveReplayScope...)
}

func process(
	store Store,
	resolveTenant TenantResolver,
	bypass ReplayBypass,
	owned HandlerOwnedReplay,
	bodyLimit ReplayBodyLimit,
	resolveReplayScope ...ReplayScopeResolver,
) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Give path-only selectors the first decision point, before even
			// validating an Idempotency-Key. A read-only POST or source-held effect
			// must not become a replay-ledger operation merely because a shared
			// transport attached a malformed or duplicate key. Body-sensitive
			// selectors return false for nil and run again after the bounded hash.
			if bypass != nil && bypass(r, nil) {
				next.ServeHTTP(w, r)
				return
			}
			keyValues := r.Header.Values(HeaderName)
			if len(keyValues) > 1 {
				// Idempotency-Key is a singleton request identity, not a list
				// header. Reject duplicate field-lines before reading the body or
				// claiming/caching a key; otherwise Header.Get would select one
				// value and a handler's later duplicate-header rejection could
				// permanently poison that selected key with a cached 400.
				writeJSON(w, http.StatusBadRequest, errEnv(
					"invalid_idempotency_key",
					"Idempotency-Key must be supplied at most once.",
				))
				return
			}
			rawKey := ""
			if len(keyValues) == 1 {
				rawKey = keyValues[0]
			}
			if rawKey == "" {
				next.ServeHTTP(w, r)
				return
			}
			key := strings.TrimSpace(rawKey)
			if key == "" {
				writeJSON(w, http.StatusBadRequest, errEnv(
					"invalid_idempotency_key",
					"Idempotency-Key must contain a non-whitespace value.",
				))
				return
			}
			// Treat the header as an exact request identity. Reject surrounding
			// whitespace before tenant lookup, body handling, or Claim: otherwise a
			// downstream route-specific 400 could be cached under the trimmed key
			// and poison a later valid request using that exact key.
			if key != rawKey {
				writeJSON(w, http.StatusBadRequest, errEnv(
					"invalid_idempotency_key",
					"Idempotency-Key must not contain surrounding whitespace.",
				))
				return
			}
			if len(key) > MaxKeyLength {
				writeJSON(w, http.StatusBadRequest, errEnv(
					"idempotency_key_too_long",
					"Idempotency-Key exceeds maximum length.",
				))
				return
			}
			if !ValidKey(key) {
				writeJSON(w, http.StatusBadRequest, errEnv(
					"invalid_idempotency_key",
					"Idempotency-Key must be 1-255 valid UTF-8 bytes without surrounding whitespace or controls.",
				))
				return
			}
			tenantID, ok := resolveTenant(r)
			if !ok {
				next.ServeHTTP(w, r)
				return
			}
			storageKey := key
			if len(resolveReplayScope) > 0 &&
				resolveReplayScope[0] != nil {
				if scope, scoped := resolveReplayScope[0](r); scoped &&
					scope != "" {
					storageKey = scopedReplayKey(scope, key)
				}
			}
			r = r.WithContext(context.WithValue(r.Context(), storageKeyContextKey{}, storageKey))

			// Buffer the body so we can hash it AND let the handler read it. A
			// narrow route cap is selected before allocation/read/ledger access.
			maxBodyBytes := MaxReplayBodyBytes
			if bodyLimit != nil {
				if selected := bodyLimit(r); selected > 0 && selected < maxBodyBytes {
					maxBodyBytes = selected
				}
			}
			body, err := httpbody.ReadAtMost(r.Body, maxBodyBytes)
			if err != nil {
				if errors.Is(err, httpbody.ErrTooLarge) {
					writeJSON(w, http.StatusRequestEntityTooLarge, errEnv(
						"request_body_too_large",
						"Request body exceeds maximum replayable size.",
					))
					return
				}
				writeJSON(w, http.StatusBadRequest, errEnv(
					"body_read_failed",
					"Could not read request body.",
				))
				return
			}
			_ = r.Body.Close()
			r.Body = io.NopCloser(bytes.NewReader(body))
			target := r.URL.EscapedPath()
			if r.URL.RawQuery != "" {
				target += "?" + r.URL.RawQuery
			}
			hash := hashRequest(r.Method, target, body)
			r = r.WithContext(context.WithValue(r.Context(), requestHashContextKey{}, hash))
			if bypass != nil && bypass(r, body) {
				next.ServeHTTP(w, r)
				return
			}
			if owned != nil && owned(r, body) {
				next.ServeHTTP(w, r)
				return
			}

			route := canonicalStoredRoute(r.Method, r.URL.EscapedPath())

			existing, err := store.Get(r.Context(), tenantID, storageKey)
			switch {
			case err == nil && existing != nil:
				if replayOrReject(w, existing, hash) {
					return
				}
			case errors.Is(err, ErrNotFound):
				// fallthrough — first time we've seen the key.
			case err != nil:
				writeJSON(w, http.StatusInternalServerError, errEnv(
					"idempotency_lookup_failed",
					"an internal error occurred",
				))
				return
			}

			now := time.Now().UTC()
			claim := &Record{
				Key:         storageKey,
				TenantID:    tenantID,
				Route:       route,
				RequestHash: hash,
				CreatedAt:   now,
				ExpiresAt:   now.Add(DefaultTTL),
			}
			claimed, err := store.Claim(r.Context(), claim)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, errEnv(
					"idempotency_claim_failed",
					"an internal error occurred",
				))
				return
			}
			if !claimed {
				existing, err := store.Get(
					r.Context(), tenantID, storageKey,
				)
				if err == nil && existing != nil && replayOrReject(w, existing, hash) {
					return
				}
				if err != nil && !errors.Is(err, ErrNotFound) {
					writeJSON(w, http.StatusInternalServerError, errEnv(
						"idempotency_lookup_failed",
						"an internal error occurred",
					))
					return
				}
				w.Header().Set("Retry-After", "5")
				writeJSON(w, http.StatusConflict, errEnv(
					"idempotency_key_in_progress",
					"A previous request with this Idempotency-Key is still processing. Retry after the Retry-After window.",
				))
				return
			}

			rec := newRecordingWriter()
			// Do not install a panic cleanup for the claim. Once the handler starts,
			// a panic is indistinguishable from one that happened after a durable or
			// billable side effect. Retaining the pending key forces reconciliation
			// and prevents a blind retry from repeating that side effect.
			next.ServeHTTP(rec, r)

			if rec.header.Get(RevalidateResponseHeaderName) == "1" {
				rec.header.Del(RevalidateResponseHeaderName)
				if err := store.DeletePending(r.Context(), tenantID, storageKey); err != nil {
					writeJSON(w, http.StatusInternalServerError, errEnv(
						"idempotency_revalidation_failed",
						"an internal error occurred",
					))
					return
				}
				rec.flush(w)
				return
			}

			// Cache 2xx and 4xx outcomes — these are deterministic from the
			// client's perspective. Skip 5xx: server errors are transient by
			// definition, and caching them locks the customer's key for the
			// full TTL when the underlying issue may already be resolved on
			// retry. Stripe's contract is the reference here.
			if rec.status >= 500 {
				// Drop the pending claim so a future retry can re-execute.
				_ = store.DeletePending(
					r.Context(), tenantID, storageKey,
				)
				rec.flush(w)
				return
			}

			if err := store.Complete(r.Context(), &Record{
				Key:             storageKey,
				TenantID:        tenantID,
				Route:           route,
				RequestHash:     hash,
				ResponseStatus:  rec.status,
				ResponseBody:    rec.body.Bytes(),
				ResponseHeaders: cloneHeader(rec.header),
				ExpiresAt:       claim.ExpiresAt,
			}); err != nil {
				// The handler has already executed and may have committed an
				// irreversible side effect or crossed a billable provider boundary.
				// Keep the pending claim until its normal expiry (or explicit operator
				// reconciliation) so an uncertain ledger write cannot cause an
				// automatic duplicate execution.
				writeJSON(w, http.StatusInternalServerError, errEnv(
					"idempotency_complete_failed",
					"an internal error occurred",
				))
				return
			}
			rec.flush(w)
		})
	}
}

func canonicalStoredRoute(method, escapedPath string) string {
	path := escapedPath
	const inboxPrefix = "/api/v1/sms/conversations/"
	if strings.HasPrefix(path, inboxPrefix) {
		rest := strings.TrimPrefix(path, inboxPrefix)
		parts := strings.Split(rest, "/")
		if len(parts) >= 2 && parts[0] != "" && parts[0] != "search" {
			parts[0] = "{phone}"
			path = inboxPrefix + strings.Join(parts, "/")
		}
	}
	return method + " " + path
}

func scopedReplayKey(scope, key string) string {
	digest := sha256.Sum256([]byte(scope + "\x00" + key))
	return "scope-v1:" + hex.EncodeToString(digest[:])
}

// cloneHeader returns a defensive copy of h. The recordingWriter's header
// map is reused by the surrounding handler; persisting the live reference
// would race with the response flush.
func cloneHeader(h http.Header) http.Header {
	if len(h) == 0 {
		return nil
	}
	out := make(http.Header, len(h))
	for k, vals := range h {
		cp := make([]string, len(vals))
		copy(cp, vals)
		out[k] = cp
	}
	return out
}

func replayOrReject(w http.ResponseWriter, existing *Record, hash string) bool {
	if existing.RequestHash != hash {
		// Envelope shape MUST match the documented {error:{code,message}}
		// contract — clients that branch on `error.code` would otherwise
		// crash because we previously returned `{"error": "<string>"}`.
		writeJSON(w, http.StatusUnprocessableEntity, errEnv(
			"idempotency_key_request_mismatch",
			"Idempotency-Key reused with a different request body. Either retry with the original body or use a fresh key.",
		))
		return true
	}
	if existing.ResponseStatus == 0 {
		w.Header().Set("Retry-After", "5")
		writeJSON(w, http.StatusConflict, errEnv(
			"idempotency_key_in_progress",
			"A previous request with this Idempotency-Key is still processing. Retry after the Retry-After window.",
		))
		return true
	}
	replay(w, existing)
	return true
}

// recordingWriter captures status, headers, and body without sending bytes to
// the client until the idempotency record has been completed.
type recordingWriter struct {
	header http.Header
	status int
	body   bytes.Buffer
	wrote  bool
}

func newRecordingWriter() *recordingWriter {
	return &recordingWriter{
		header: make(http.Header),
		status: http.StatusOK,
	}
}

func (r *recordingWriter) Header() http.Header {
	return r.header
}

func (r *recordingWriter) WriteHeader(code int) {
	if r.wrote {
		return
	}
	r.status = code
	r.wrote = true
}

func (r *recordingWriter) Write(p []byte) (int, error) {
	if !r.wrote {
		r.WriteHeader(http.StatusOK)
	}
	return r.body.Write(p)
}

func (r *recordingWriter) flush(w http.ResponseWriter) {
	for k, vals := range r.header {
		dst := w.Header()[k][:0]
		dst = append(dst, vals...)
		w.Header()[k] = dst
	}
	w.WriteHeader(r.status)
	_, _ = w.Write(r.body.Bytes())
}

// replay writes the persisted record back to w byte-for-byte. Headers are
// restored from rec.ResponseHeaders when present (post-0033 schema); legacy
// rows without captured headers fall back to defaulting Content-Type for
// JSON bodies, matching the pre-0033 behavior.
func replay(w http.ResponseWriter, rec *Record) {
	if len(rec.ResponseHeaders) > 0 {
		dst := w.Header()
		for k, vals := range rec.ResponseHeaders {
			// Skip hop-by-hop headers and any that the runtime owns.
			switch http.CanonicalHeaderKey(k) {
			case "Content-Length", "Connection", "Keep-Alive",
				"Transfer-Encoding", "Upgrade", "Proxy-Connection":
				continue
			}
			dst[http.CanonicalHeaderKey(k)] = append([]string(nil), vals...)
		}
	} else if len(rec.ResponseBody) > 0 && w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
	}
	w.Header().Set(ReplayedHeaderName, "true")
	// Compatibility aliases remain while clients migrate to the canonical
	// Idempotent-Replayed response header.
	w.Header().Set(LegacyReplayedHeaderName, "true")
	w.Header().Set(InternalReplayHeaderName, "1")
	w.WriteHeader(rec.ResponseStatus)
	_, _ = w.Write(rec.ResponseBody)
}

func hashRequest(method, target string, body []byte) string {
	h := sha256.New()
	h.Write([]byte(method))
	h.Write([]byte{'\n'})
	h.Write([]byte(target))
	h.Write([]byte{'\n'})
	h.Write(body)
	return hex.EncodeToString(h.Sum(nil))
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// errEnv produces the canonical {"error":{"code","message"}} envelope
// used across the gateway. SDK clients branch on `error.code`, so
// returning a bare-string error breaks them.
func errEnv(code, message string) map[string]any {
	return map[string]any{
		"error": map[string]string{
			"code":    code,
			"message": message,
		},
	}
}
