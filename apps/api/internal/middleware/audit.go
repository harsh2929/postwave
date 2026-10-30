package middleware

import (
	"context"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// SessionCookieName is the cookie key the SPA writes the
// session-replay tracker id under. Audit middleware reads this to
// thread the value into AuditMeta.SessionID so each audit_log row
// can be correlated with the browser session that produced it.
//
// session-replay-deeplink (audit-2026 UX, P1).
const SessionCookieName = "pw_session_id"

// EventSeqHeader carries the SPA's per-action monotonic counter. The
// browser increments it once per UI mutation and forwards the value
// on every API call so the server can persist a stable ordering
// inside a session, independent of millisecond-collision `at` ties.
const EventSeqHeader = "X-Postwave-Event-Seq"

// actorCtxKey is a private context-key type so the apikey middleware can
// inject (actor_type, actor_label) without colliding with anything else.
type actorCtxKey int

const (
	ctxKeyActorType actorCtxKey = iota + 1
	ctxKeyActorLabel
	ctxKeyAPIKeyID
)

// WithActor attaches the resolved (actor_type, actor_label) pair to ctx.
// Used by the apikey middleware once it knows whether the bearer token
// belongs to a human or an agent.
func WithActor(ctx context.Context, actorType, actorLabel string) context.Context {
	if actorType != "" {
		ctx = context.WithValue(ctx, ctxKeyActorType, actorType)
	}
	if actorLabel != "" {
		ctx = context.WithValue(ctx, ctxKeyActorLabel, actorLabel)
	}
	return ctx
}

// WithAPIKeyID attaches the resolved API key id to ctx. The cost subsystem
// reads this to attribute ledger rows.
func WithAPIKeyID(ctx context.Context, id string) context.Context {
	if id == "" {
		return ctx
	}
	return context.WithValue(ctx, ctxKeyAPIKeyID, id)
}

// ActorFromContext returns the (actor_type, actor_label) pair previously
// attached by WithActor. Defaults to ("human", "") when nothing is set.
func ActorFromContext(ctx context.Context) (actorType, actorLabel string) {
	if v, ok := ctx.Value(ctxKeyActorType).(string); ok {
		actorType = v
	} else {
		actorType = "human"
	}
	if v, ok := ctx.Value(ctxKeyActorLabel).(string); ok {
		actorLabel = v
	}
	return
}

// APIKeyIDFromContext returns the API key id (if any) attached by the apikey
// middleware. Empty string means the request did not arrive via a bearer key.
func APIKeyIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(ctxKeyAPIKeyID).(string); ok {
		return v
	}
	return ""
}

// AuditMetaFromRequest builds the request-scoped audit metadata for the
// current HTTP request. Handlers that want to write a precise audit row
// should call this and pass the result straight into db.Audit().
//
// We resolve in this order:
//   - tenant id        -> ctx (TenantFromContext)
//   - user id          -> ctx (UserFromContext)  — may be nil in dev mode
//   - actor type/label -> ctx (ActorFromContext) — set by apikey middleware
//   - ip               -> ResolveClientIPString under the startup trust posture
//   - user agent       -> User-Agent header
func AuditMetaFromRequest(r *http.Request) db.AuditMeta {
	at, al := ActorFromContext(r.Context())
	meta := db.AuditMeta{
		IP:         clientIP(r),
		UserAgent:  r.UserAgent(),
		ActorType:  at,
		ActorLabel: al,
		// The id chi already generates and the logger already prints. Carrying
		// it into the audit row is what lets 35 audit tables answer one
		// question: what happened when the operator clicked this.
		RequestID: chimiddleware.GetReqID(r.Context()),
	}
	// API keys intentionally keep their canonical human/agent actor type, but
	// the key id must survive attribution. Without a configured label, use a
	// stable non-secret key identifier so human bearer activity cannot be
	// mistaken for a browser session in the audit trail.
	if keyID := APIKeyIDFromContext(r.Context()); keyID != "" && meta.ActorLabel == "" {
		meta.ActorLabel = "api-key:" + keyID
	}
	if t, ok := TenantFromContext(r.Context()); ok {
		meta.TenantID = t.ID
	}
	if u, ok := UserFromContext(r.Context()); ok {
		uid := u.ID
		meta.UserID = &uid
	}
	// session-replay-deeplink: cookie-derived session id + the SPA's
	// per-action counter. Both are best-effort — agents / system
	// actors have neither, and the audit row simply persists NULL.
	if c, err := r.Cookie(SessionCookieName); err == nil && c != nil {
		if v := strings.TrimSpace(c.Value); v != "" && len(v) <= 128 {
			meta.SessionID = v
		}
	}
	if raw := r.Header.Get(EventSeqHeader); raw != "" {
		if n, err := strconv.ParseInt(raw, 10, 64); err == nil && n > 0 {
			meta.ClientEventSeq = n
		}
	}
	return meta
}

