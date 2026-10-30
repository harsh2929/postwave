// SPDX-License-Identifier: AGPL-3.0-only

package pii_scanner

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// A tenant that configured PII scanning must still be deletable.
//
// `tenant_pii_scan_config.tenant_id` cascades from tenants, so on a tenant
// delete the coverage trigger fired AFTER the tenant row was gone and its
// upsert violated tenant_pii_scan_coverage_tenant_id_fkey. The whole DELETE
// failed — so offboarding and GDPR erasure were impossible for any tenant that
// had ever touched the scanner, and the error named a coverage table nobody was
// asking about.
//
// Found only because a `t.Skipf` on a failed fixture was converted to a
// failure; the suite had been reporting PASS over a tenant it could not create.
func TestATenantWithAScanConfigCanStillBeDeleted(t *testing.T) {
	pool := newTestPool(t)
	ctx := context.Background()
	tenantID := uuid.NewString()

	tx, err := db.WithTenant(ctx, (*db.Pool)(pool), tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'pii-delete-test', 'pii-delete-' || right($1::text, 12), 'studio')`,
		tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenant_pii_scan_config (tenant_id, scan_enabled) VALUES ($1::uuid, true)`,
		tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed scan config: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit fixture: %v", err)
	}

	del, err := db.WithTenant(ctx, (*db.Pool)(pool), tenantID)
	if err != nil {
		t.Fatalf("WithTenant(delete): %v", err)
	}
	defer func() { _ = del.Rollback(ctx) }()
	if _, err := del.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID); err != nil {
		t.Fatalf("deleting a tenant that configured PII scanning failed: %v\n"+
			"Offboarding and erasure are blocked for every such tenant.", err)
	}
	if err := del.Commit(ctx); err != nil {
		t.Fatalf("commit delete: %v", err)
	}
}

// And the guard must not swallow an ordinary config delete, where the tenant
// remains and coverage genuinely has to record that scanning stopped.
func TestDeletingOnlyTheScanConfigStillRecordsCoverageAsDisabled(t *testing.T) {
	pool := newTestPool(t)
	ctx := context.Background()
	tenantID := uuid.NewString()

	tx, err := db.WithTenant(ctx, (*db.Pool)(pool), tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'pii-optout-test', 'pii-optout-' || right($1::text, 12), 'studio')`,
		tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenant_pii_scan_config (tenant_id, scan_enabled) VALUES ($1::uuid, true)
ON CONFLICT (tenant_id) DO UPDATE SET scan_enabled = true`, tenantID); err != nil {
		t.Fatalf("enable scanning: %v", err)
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM tenant_pii_scan_config WHERE tenant_id = $1::uuid`, tenantID); err != nil {
		t.Fatalf("delete scan config: %v", err)
	}
	var status string
	if err := tx.QueryRow(ctx,
		`SELECT status FROM tenant_pii_scan_coverage WHERE tenant_id = $1::uuid`,
		tenantID).Scan(&status); err != nil {
		t.Fatalf("the coverage row was not written at all: %v. The cascade guard "+
			"is skipping an ordinary opt-out, so nothing records that scanning "+
			"stopped.", err)
	}
	if status != "disabled" {
		t.Fatalf("coverage status = %q, want \"disabled\"", status)
	}
}
