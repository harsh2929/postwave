package main

import (
	"context"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/rbacresolve"
)

// wireStoredScopeResolver makes a role's persisted roles_permissions grants
// enforceable at request time (G-48). It installs the apikeys.StoredScopeResolver
// hook over the roles_permissions store, so RequireScope's session path can allow
// a scope a custom role was granted in the Settings roles matrix — additive and
// fail-closed, never loosening the built-in tiers. Called once at boot.
func wireStoredScopeResolver(pool *db.Pool) {
	store := &rbacresolve.Store{Pool: pool}
	apikeys.StoredScopeResolver = func(ctx context.Context, tenantID, role string) ([]apikeys.Scope, error) {
		raw, err := store.StoredScopes(ctx, tenantID, role)
		if err != nil {
			return nil, err
		}
		out := make([]apikeys.Scope, 0, len(raw))
		for _, s := range raw {
			out = append(out, apikeys.Scope(s))
		}
		return out, nil
	}
}