// auditTrustForwardedIPHeaders mirrors the process-wide
// POSTWAVE_TRUST_FORWARDED_IP_HEADERS posture for the audit trail. The trust
// decision is a startup fact, not a per-call-site one, but AuditMetaFromRequest
// is called from ~40 handlers that take no options struct — so the flag is
// stored once at startup rather than plumbed through every one of them. The
// trusted-proxy CIDR set that makes the flag meaningful already lives in this
// package as process state (SetTrustedProxyCIDRs).
var auditTrustForwardedIPHeaders atomic.Bool

// SetAuditTrustForwardedIPHeaders records the startup client-IP trust posture
// for the audit trail. Call it once, from the same place that calls
// SetTrustedProxyCIDRs; the zero value (false) is the safe default, under which
// resolution falls back to the TCP peer.
func SetAuditTrustForwardedIPHeaders(trust bool) {
	auditTrustForwardedIPHeaders.Store(trust)
}

// clientIP resolves the origin address for an audit row.
//
// It used to read r.RemoteAddr directly on the premise that chi's RealIP
// middleware had rewritten it. That middleware is mounted nowhere in this
// gateway (client_ip.go says so outright), so behind the proxy the production
// template configures, every audit_log row recorded the load balancer instead
// of the client — and the UEBA impossible-travel detector, which returns early
// when an event's IP equals the previous one, therefore never fired for anyone.
// Resolve through the same trust model as every other IP consumer in the tree.
func clientIP(r *http.Request) string {
	if ip := ResolveClientIPString(r, auditTrustForwardedIPHeaders.Load()); ip != "" {
		return ip
	}
	// Unresolvable (e.g. a synthetic request with no RemoteAddr). Preserve the
	// old best-effort string so an audit row still carries whatever was there.
	addr := r.RemoteAddr
	if host, _, err := net.SplitHostPort(addr); err == nil {
		return host
	}
	return addr
}

// AuditMiddleware is a best-effort fallback that emits a generic
// audit_log row for every mutating request (POST/PUT/PATCH/DELETE) that
// did not error out at the HTTP layer.
//
// IMPORTANT: this is NOT a substitute for explicit `db.Audit()` calls in
// handlers. The action label here is derived from the route ("POST
// /api/v1/subscribers" -> "http.post.api.v1.subscribers") which is fine for
// forensics but useless for product analytics. Handlers that care about a
// specific action label (e.g. "subscriber.create") MUST call db.Audit
// inside their own tenant-scoped tx — and when they do, this middleware
// will simply add a duplicate generic row, which is acceptable.
//
// We open a short tenant-scoped tx after the response is written. Because
// the response is already flushed, audit failures cannot fail the request;
// we log them and move on.
func AuditMiddleware(pool *db.Pool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !isMutating(r.Method) {
				next.ServeHTTP(w, r)
				return
			}
			if skipGenericAudit(r.URL.Path) {
				next.ServeHTTP(w, r)
				return
			}
			sw := &statusCapturingWriter{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(sw, r)
			if sw.status < http.StatusOK || sw.status >= http.StatusMultipleChoices {
				// A rejected or rolled-back request is not a completed
				// mutation. Recording it as one makes compliance exports claim
				// changes that never happened.
				return
			}
			if pool == nil {
				return
			}
			tenant, ok := TenantFromContext(r.Context())
			if !ok {
				// Public route or unauthenticated — nothing to audit.
				return
			}

			meta := AuditMetaFromRequest(r)
			safePath := auditSafePath(r.URL.Path)
			action := deriveActionForPath(r.Method, safePath)

			// Use a fresh ctx so a cancelled request ctx does not abort the
			// audit write. We bound it lightly via the pool's settings.
			bgCtx := context.Background()

			tx, err := db.WithTenant(bgCtx, pool, tenant.ID)
			if err != nil {
				return
			}
			defer func() { _ = tx.Rollback(bgCtx) }()

			if err := db.Audit(bgCtx, tx, meta, action, "", "", map[string]any{
				"path":   safePath,
				"method": r.Method,
			}); err != nil {
				return
			}
			_ = tx.Commit(bgCtx)
		})
	}
}

