// SPDX-License-Identifier: AGPL-3.0-only

package db

import (
	"context"
	"os"
	"testing"
	"time"
)

// WithTenantUser is only worth having if it actually binds the GUC.
//
// A mutation that swapped `WithTenantUser` back to `WithTenant` inside
// editorcheckpoint's Save left every test in that package green, because Save's
// own SQL still names user_id. The RLS policy that is supposed to catch a
// FUTURE query forgetting that predicate went inert, and nothing said so — the
// exact "a mechanism nothing invokes protects nothing" shape, applied to the
// backstop rather than to the feature.
//
// So the binding is pinned here, at the seam, where it can be asserted directly
// instead of inferred from a query that would pass either way.

func scopePool(t *testing.T) *Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping tenant/user scope test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := New(ctx, url)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestWithTenantUserBindsBothScopes(t *testing.T) {
	pool := scopePool(t)
	ctx := context.Background()
	const tenant = "11111111-1111-1111-1111-111111111111"
	const user = "22222222-2222-2222-2222-222222222222"

	tx, err := WithTenantUser(ctx, pool, tenant, user)
	if err != nil {
		t.Fatalf("WithTenantUser: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var gotTenant, gotUser string
	if err := tx.QueryRow(ctx,
		`SELECT current_setting('app.tenant_id', true), current_setting('app.user_id', true)`).
		Scan(&gotTenant, &gotUser); err != nil {
		t.Fatalf("read settings: %v", err)
	}
	if gotTenant != tenant {
		t.Fatalf("app.tenant_id = %q, want %q", gotTenant, tenant)
	}
	if gotUser != user {
		t.Fatalf("app.user_id = %q, want %q — every owner-scoped RLS policy reads "+
			"this GUC, so an unbound one makes them silently permissive", gotUser, user)
	}
}

// The complement, and the reason WithTenantUser is a separate constructor:
// almost every table here is deliberately shared within a tenant, so WithTenant
// must NOT bind a user. If it did, owner-scoped policies would start filtering
// queries that are supposed to see the whole workspace, and the symptom would be
// an empty list rather than an error.
func TestWithTenantLeavesTheUserScopeUnset(t *testing.T) {
	pool := scopePool(t)
	ctx := context.Background()
	tx, err := WithTenant(ctx, pool, "11111111-1111-1111-1111-111111111111")
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var gotUser string
	// COALESCE because an unset GUC reads as NULL, not as the empty string —
	// which is itself the reason migration 1880's policy tests it with NULLIF
	// rather than comparing to '' and silently never matching.
	if err := tx.QueryRow(ctx,
		`SELECT COALESCE(current_setting('app.user_id', true), '')`).Scan(&gotUser); err != nil {
		t.Fatalf("read setting: %v", err)
	}
	if gotUser != "" {
		t.Fatalf("app.user_id = %q after WithTenant; a tenant-wide transaction has "+
			"inherited an owner scope, which turns shared tables into private ones", gotUser)
	}
}

func TestWithTenantUserRefusesAnEmptyUser(t *testing.T) {
	pool := scopePool(t)
	if _, err := WithTenantUser(context.Background(), pool,
		"11111111-1111-1111-1111-111111111111", ""); err == nil {
		t.Fatal("an empty user id was accepted; the GUC would be set to '' and every " +
			"owner policy would fall through to tenant scope without saying so")
	}
}
