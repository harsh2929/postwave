// SPDX-License-Identifier: AGPL-3.0-only
package rbacresolve

import (
	"context"
	"errors"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/rbac"
)

type fakeReader struct {
	scopes []string
	err    error
	calls  int
}

func (f *fakeReader) StoredScopes(_ context.Context, _, _ string) ([]string, error) {
	f.calls++
	return f.scopes, f.err
}

func TestResolveEffectiveBuiltInBase(t *testing.T) {
	// A built-in role starts from the code matrix. With no stored grants it
	// resolves exactly to its built-in permissions.
	r := &fakeReader{scopes: nil}
	grants, err := ResolveEffective(context.Background(), r, "tenant", "editor")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !rbac.CanGrants(grants, rbac.PermCampaignsWrite) {
		t.Error("editor should retain campaigns.write from the built-in matrix")
	}
	if rbac.CanGrants(grants, rbac.PermBillingManage) {
		t.Error("editor should not have billing.manage")
	}
}

func TestResolveEffectiveStoredScopesAdd(t *testing.T) {
	// A stored grant on the EXISTING roles_permissions table (a scope string)
	// is mapped to a permission and unions with the built-in base — this is
	// what makes the previously-unenforced config table actually grant power.
	r := &fakeReader{scopes: []string{"admin"}} // grant the admin scope to editor
	grants, err := ResolveEffective(context.Background(), r, "tenant", "editor")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !rbac.CanGrants(grants, rbac.PermMembersManage) {
		t.Error("a stored 'admin' scope grant should add the admin-tier permission")
	}
}

func TestResolveEffectiveUnknownScopeIgnored(t *testing.T) {
	// A stored scope with no permission mapping (e.g. an obsolete scope) is
	// skipped, not fatal — the role keeps its other grants.
	r := &fakeReader{scopes: []string{"read:reports", "obsolete:scope"}}
	grants, err := ResolveEffective(context.Background(), r, "tenant", "viewer")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !rbac.CanGrants(grants, rbac.PermReportsRead) {
		t.Error("known stored scope should still resolve")
	}
}

func TestResolveEffectiveReaderErrorFailsClosed(t *testing.T) {
	r := &fakeReader{err: errors.New("db down")}
	if _, err := ResolveEffective(context.Background(), r, "tenant", "editor"); err == nil {
		t.Fatal("expected the reader error to propagate (fail closed)")
	}
}

func TestScopeToPermissionCoversCatalog(t *testing.T) {
	// Guard: every audit scope the existing PUT /roles/{id}/scopes endpoint can
	// store must have a permission mapping, or resolving a role that was granted
	// it would silently drop the grant.
	for _, s := range []string{
		"read:subscribers", "write:subscribers", "read:campaigns", "write:campaigns",
		"send:transactional", "read:reports", "admin",
		"audit:read", "audit:read_pii", "audit:read_all_tenants",
		"audit:configure_sinks", "audit:configure_retention", "audit:execute_actions",
	} {
		if _, ok := scopeToPermission[s]; !ok {
			t.Errorf("scope %q has no permission mapping", s)
		}
	}
}
