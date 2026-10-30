// SPDX-License-Identifier: AGPL-3.0-only
//
// stored_scopes.go — the enforcement bridge that makes a role's PERSISTED scope
// grants (roles / roles_permissions, migration 0262 + 1743) actually take effect
// on the session-cookie path (frontier G-48).
//
// Before this, roles_permissions was written by the Settings > Roles matrix but
// read by NOTHING at request time, so granting a role a scope had no effect.
// RequireScope's session path decided purely from the hardcoded role tiers
// (owner/admin = all, editor = content-write, viewer = read-only). This adds an
// ADDITIVE consultation: when the hardcoded tier denies an admin-tier scope, the
// role's stored grants are checked — a stored grant can only ALLOW more, never
// deny, so wiring it cannot break any existing route's authz. It fails CLOSED:
// a nil resolver or a lookup error denies the extra scope rather than granting.
package apikeys

import (
	"context"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// StoredScopeResolver, when set at boot, returns the scopes a (tenant, role)
// has been granted in roles_permissions. Left nil the behaviour is exactly the
// pre-G-48 hardcoded-tier enforcement. The composition root wires it over the
// roles_permissions store; apikeys owns only the func type so it need not import
// (and cycle with) the storage package.
var StoredScopeResolver func(ctx context.Context, tenantID, role string) ([]Scope, error)

// storedGrantsCoverScopes reports whether the caller's role has been granted
// EVERY one of the required scopes via roles_permissions. Returns false — deny —
// when the resolver is unset, the tenant is unknown, the lookup errors, or any
// required scope is missing. Additive + fail-closed by construction.
func storedGrantsCoverScopes(ctx context.Context, role string, required []Scope) bool {
	if StoredScopeResolver == nil || role == "" || len(required) == 0 {
		return false
	}
	t, ok := middleware.TenantFromContext(ctx)
	if !ok || t == nil || t.ID == "" {
		return false
	}
	granted, err := StoredScopeResolver(ctx, t.ID, role)
	if err != nil {
		return false // fail closed: an unreadable grant set never escalates.
	}
	have := make(map[Scope]struct{}, len(granted))
	for _, s := range granted {
		have[s] = struct{}{}
	}
	for _, need := range required {
		if _, ok := have[need]; !ok {
			return false
		}
	}
	return true
}