func isMutating(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	}
	return false
}

func deriveAction(r *http.Request) string {
	return deriveActionForPath(r.Method, auditSafePath(r.URL.Path))
}

func deriveActionForPath(method, path string) string {
	// "POST /api/v1/subscribers" -> "http.post.api.v1.subscribers"
	parts := []string{"http", strings.ToLower(method)}
	for _, seg := range strings.Split(strings.Trim(path, "/"), "/") {
		if seg == "" {
			continue
		}
		parts = append(parts, seg)
	}
	return strings.Join(parts, ".")
}

// auditSafePath strips capability/PII path segments before they become an
// action label or audit metadata. The handler still receives the original
// path; only the durable audit representation is templated.
func auditSafePath(path string) string {
	const prefix = "/api/v1/sms/conversations/"
	if !strings.HasPrefix(path, prefix) {
		return path
	}
	parts := strings.Split(strings.TrimPrefix(path, prefix), "/")
	if len(parts) >= 2 && parts[0] != "" && parts[0] != "search" {
		parts[0] = "{phone}"
		if len(parts) >= 3 && parts[1] == "tags" && parts[2] != "" {
			parts[2] = "{tag}"
		}
		return prefix + strings.Join(parts, "/")
	}
	return path
}

// skipGenericAudit returns true for pure bootstrap/refresh paths that
// have no forensic value and would otherwise flood audit_log. These are
// endpoints called on a fixed cadence by the SPA/EventSource clients —
// not user-initiated actions. Handlers that DO want a row for one of
// these paths can still call db.Audit() directly.
func skipGenericAudit(path string) bool {
	const playgroundFirePrefix = "/api/v1/outbound-webhooks/"
	const playgroundFireSuffix = "/playground/fire"
	if strings.HasPrefix(path, playgroundFirePrefix) &&
		strings.HasSuffix(path, playgroundFireSuffix) {
		webhookID := strings.TrimSuffix(
			strings.TrimPrefix(path, playgroundFirePrefix),
			playgroundFireSuffix,
		)
		if webhookID != "" && !strings.Contains(webhookID, "/") {
			// The simulator owns a fail-closed reservation + terminal audit
			// lifecycle. A normal generic row would emit audit.created and can
			// turn one diagnostic fire into additional outbound webhook calls.
			return true
		}
	}
	switch path {
	case "/api/v1/streams/token":
		// Short-lived SSE auth token; browser EventSource clients refresh
		// every StreamTokenTTL (2 min) per open stream.
		return true
	case "/api/v1/sms/conversations/search":
		// This POST is a read solely to keep sensitive terms out of edge URL
		// logs. Its handler writes a fail-closed, route-templated read audit.
		return true
	case "/api/v1/sms/suppressions/query":
		// This exact-phone POST is likewise a read whose handler must append a
		// minimized fail-closed audit. A generic mutation-shaped fallback row is
		// misleading and would weaken that deliberate data-minimization boundary.
		return true
	}
	return false
}
