// SPDX-License-Identifier: AGPL-3.0-only
//
// audit_meta.go — meta-audit-trail middleware for the read side of
// /api/v1/audit. Every successful audit read emits a first-class
// audit_log row tagged action="audit.read.<kind>" with the canonical
// query, the row count returned, and the raw filter map.
//
// Compliance gap-doc category: Compliance, P0. Auditors need to know
// who is *reading* the audit trail — pulling the export of last
// quarter's auth-failure log is itself a sensitive operation.
//
// Wiring: chained AFTER apikeys.RequireScope(ScopeAuditRead) in the
// route stack so unauthorized callers never reach the emit path. The
// emit fires post-response (response is already flushed) so audit
// failures cannot fail the underlying read; we log and move on.
package middleware

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// AuditReadKind enumerates the meta-audit action subtypes. Stored as
// the action label so the existing /api/v1/audit ?action=audit.read
// filter surfaces all meta rows in one query.
type AuditReadKind string

const (
	AuditReadList        AuditReadKind = "audit.read.list"
	AuditReadExport      AuditReadKind = "audit.read.export"
	AuditReadStreamOpen  AuditReadKind = "audit.read.stream_open"
	AuditReadStats       AuditReadKind = "audit.read.stats"
	AuditReadEventDetail AuditReadKind = "audit.read.event_detail"
	AuditReadSavedViews  AuditReadKind = "audit.read.saved_views"
	AuditReadRetention   AuditReadKind = "audit.read.retention"
)

// rowCountCtxKey lets a handler (e.g. List, Export) thread its final
// row count back up to the AuditMetaMiddleware that wraps it. The
// counter is an atomic.Int64 so the streaming-export handler can
// increment per-row without contending on a lock.
type rowCountCtxKey struct{}

// WithRowCounter attaches an atomic row counter to ctx. Handlers that
// stream pull this out and IncrementRowCount per row written; List
// and Stats handlers can just Store the final count once. The middleware
// reads the counter in the post-response emit.
func WithRowCounter(ctx context.Context, c *atomic.Int64) context.Context {
	if c == nil {
		c = new(atomic.Int64)
	}
	return context.WithValue(ctx, rowCountCtxKey{}, c)
}

// RowCounterFromContext returns the counter previously attached. Returns
// a fresh zero counter when none is present so handler code can call
// counter.Add without nil-checks.
func RowCounterFromContext(ctx context.Context) *atomic.Int64 {
	if v, ok := ctx.Value(rowCountCtxKey{}).(*atomic.Int64); ok && v != nil {
		return v
	}
	return new(atomic.Int64)
}

// AuditMetaMiddleware wraps a handler so that, after it returns
// successfully (2xx), a row is appended to audit_log capturing the
// query that was answered. The middleware is parameterised by `kind`
// so the same wrapper can drive list/export/stream emissions with
// slightly different action labels.
//
// pool may be nil in test contexts — when nil the middleware skips
// the DB write but still attaches the counter so handlers don't NPE.
func AuditMetaMiddleware(pool *db.Pool, kind AuditReadKind) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			counter := new(atomic.Int64)
			ctx := WithRowCounter(r.Context(), counter)
			sw := &statusCapturingWriter{ResponseWriter: w, status: http.StatusOK}

			next.ServeHTTP(sw, r.WithContext(ctx))

			// Skip emit for unauthorized / forbidden / server errors.
			// 4xx responses already convey "this didn't happen" to
			// the auditor; emitting a meta-audit row for a 403 would
			// double the log noise.
			if sw.status < 200 || sw.status >= 300 {
				return
			}
			if pool == nil {
				return
			}
			tenant, ok := TenantFromContext(r.Context())
			if !ok {
				return
			}

			meta := AuditMetaFromRequest(r)
			metadata := buildAuditReadMetadata(r, counter.Load())

			// Use a fresh ctx so a cancelled request ctx cannot
			// abort the audit write. Same pattern as AuditMiddleware.
			bgCtx := context.Background()
			tx, err := db.WithTenant(bgCtx, pool, tenant.ID)
			if err != nil {
				return
			}
			defer func() { _ = tx.Rollback(bgCtx) }()

			if err := db.Audit(bgCtx, tx, meta, string(kind), "audit_log", "", metadata); err != nil {
				return
			}
			_ = tx.Commit(bgCtx)
		})
	}
}

// statusCapturingWriter records the status the wrapped handler wrote.
// We need this because http.ResponseWriter swallows the WriteHeader
// status and a plain w.Write defaults to 200 without surfacing it.
type statusCapturingWriter struct {
	http.ResponseWriter
	status int
	wrote  bool
}

