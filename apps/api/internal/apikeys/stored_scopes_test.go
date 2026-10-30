// SPDX-License-Identifier: AGPL-3.0-only
package apikeys

import (
	"context"
	"errors"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func ctxWithTenant(id string) context.Context {
	return middleware.WithTenant(context.Background(), &middleware.Tenant{ID: id})
}

func TestStoredGrantsCoverScopes(t *testing.T) {
	orig := StoredScopeResolver
	t.Cleanup(func() { StoredScopeResolver = orig })

	ctx := ctxWithTenant("tenant-1")
	need := []Scope{ScopeWriteCampaigns}

	// nil resolver → deny (pre-G-48 behaviour; feature simply off).
	StoredScopeResolver = nil
	if storedGrantsCoverScopes(ctx, "support", need) {
		t.Error("nil resolver should not grant")
	}

	// A stored grant covering the required scope → allow.
	StoredScopeResolver = func(_ context.Context, tenantID, role string) ([]Scope, error) {
		if tenantID != "tenant-1" || role != "support" {
			t.Errorf("resolver got %s/%s, want tenant-1/support", tenantID, role)
		}
		return []Scope{ScopeReadCampaigns, ScopeWriteCampaigns}, nil
	}
	if !storedGrantsCoverScopes(ctx, "support", need) {
		t.Error("a stored write:campaigns grant should cover the required scope")
	}

	// Missing the required scope → deny (grants must cover ALL required).
	StoredScopeResolver = func(_ context.Context, _, _ string) ([]Scope, error) {
		return []Scope{ScopeReadCampaigns}, nil
	}
	if storedGrantsCoverScopes(ctx, "support", need) {
		t.Error("a role lacking write:campaigns must not be granted it")
	}

	// Resolver error → deny (fail closed: an unreadable grant set never escalates).
	StoredScopeResolver = func(_ context.Context, _, _ string) ([]Scope, error) {
		return nil, errors.New("db down")
	}
	if storedGrantsCoverScopes(ctx, "support", need) {
		t.Error("a resolver error must fail closed (deny)")
	}

	// No tenant in context → deny.
	StoredScopeResolver = func(_ context.Context, _, _ string) ([]Scope, error) {
		return []Scope{ScopeWriteCampaigns}, nil
	}
	if storedGrantsCoverScopes(context.Background(), "support", need) {
		t.Error("missing tenant should deny")
	}

	// Empty role or empty required → deny.
	if storedGrantsCoverScopes(ctx, "", need) {
		t.Error("empty role should deny")
	}
	if storedGrantsCoverScopes(ctx, "support", nil) {
		t.Error("no required scopes should deny (nothing to satisfy)")
	}
}
