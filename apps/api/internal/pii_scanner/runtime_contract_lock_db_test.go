// SPDX-License-Identifier: AGPL-3.0-only

package pii_scanner

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Enabling PII scanning must bind the tenant to the active scanner contract.
//
// It did not, and the scanner therefore never scanned anything, for any tenant,
// silently. The coverage trigger pins the deployment contract with
//
//	SELECT ... FROM pii_scan_runtime_contract WHERE singleton FOR SHARE
//
// inside the caller's transaction — and the caller is the API acting for a
// tenant. `pii_scan_runtime_contract` had a SELECT-only policy for tenant scope,
// and PostgreSQL applies UPDATE policies to a row-locking clause, so the row was
// readable but not LOCKABLE: `FOR SHARE` matched zero rows, `SELECT ... INTO`
// left the variables NULL without raising, and
// `tenant_pii_scan_coverage.scan_contract` was written NULL.
//
// Every claim query requires `coverage.scan_contract = $1`, so no intent was
// ever claimed and no finding ever produced. Nothing errored — the failure was
// indistinguishable from a scanner with nothing to do.
//
// Migration 1900 adds a tenant UPDATE policy with `WITH CHECK (false)`:
// lockable, not writable.
func TestEnablingScanningBindsTheTenantToTheActiveContract(t *testing.T) {
	pool := newTestPool(t)
	ctx := context.Background()
	repo := &Repo{Pool: pool}
	detector := newTestDetector(t)
	contract, ok := currentCoverageScanContract(detector)
	if !ok {
		t.Fatal("test detector produced no coverage contract")
	}
	if _, err := repo.activateScannerContract(ctx, true, contract); err != nil {
		t.Fatalf("activate contract: %v", err)
	}

	tenantID := uuid.NewString()
	tx, err := db.WithTenant(ctx, (*db.Pool)(pool), tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'pii-bind-test', 'pii-bind-' || right($1::text, 12), 'studio')`,
		tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}

	// The lock itself, from tenant scope. This is the exact statement the
	// trigger runs, and it returned no rows.
	var locked int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM (
  SELECT 1 FROM pii_scan_runtime_contract runtime WHERE runtime.singleton FOR SHARE
) locked`).Scan(&locked); err != nil {
		t.Fatalf("lock the runtime contract from tenant scope: %v", err)
	}
	if locked != 1 {
		t.Fatalf("SELECT ... FOR SHARE matched %d rows from tenant scope, want 1. "+
			"The coverage trigger cannot pin the contract, so every tenant is "+
			"bound to a NULL contract and nothing is ever scanned.", locked)
	}

	// And the observable consequence: enabling binds a real contract.
	if _, err := tx.Exec(ctx, `
INSERT INTO tenant_pii_scan_config (tenant_id, scan_enabled) VALUES ($1::uuid, true)`,
		tenantID); err != nil {
		t.Fatalf("enable scanning: %v", err)
	}
	var bound *string
	if err := tx.QueryRow(ctx, `
SELECT scan_contract FROM tenant_pii_scan_coverage WHERE tenant_id = $1::uuid`,
		tenantID).Scan(&bound); err != nil {
		t.Fatalf("read coverage: %v", err)
	}
	if bound == nil {
		t.Fatal("coverage.scan_contract is NULL after enabling. No claim query " +
			"can match it, so no subscriber is ever scanned — and nothing reports " +
			"an error.")
	}
	if *bound != contract {
		t.Fatalf("bound to %q, want the active contract", *bound)
	}
}

// A tenant may LOCK the deployment singleton and must never MODIFY it.
func TestATenantCannotModifyTheDeploymentRuntimeContract(t *testing.T) {
	pool := newTestPool(t)
	ctx := context.Background()
	tenantID := uuid.NewString()

	tx, err := db.WithTenant(ctx, (*db.Pool)(pool), tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`UPDATE pii_scan_runtime_contract SET availability_status = 'unavailable' WHERE singleton`); err == nil {
		t.Fatal("a tenant transaction rewrote the deployment-wide scanner " +
			"contract. The lock policy was widened into a write policy.")
	}
}
