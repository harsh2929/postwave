// SPDX-License-Identifier: AGPL-3.0-only
//
// pii_scan_hook_db_test.go — pg-backed test for SUB-071: the shadow-PII scanner
// is invoked on the subscriber write path. A create whose free-text custom
// field carries an undeclared SSN must, with the tenant's scan config enabled,
// produce a subscriber_pii_findings row. Skips cleanly without DATABASE_URL,
// matching the project-wide pg-backed test convention. Requires migrations 0550
// (subscriber_pii_findings) + 0551 (tenant_pii_scan_config).

package subscribers

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/pii_scanner"
)

// piiScanTestAdapter mirrors main.go's piiScannerAdapter: it self-gates on the
// tenant's scan config and delegates to the real pii_scanner detector + repo,
// so the test exercises the exact production wiring shape.
type piiScanTestAdapter struct {
	deps *pii_scanner.Deps
	repo *pii_scanner.Repo
}

func (a piiScanTestAdapter) ScanSubscriber(ctx context.Context, tenantID, subscriberID string, fields map[string]any) (int, error) {
	return a.deps.ScanConfiguredSubscriber(ctx, tenantID, subscriberID, fields)
}

func newPIIScanHookTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed pii-scan-hook test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedPIIScanHookTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for seeding: %v", err)
	}
	var exists bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM tenants WHERE id = $1::uuid)`,
		tenantID).Scan(&exists); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("read tenants: %v", err)
	}
	if !exists {
		if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'pii-scan-hook-test', 'pii-scan-hook-test-' || $1::text, 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed tenant: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
	// Remove it afterwards.
	//
	// This tenant has a FIXED id and its scan config leaves an ENABLED
	// tenant_pii_scan_coverage row behind. The coverage worker's reconciliation
	// is bounded (ReconcileTenants), so a permanently-enabled leftover competes
	// for that budget and made pii_scanner's backfill tests fail intermittently
	// from a completely different package. A shared database makes one test's
	// litter another test's flake.
	t.Cleanup(func() {
		bg := context.Background()
		cx, cerr := db.WithTenant(bg, pool, tenantID)
		if cerr != nil {
			return
		}
		defer func() { _ = cx.Rollback(bg) }()
		_, _ = cx.Exec(bg, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = cx.Commit(bg)
	})
}

// TestUpsert_ScansEmbeddedPII pins SUB-071's write-path hook: an Upsert that
// embeds an undeclared SSN in a free-text custom field produces a
// subscriber_pii_findings row (and the scanner does NOT run when the tenant's
// scan config is disabled).
func TestUpsert_ScansEmbeddedPII(t *testing.T) {
	pool := newPIIScanHookTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c47110"
	seedPIIScanHookTenant(t, pool, tenantID)

	scanRepo := &pii_scanner.Repo{Pool: pool}
	detector, err := pii_scanner.NewDetector([]byte("pii-scan-hook-test-fingerprint-pepper-32-bytes"), "test-v1")
	if err != nil {
		t.Fatalf("NewDetector: %v", err)
	}
	scanDeps := &pii_scanner.Deps{Repo: scanRepo, Detector: detector}

	r := &Repo{Pool: pool, PIIScanner: piiScanTestAdapter{deps: scanDeps, repo: scanRepo}}

	// 1. Explicitly disable scanning. This tenant is stable across test runs,
	// so relying on "no config row" would inherit the enabled state written by
	// an earlier uncached run and make the test order-dependent.
	disabledFlag := false
	if _, err := scanRepo.UpsertScanConfig(ctx, tenantID, pii_scanner.UpdateScanConfigInput{ScanEnabled: &disabledFlag}); err != nil {
		t.Fatalf("disable scan config: %v", err)
	}
	cleanEmail := fmt.Sprintf("pii-disabled-%d@example.test", time.Now().UnixNano())
	disabled, err := r.Upsert(ctx, tenantID, CreateInput{
		Email:        cleanEmail,
		CustomFields: map[string]any{"notes": "SSN 123-45-6789 on file"},
	})
	if err != nil {
		t.Fatalf("Upsert (scan disabled): %v", err)
	}
	if got, err := scanRepo.ListFindingsForSubscriber(ctx, tenantID, disabled.ID, pii_scanner.FindingFilter{}); err != nil {
		t.Fatalf("ListFindingsForSubscriber (disabled): %v", err)
	} else if len(got.Items) != 0 {
		t.Fatalf("scan disabled: expected 0 findings, got %d", len(got.Items))
	}

	// 2. Enable the tenant's scan config, then Upsert a subscriber with an SSN
	//    in a free-text custom field. A finding row must land.
	enabled := true
	if _, err := scanRepo.UpsertScanConfig(ctx, tenantID, pii_scanner.UpdateScanConfigInput{ScanEnabled: &enabled}); err != nil {
		t.Fatalf("enable scan config: %v", err)
	}

	email := fmt.Sprintf("pii-enabled-%d@example.test", time.Now().UnixNano())
	sub, err := r.Upsert(ctx, tenantID, CreateInput{
		Email:        email,
		CustomFields: map[string]any{"notes": "customer SSN is 123-45-6789, follow up"},
	})
	if err != nil {
		t.Fatalf("Upsert (scan enabled): %v", err)
	}

	findings, err := scanRepo.ListFindingsForSubscriber(ctx, tenantID, sub.ID, pii_scanner.FindingFilter{})
	if err != nil {
		t.Fatalf("ListFindingsForSubscriber (enabled): %v", err)
	}
	if len(findings.Items) == 0 {
		t.Fatalf("scan enabled: expected >=1 finding for embedded SSN, got 0")
	}
	var sawSSN bool
	for _, f := range findings.Items {
		if f.DetectedType == pii_scanner.TypeSSN && f.FieldName == "notes" {
			sawSSN = true
		}
	}
	if !sawSSN {
		t.Errorf("expected an ssn finding on field 'notes', got %+v", findings)
	}

	// 3. A schema-declared sensitive field is not an "undeclared" finding,
	// while an unclassified field in the same write remains detectable.
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("declared-field tenant tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenant_custom_fields (tenant_id, key, label, type, config)
VALUES ($1::uuid, 'declared_notes', 'Declared notes', 'string', '{"pii_flag":true,"data_classification":"pii"}'::jsonb)
ON CONFLICT (tenant_id, key) DO UPDATE SET config=EXCLUDED.config`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed declared field: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit declared field: %v", err)
	}
	declaredSub, err := r.Upsert(ctx, tenantID, CreateInput{
		Email: fmt.Sprintf("pii-declared-%d@example.test", time.Now().UnixNano()),
		CustomFields: map[string]any{
			"declared_notes":    "SSN 123-45-6789",
			"unclassified_note": "SSN 321-65-4321",
		},
	})
	if err != nil {
		t.Fatalf("Upsert (declared field): %v", err)
	}
	declaredPage, err := scanRepo.ListFindingsForSubscriber(ctx, tenantID, declaredSub.ID, pii_scanner.FindingFilter{})
	if err != nil {
		t.Fatalf("ListFindingsForSubscriber (declared field): %v", err)
	}
	for _, finding := range declaredPage.Items {
		if finding.FieldName == "declared_notes" {
			t.Fatalf("schema-declared PII was misclassified as undeclared: %+v", finding)
		}
	}
	var sawUnclassified bool
	for _, finding := range declaredPage.Items {
		sawUnclassified = sawUnclassified || finding.FieldName == "unclassified_note"
	}
	if !sawUnclassified {
		t.Fatalf("unclassified PII was not detected: %+v", declaredPage.Items)
	}
}
