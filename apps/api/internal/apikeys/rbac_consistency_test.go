// SPDX-License-Identifier: AGPL-3.0-only
package apikeys

import (
	"testing"

	"github.com/postwave/postwave/apps/api/internal/rbac"
)

// scopeToPermission maps each API-key Scope to the rbac.Permission that models
// the same capability. The `admin` catch-all scope is represented by an
// admin-only permission (members.manage) since it grants broad admin-tier power
// with no single finer equivalent.
var scopeToPermission = map[Scope]rbac.Permission{
	ScopeReadSubscribers:         rbac.PermSubscribersRead,
	ScopeWriteSubscribers:        rbac.PermSubscribersWrite,
	ScopeReadCampaigns:           rbac.PermCampaignsRead,
	ScopeWriteCampaigns:          rbac.PermCampaignsWrite,
	ScopeSendTransactional:       rbac.PermTransactionalSend,
	ScopeReadReports:             rbac.PermReportsRead,
	ScopeAdmin:                   rbac.PermMembersManage,
	ScopeAuditRead:               rbac.PermAuditRead,
	ScopeAuditReadPII:            rbac.PermAuditReadPII,
	ScopeAuditReadAllTenants:     rbac.PermAuditReadAll,
	ScopeAuditConfigureSinks:     rbac.PermAuditConfigure,
	ScopeAuditConfigureRetention: rbac.PermAuditConfigure,
	ScopeAuditExecuteActions:     rbac.PermAuditExecute,
	ScopeMCP:                     rbac.PermMCPInvoke,
}

// TestRBACModelMatchesSessionAuthz pins the rbac permission model to the live
// session-cookie authorization path (sessionRoleAllowsScopes). For every
// built-in role and every scope, the model's Can() decision must equal what the
// live authz permits. This is what makes internal/rbac the *verified*
// generalization of the ad-hoc scope allowlists (G-48) rather than a parallel
// model that could silently drift: change editorWriteScopes or the rbac matrix
// in isolation and this fails.
func TestRBACModelMatchesSessionAuthz(t *testing.T) {
	roles := []string{"owner", "admin", "editor", "viewer", "member"}
	for _, role := range roles {
		for scope, perm := range scopeToPermission {
			live := sessionRoleAllowsScopes(role, []Scope{scope})
			model := rbac.Can(role, perm)
			if live != model {
				t.Errorf("role=%s scope=%s: live session authz=%v but rbac.Can(%s)=%v — model and live path disagree",
					role, scope, live, perm, model)
			}
		}
	}
}

// TestEveryScopeIsMapped guards against a new Scope being added to the catalog
// without a corresponding rbac permission — otherwise the consistency check
// above would silently skip it.
//
// IT ITERATES AllScopes, NOT A LOCAL COPY. It used to loop over a hand-written
// 13-element slice declared inside the test, which meant it answered "are the
// scopes I remembered mapped?" and never "is every scope in the catalog
// mapped?". `ScopeMCP` is appended to AllScopes by an init() in scopes.go, was
// in neither the local slice nor `scopeToPermission`, and so the exact
// condition this test NAMES was already true in the tree while it was green.
//
// A mirror of a catalog is a second catalog that nothing keeps in step. Reading
// the real one is the only version of this test that can do its stated job.
func TestEveryScopeIsMapped(t *testing.T) {
	// Vacuity floor: an empty or truncated catalog would make the loop below
	// pass having checked nothing.
	if len(AllScopes) < 14 {
		t.Fatalf("AllScopes holds only %d scopes; the catalog looks truncated and "+
			"this test would pass without measuring anything", len(AllScopes))
	}
	for _, s := range AllScopes {
		if _, ok := scopeToPermission[s]; !ok {
			t.Errorf("scope %q is in the AllScopes catalog and has no rbac permission "+
				"mapping — add one to scopeToPermission", s)
		}
	}
}

// TestEveryMappedPermissionIsReal closes the other direction: a mapping may name
// a permission the rbac model does not grant to anybody, which would make the
// consistency check compare against a permission that can never be held.
func TestEveryMappedPermissionIsReal(t *testing.T) {
	for scope, perm := range scopeToPermission {
		if rbac.LeastRoleWith(perm) == "" {
			t.Errorf("scope %q maps to permission %q, which no role grants", scope, perm)
		}
	}
}
