// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"context"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// The checked-in local environment historically used the sentinel region
// "local", which is intentionally absent from tenants.data_region's database
// enum. Signup must still create a tenant in development while production
// startup separately rejects unsupported deployment regions.
func TestCreateTenantWithOwner_LocalRegionUsesDatabaseSafeDefault(t *testing.T) {
	t.Setenv("POSTWAVE_DEPLOYMENT_REGION", "local")
	pool := cliAuthDB(t)
	unique := cliUUID(t)
	slug := "signup-local-" + unique[:8]
	email := "signup-local-" + unique[:8] + "@example.test"

	repo := &Repo{Pool: pool}
	tenantID, userID, err := repo.CreateTenantWithOwner(
		context.Background(), "Local signup regression", slug, email, "test-password-phc",
	)
	if err != nil {
		t.Fatalf("CreateTenantWithOwner: %v", err)
	}
	if tenantID == "" || userID == "" {
		t.Fatalf("missing created ids: tenant=%q user=%q", tenantID, userID)
	}

	// deleteAuthTestTenant: a one-minute budget and a retry on transient lock
	// contention. The five seconds this cleanup had were too few for a tenant
	// cascade (about 735 foreign keys) while other packages delete tenants too.
	t.Cleanup(func() { deleteAuthTestTenant(t, pool, tenantID) })

	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("tenant read transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var dataRegion string
	if err := tx.QueryRow(context.Background(), `
		SELECT data_region
		  FROM tenants
		 WHERE id = $1::uuid`, tenantID).Scan(&dataRegion); err != nil {
		t.Fatalf("read created tenant: %v", err)
	}
	if dataRegion != "us-east-1" {
		t.Fatalf("data_region=%q, want us-east-1", dataRegion)
	}
}
