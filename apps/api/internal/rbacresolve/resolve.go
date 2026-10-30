// SPDX-License-Identifier: AGPL-3.0-only
//
// Package rbacresolve makes the EXISTING role→scope grants enforceable
// (frontier G-48, rebuild). The roles / roles_permissions tables
// (migration 0262_audit_rbac.sql) already persist per-role scope grants and are
// shown in the Settings > Team > Roles matrix — but nothing READS them at
// request time (grep: the only reader was the display endpoint), so a scope
// granted to a role in the UI never actually took effect.
//
// This resolves a role's effective permissions THROUGH the rbac model: the
// role's built-in matrix as a base, unioned with the scopes stored on the
// existing roles_permissions table (mapped into the permission vocabulary). It
// is the enforcement bridge the config table lacked. Storage is the existing
// tables — no new ones — reusing infrastructure rather than paralleling it.
package rbacresolve

import (
	"context"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/rbac"
)

// scopeToPermission maps each API-key/audit Scope (the currency of the existing
// roles_permissions table) to the rbac permission that models it. The `admin`
// catch-all maps to an admin-tier permission (members.manage) — same mapping
// the apikeys consistency guard uses, kept in sync by TestScopeToPermission*.
var scopeToPermission = map[string]rbac.Permission{
	string(apikeys.ScopeReadSubscribers):         rbac.PermSubscribersRead,
	string(apikeys.ScopeWriteSubscribers):        rbac.PermSubscribersWrite,
	string(apikeys.ScopeReadCampaigns):           rbac.PermCampaignsRead,
	string(apikeys.ScopeWriteCampaigns):          rbac.PermCampaignsWrite,
	string(apikeys.ScopeSendTransactional):       rbac.PermTransactionalSend,
	string(apikeys.ScopeReadReports):             rbac.PermReportsRead,
	string(apikeys.ScopeAdmin):                   rbac.PermMembersManage,
	string(apikeys.ScopeAuditRead):               rbac.PermAuditRead,
	string(apikeys.ScopeAuditReadPII):            rbac.PermAuditReadPII,
	string(apikeys.ScopeAuditReadAllTenants):     rbac.PermAuditReadAll,
	string(apikeys.ScopeAuditConfigureSinks):     rbac.PermAuditConfigure,
	string(apikeys.ScopeAuditConfigureRetention): rbac.PermAuditConfigure,
	string(apikeys.ScopeAuditExecuteActions):     rbac.PermAuditExecute,
}

// ScopeReader loads the scopes stored for a role on the existing
// roles_permissions table. *Store satisfies it; the interface keeps the
// resolution logic unit-testable without a database.
type ScopeReader interface {
	StoredScopes(ctx context.Context, tenantID, roleName string) ([]string, error)
}

// ResolveEffective returns the effective permission set for a role: the
// built-in matrix (via rbac) unioned with the scopes stored for that role,
// mapped into permissions. A stored scope with no mapping (e.g. an obsolete
// one) is skipped rather than failing the whole resolution. A reader error
// propagates so the caller denies (fail closed).
func ResolveEffective(ctx context.Context, reader ScopeReader, tenantID, roleName string) (map[rbac.Permission]bool, error) {
	grants := rbac.ResolveGrants(roleName, nil) // built-in base (empty for a custom role)
	stored, err := reader.StoredScopes(ctx, tenantID, roleName)
	if err != nil {
		return nil, err
	}
	for _, s := range stored {
		if p, ok := scopeToPermission[s]; ok {
			grants[p] = true
		}
	}
	return grants, nil
}

// Store reads the existing roles / roles_permissions tables.
type Store struct {
	Pool *db.Pool
}

// StoredScopes returns the scopes granted to a role (by name) for a tenant,
// from the existing roles_permissions join. Tenant-scoped via WithTenant so RLS
// gates visibility.
func (s *Store) StoredScopes(ctx context.Context, tenantID, roleName string) ([]string, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT rp.scope
  FROM roles_permissions rp
  JOIN roles r ON r.id = rp.role_id
 WHERE r.tenant_id = $1::uuid AND lower(r.name) = lower($2)`, tenantID, roleName)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var scope string
		if err := rows.Scan(&scope); err != nil {
			return nil, err
		}
		out = append(out, scope)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// EffectiveGrants resolves a role's effective permissions using this store.
func (s *Store) EffectiveGrants(ctx context.Context, tenantID, roleName string) (map[rbac.Permission]bool, error) {
	return ResolveEffective(ctx, s, tenantID, roleName)
}

// Can reports whether a role holds a permission in a tenant, resolving custom
// roles from the existing roles_permissions table. It is the production
// PermissionChecker the RequirePermission middleware gates on. An error (e.g.
// the store is unreachable) propagates so the caller denies rather than allows.
func (s *Store) Can(ctx context.Context, tenantID, role string, perm rbac.Permission) (bool, error) {
	grants, err := s.EffectiveGrants(ctx, tenantID, role)
	if err != nil {
		return false, err
	}
	return rbac.CanGrants(grants, perm), nil
}
