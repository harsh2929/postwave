// SPDX-License-Identifier: AGPL-3.0-only
//
// middleware.go — the request-time enforcement primitive for the permission
// model (frontier G-48, enforcement). rbac.RequirePermission gates on the
// built-in matrix synchronously; this gates on the EFFECTIVE grants (built-in
// matrix ∪ the role's stored grants from the existing roles_permissions table),
// so a permission granted to a role in the roles matrix actually takes effect.
//
// This is deliberately ADDITIVE: it is a new middleware routes opt into, and it
// does NOT touch the live apikeys.RequireScope path — so adopting it on a route
// is the only thing that changes that route's behaviour, and the existing authz
// for every other route is untouched. The check is a pure function of
// (tenant, role, permission) over an injected PermissionChecker, which keeps the
// enforcement logic unit-testable without a database (*Store is the production
// checker; a fake satisfies it in tests).
package rbacresolve

import (
	"context"
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/rbac"
)

// PermissionChecker answers whether a role holds a permission in a tenant,
// resolving custom roles from storage. *Store satisfies it (via Store.Can).
type PermissionChecker interface {
	Can(ctx context.Context, tenantID, role string, perm rbac.Permission) (bool, error)
}

// *Store is the production PermissionChecker (resolves via the existing
// roles_permissions table). Pinned so the two can't drift.
var _ PermissionChecker = (*Store)(nil)

// PrincipalFunc extracts the caller's tenant id + role from the request,
// returning ok=false when there is no authenticated dashboard principal. Passed
// in so this package needs no dependency on middleware/apikeys (no import cycle);
// the composition root supplies an adapter over middleware.{Tenant,User}FromContext.
type PrincipalFunc func(*http.Request) (tenantID, role string, ok bool)

// RequirePermission gates a route on a single permission, resolving the caller's
// role — built-in OR tenant-defined custom — through the checker. A missing
// principal is 401; a role that lacks the permission is 403; a resolution error
// (e.g. the store is unreachable) is 403 as well — fail CLOSED, never allow on
// error.
func RequirePermission(perm rbac.Permission, checker PermissionChecker, principal PrincipalFunc) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tenantID, role, ok := principal(r)
			if !ok {
				writeDeny(w, http.StatusUnauthorized, "missing_principal",
					"an authenticated dashboard user is required")
				return
			}
			allowed, err := checker.Can(r.Context(), tenantID, role, perm)
			if err != nil {
				// Fail closed: an inability to resolve the role's grants must
				// deny, never allow — a store outage cannot become an escalation.
				writePermissionCheckFailedDenial(w)
				return
			}
			if !allowed {
				writeInsufficientPermissionDenial(w, string(perm))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func writeDeny(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(`{"error":{"code":"` + code + `","message":"` + message + `"}}`))
}
