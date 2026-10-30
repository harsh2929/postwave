// SPDX-License-Identifier: AGPL-3.0-only
//
// auth.go — platform-operator identity for the ops console.
//
// The ops console holds cross-tenant destructive controls, so none of the
// existing identity kinds can gate it: apikeys.ScopeAdmin is a TENANT
// wildcard and tenants.admin_ip_allowlist is a PER-TENANT allowlist. This is
// a new identity kind: a person is a platform operator iff ALL THREE hold —
//
//  1. their existing Moosewave web session resolves (SessionResolver),
//  2. TOTP is satisfied for that session, and
//  3. their client IP is inside the ip_allowlist CIDRs of a live
//     (disabled_at IS NULL) platform_operators row matching their email.
//
// Decoupling seam: this package never imports the auth package. main.go
// constructs the real SessionResolver from the session/TOTP machinery and
// hands it in — the same narrow-interface pattern the sending package uses
// for its Mailer, so tests can stub identity without dragging in internals.
//
// Everything fails closed: no session / no operator row / no TOTP → 401;
// session fine but IP unresolvable, off-allowlist, or allowlist EMPTY → 403.
// A DB error is a 500 — never a fall-through to the handler.

package ops

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// OperatorSession is what the ops console needs to know about the caller's
// web session — nothing more. The auth package knows how to produce one;
// this package only consumes it.
type OperatorSession struct {
	Email        string
	TOTPVerified bool
}

// SessionResolver resolves the caller's Moosewave web session, if any.
// Returning ok=false means "no usable session" — which is also what a tenant
// API key looks like here: resolvers only understand sessions, so Bearer
// keys resolve to nothing and are refused.
type SessionResolver func(r *http.Request) (OperatorSession, bool)

// Operator is the authenticated platform operator stashed in the request
// context on success.
type Operator struct {
	ID    string
	Email string
}

type operatorCtxKey struct{}

const (
	opsCSRFHeader = "X-Postwave-Ops-CSRF"
	opsCSRFValue  = "same-origin"
)

// OperatorFromContext returns the platform operator authenticated by
// RequirePlatformOperator, if any.
func OperatorFromContext(ctx context.Context) (Operator, bool) {
	op, ok := ctx.Value(operatorCtxKey{}).(Operator)
	return op, ok
}

// ContextWithOperator attaches an authenticated operator. Exported so action
// runners in other packages can be tested against a real authenticated
// context rather than a mock of one -- the alternative is a runner whose
// identity handling is only ever exercised through the middleware, which is
// how "who did this" ends up untested.
//
// It does not grant anything: the gate is RequirePlatformOperator, and this
// only carries what that gate already decided.
func ContextWithOperator(ctx context.Context, op Operator) context.Context {
	return context.WithValue(ctx, operatorCtxKey{}, op)
}

// RequireWriteCSRF adds an explicit non-simple header requirement to every
// state-changing ops request. Browsers cannot attach this header cross-origin
// without a successful CORS preflight, and the ops API does not grant one.
// Read methods pass through unchanged.
func RequireWriteCSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		if r.Header.Get(opsCSRFHeader) != opsCSRFValue {
			writeOpsAuthErr(w, http.StatusForbidden,
				"csrf_rejected", "state-changing ops requests require the same-origin CSRF header")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequirePlatformOperator gates a handler behind platform-operator identity:
// session AND TOTP AND IP allowlist, all fail-closed. The pool must be the
// OPS pool (role postwave_ops has SELECT on platform_operators; the tenant
// app role does not).
//
// Client IP resolution mirrors the rest of the codebase: RemoteAddr only,
// unless POSTWAVE_TRUST_FORWARDED_IP_HEADERS is set (same envBool semantics
// as config.Load), in which case middleware.ResolveClientIP applies its
// trusted-proxy XFF walk. The flag is read once at construction, matching
// config load at startup.
func RequirePlatformOperator(pool *pgxpool.Pool, resolve SessionResolver) func(http.Handler) http.Handler {
	trustHeaders := envBoolOps("POSTWAVE_TRUST_FORWARDED_IP_HEADERS")

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			sess, ok := resolve(r)
			if !ok || strings.TrimSpace(sess.Email) == "" {
				writeOpsAuthErr(w, http.StatusUnauthorized,
					"operator_session_required",
					"the ops console requires a Moosewave web session; API keys are tenant-scoped and do not apply")
				return
			}

			var (
				operatorID string
				allowlist  []string
			)
			err := pool.QueryRow(r.Context(),
				`SELECT id, ip_allowlist
				   FROM platform_operators
				  WHERE email = $1 AND disabled_at IS NULL`,
				sess.Email).Scan(&operatorID, &allowlist)
			if errors.Is(err, pgx.ErrNoRows) {
				writeOpsAuthErr(w, http.StatusUnauthorized,
					"not_a_platform_operator",
					"this account is not a platform operator")
				return
			}
			if err != nil {
				writeOpsAuthErr(w, http.StatusInternalServerError,
					"operator_lookup_failed",
					"could not verify platform-operator status")
				return
			}

			if !sess.TOTPVerified {
				writeOpsAuthErr(w, http.StatusUnauthorized,
					"totp_required",
					"the ops console requires a TOTP-verified session")
				return
			}

			if len(allowlist) == 0 {
				// Fail closed: an empty allowlist is a misconfigured
				// operator, not an open door.
				writeOpsAuthErr(w, http.StatusForbidden,
					"ip_allowlist_empty",
					"configure ip_allowlist for this operator before using the ops console")
				return
			}
			clientIP := middleware.ResolveClientIPString(r, trustHeaders)
			if clientIP == "" || !middleware.IPMatchesAllowlist(clientIP, allowlist) {
				writeOpsAuthErr(w, http.StatusForbidden,
					"ip_not_allowed",
					"this request is not from an allowlisted operator IP")
				return
			}

			ctx := ContextWithOperator(r.Context(),
				Operator{ID: operatorID, Email: sess.Email})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// envBoolOps mirrors config.envBool (unexported there): 1/true/yes/on,
// case-insensitively, mean true.
func envBoolOps(key string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func writeOpsAuthErr(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}