// Unwrap lets http.ResponseController discover optional capabilities (hijack,
// deadlines, full duplex) on the underlying writer even while status capture
// is active.
func (s *statusCapturingWriter) Unwrap() http.ResponseWriter {
	return s.ResponseWriter
}

func (s *statusCapturingWriter) WriteHeader(code int) {
	if !s.wrote {
		s.status = code
		s.wrote = true
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusCapturingWriter) Write(b []byte) (int, error) {
	if !s.wrote {
		s.wrote = true
	}
	return s.ResponseWriter.Write(b)
}

// Flush forwards through the writer chain. The audit Stream handler relies on
// Flush to push SSE frames; without this method the wrapped writer hides the
// Flusher interface and the stream stalls in the client. Forwarding goes
// through http.ResponseController rather than asserting http.Flusher on the
// next writer, because a wrapper below that only unwraps would otherwise drop
// the flush here.
func (s *statusCapturingWriter) Flush() {
	_ = http.NewResponseController(s.ResponseWriter).Flush()
}

// buildAuditReadMetadata produces the metadata blob attached to the
// audit.read.* row. Includes the canonical query (sorted, secret
// query-params stripped), the raw filter map, and the row count the
// handler reported.
func buildAuditReadMetadata(r *http.Request, rowCount int64) map[string]any {
	filters := normalizeFilters(r.URL.Query())
	if strings.HasPrefix(r.URL.Path, "/api/v1/sms/") {
		for _, key := range []string{"q", "tag", "phone", "cursor"} {
			delete(filters, key)
		}
	}
	canonical := canonicalQueryString(filters)

	// We deliberately do NOT include the full URL — only the
	// path + canonical filter string — because the URL may carry
	// a stream_token query param (auth credential), and we never
	// want a credential to land in audit_log metadata.
	return map[string]any{
		"path":            auditSafePath(r.URL.Path),
		"method":          r.Method,
		"query_canonical": canonical,
		"filters":         filters,
		"row_count":       rowCount,
	}
}

// normalizeFilters strips auth/transport-only params (stream_token,
// api_key, _) so the canonical query string is a pure filter description.
// Returns a map of the remaining keys -> single value (last-write-wins
// when a key repeats — none of our filter params accept arrays).
func normalizeFilters(q map[string][]string) map[string]string {
	out := map[string]string{}
	for k, v := range q {
		if isAuthOrTransportParam(k) {
			continue
		}
		if len(v) == 0 {
			continue
		}
		val := strings.TrimSpace(v[len(v)-1])
		if val == "" {
			continue
		}
		out[k] = val
	}
	return out
}

func isAuthOrTransportParam(key string) bool {
	switch strings.ToLower(key) {
	case "stream_token", "api_key", "_", "_t", "_ts", "cb":
		return true
	}
	return false
}

// canonicalQueryString returns key=value pairs joined by '&' with keys
// sorted alphabetically. Auditors comparing two reads can string-compare
// the canonical form to see whether they asked the same question.
func canonicalQueryString(filters map[string]string) string {
	if len(filters) == 0 {
		return ""
	}
	keys := make([]string, 0, len(filters))
	for k := range filters {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(filters))
	for _, k := range keys {
		parts = append(parts, k+"="+filters[k])
	}
	return strings.Join(parts, "&")
}

// EmitAuditReadEvent is a direct emit path for handlers that cannot
// be wrapped (e.g. SSE streams that never exit until disconnect, so
// the post-response hook would never fire). The caller must already
// hold a tenant context.
//
// The action label is the kind string. The metadata is built the same
// way as the middleware so a downstream auditor can't tell the two
// emission paths apart.
func EmitAuditReadEvent(ctx context.Context, pool *db.Pool, r *http.Request, kind AuditReadKind, rowCount int64) {
	if pool == nil {
		return
	}
	tenant, ok := TenantFromContext(ctx)
	if !ok {
		return
	}
	meta := AuditMetaFromRequest(r)
	metadata := buildAuditReadMetadata(r, rowCount)
	bgCtx := context.Background()
	tx, err := db.WithTenant(bgCtx, pool, tenant.ID)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(bgCtx) }()
	if err := db.Audit(bgCtx, tx, meta, string(kind), "audit_log", "", metadata); err != nil {
		return
	}
	_ = tx.Commit(bgCtx)
}

// jsonMetadataString is a tiny helper used in tests to round-trip a
// metadata map through encoding/json for stable equality assertions.
func jsonMetadataString(m map[string]any) string {
	b, _ := json.Marshal(m)
	return string(b)
}

// Local symbol kept alive for the test file (read by the audit_meta_test).
var _ = strconv.Itoa
var _ = jsonMetadataString
