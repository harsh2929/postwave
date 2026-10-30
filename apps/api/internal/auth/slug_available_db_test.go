// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"context"
	"testing"
)

// TestSlugAvailable proves the AUTH-015 pre-signup probe against a real tenant:
// an unused slug reads available; a slug owned by a created tenant reads taken.
func TestSlugAvailable(t *testing.T) {
	t.Setenv("POSTWAVE_DEPLOYMENT_REGION", "local")
	pool := cliAuthDB(t)
	unique := cliUUID(t)
	repo := &Repo{Pool: pool}

	free := "slugfree-" + unique[:8]
	if ok, err := repo.SlugAvailable(context.Background(), free); err != nil || !ok {
		t.Fatalf("SlugAvailable(unused) = (%v, %v), want (true, nil)", ok, err)
	}

	taken := "slugtaken-" + unique[:8]
	email := "slugcheck-" + unique[:8] + "@example.test"
	tenantID, _, err := repo.CreateTenantWithOwner(
		context.Background(), "Slug check", taken, email, "test-password-phc",
	)
	if err != nil {
		t.Fatalf("CreateTenantWithOwner: %v", err)
	}
	// deleteAuthTestTenant: a one-minute budget and a retry on transient lock
	// contention. The five seconds this cleanup had were too few for a tenant
	// cascade (about 735 foreign keys) while other packages delete tenants too.
	t.Cleanup(func() { deleteAuthTestTenant(t, pool, tenantID) })

	if ok, err := repo.SlugAvailable(context.Background(), taken); err != nil || ok {
		t.Fatalf("SlugAvailable(taken) = (%v, %v), want (false, nil)", ok, err)
	}
}
