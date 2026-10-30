// SPDX-License-Identifier: AGPL-3.0-only
//
// middleware.go — request-time swap of the tenant context when a
// valid impersonation token is present.

package impersonate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Middleware returns a chi middleware that, when the request carries
// a valid X-Postwave-Impersonation header, replaces the tenant
// context with the target tenant from the impersonation_sessions
// row.
//
// Behavior:
//   - No header → passthrough.
//   - Valid header + active session → swap tenant; for scope=read_only
//     refuse non-GET methods with 403 impersonation_read_only.
//   - Header present but invalid/expired → 401 invalid_impersonation.
//
// Audit: every request that flows through with a valid token gets
// an annotated audit_log entry via the existing audit middleware
// downstream (which reads actor info from context). We mark the
// context here so that middleware can stamp actor_type=platform_operator
// + actor_label=<operator_email>.
func Middleware(pool *db.Pool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := r.Header.Get(HeaderName)
			if token == "" {
				next.ServeHTTP(w, r)
				return
			}
			sum := sha256.Sum256([]byte(token))
			var (
				targetTenant string
				operator     string
				scope        string
				sessionID    string
				expiresAt    time.Time
			)
			err := pool.QueryRow(r.Context(), `
SELECT target_tenant_id::text, operator_email, scope, id::text, expires_at
  FROM impersonation_sessions
 WHERE token_sha256 = $1
   AND ended_at IS NULL
   AND expires_at > now()`,
				sum[:]).Scan(&targetTenant, &operator, &scope, &sessionID, &expiresAt)
			if err != nil {
				writeMWErr(w, http.StatusUnauthorized, "invalid_impersonation",
					"impersonation token invalid or expired")
				return
			}
			if scope == ScopeReadOnly && r.Method != http.MethodGet && r.Method != http.MethodHead {
				writeImpersonationReadOnlyDenial(w)
				return
			}
			// Swap tenant context.
			ctx := middleware.WithTenant(r.Context(), &middleware.Tenant{
				ID: targetTenant,
				// Slug/Name/Tier filled in lazily by handlers that
				// need them — most just use ID. Avoiding a second DB
				// hit here keeps the impersonation request hot path
				// cheap (one row lookup + GUC bind for the request's
				// db transactions).
			})
			ctx = withImpersonator(ctx, impersonatorInfo{
				Operator:  operator,
				SessionID: sessionID,
				Scope:     scope,
			})
			// STAMP THE ACTOR the audit middleware actually reads.
			//
			// The line above marks the context for anything that asks
			// `FromContext`, and until now nothing did — `FromContext` had zero
			// callers repo-wide, and `middleware.ActorFromContext` reads
			// different keys entirely. So the comment on this function ("so that
			// middleware can stamp actor_type=platform_operator + actor_label=
			// <operator_email>") described a hand-off that never happened.
			//
			// The consequence is the one that matters most for a support tool:
			// every action an operator took while impersonating was written into
			// the CUSTOMER'S audit log as an ordinary actor. The tenant sees
			// their own account doing things nobody at their company did, and
			// the privileged access is neither attributable nor reviewable by
			// the person it was exercised against — which is the whole point of
			// bounding it with a reason, a TTL and a read-only default.
			//
			// `WithActor` is the same door every other auth path uses
			// (API keys stamp human/agent and the portal stamps system), so
			// impersonated rows use the database's canonical privileged-operator
			// category rather than a transport-specific spelling.
			ctx = middleware.WithActor(ctx, ActorType, operator)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// impersonatorInfo travels on ctx so downstream audit middleware can
// stamp the actor.
type impersonatorInfo struct {
	Operator  string
	SessionID string
	Scope     string
}

type ctxKey int

const ctxKeyImpersonator ctxKey = 1

func withImpersonator(ctx context.Context, info impersonatorInfo) context.Context {
	return context.WithValue(ctx, ctxKeyImpersonator, info)
}

// FromContext returns the impersonator info if the request carries
// an active impersonation. Used by the audit middleware to mark
// actor_type='platform_operator' on rows the impersonated session writes.
func FromContext(ctx context.Context) (operator, sessionID, scope string, ok bool) {
	info, present := ctx.Value(ctxKeyImpersonator).(impersonatorInfo)
	if !present {
		return "", "", "", false
	}
	return info.Operator, info.SessionID, info.Scope, true
}

func writeMWErr(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"code": code, "message": msg},
	})
}
