// SPDX-License-Identifier: AGPL-3.0-only

package form_variants

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestMigration1781PinsVariantRLSSemantics(t *testing.T) {
	path := filepath.Join(
		"..", "..", "..", "..", "infra", "migrations",
		"1781_form_variants_rls_semantics.sql",
	)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1781: %v", err)
	}
	sql := string(raw)
	file := migrationrunner.MigrationFile{
		Version: "1781_form_variants_rls_semantics",
		Path:    path,
		SQL:     sql,
	}
	findings := migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file})
	for _, finding := range findings {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf("migration 1781 safety blocker %q at line %d: %s",
				finding.Rule, finding.Line, finding.Snippet)
		}
	}
	for _, finding := range migrationrunner.AssessRollbackContracts(
		migrationrunner.AssessRollbackPlans([]migrationrunner.MigrationFile{file}, findings),
	) {
		if finding.Severity == migrationrunner.SafetyBlocker ||
			finding.Severity == migrationrunner.SafetyWarning {
			t.Errorf("migration 1781 rollback contract %s: %s",
				finding.Severity, finding.Message)
		}
	}

	required := []string{
		"CREATE POLICY form_variants_scope_guard ON form_variants",
		"AS RESTRICTIVE FOR ALL",
		"CREATE POLICY form_variants_tenant_access ON form_variants",
		"AS PERMISSIVE FOR ALL",
		"CREATE POLICY form_variants_public_select ON form_variants",
		"AS PERMISSIVE FOR SELECT",
		"CREATE POLICY form_variant_impressions_scope_guard ON form_variant_impressions",
		"CREATE POLICY form_variant_impressions_tenant_access ON form_variant_impressions",
		"CREATE POLICY form_variant_impressions_public_select ON form_variant_impressions",
		"CREATE POLICY form_variant_impressions_public_insert ON form_variant_impressions",
		"CREATE POLICY form_variant_impressions_public_update ON form_variant_impressions",
		"tenant_id = NULLIF(current_setting('app.public_form_tenant_id', true), '')::uuid",
		"form_id = NULLIF(current_setting('app.public_form_id', true), '')::uuid",
		"f.tenant_id = form_variants.tenant_id",
		"f.tenant_id = form_variant_impressions.tenant_id",
		"v.form_id = form_variant_impressions.form_id",
		"f.status = 'published'",
		"TO postwave_app",
		"migration-execution: transactional",
		"rollback-strategy: no-op",
		"rollback-details:",
	}
	for _, fragment := range required {
		if !strings.Contains(sql, fragment) {
			t.Errorf("migration 1781 lost required contract %q", fragment)
		}
	}

	if strings.Contains(sql, "AS RESTRICTIVE FOR SELECT") ||
		strings.Contains(sql, "AS RESTRICTIVE FOR INSERT") ||
		strings.Contains(sql, "AS RESTRICTIVE FOR UPDATE") {
		t.Fatal("operation grants must be PERMISSIVE; only the shared scope guard may be RESTRICTIVE")
	}
}

func TestVariantUpdateStatementHasSinglePredicate(t *testing.T) {
	raw, err := os.ReadFile("repo.go")
	if err != nil {
		t.Fatalf("read form variant repository: %v", err)
	}
	const duplicate = "WHERE form_id::text = $5 AND id::text = $6\n WHERE form_id::text = $5 AND id::text = $6"
	if strings.Contains(string(raw), duplicate) {
		t.Fatal("variant update contains a duplicate WHERE clause")
	}
}
