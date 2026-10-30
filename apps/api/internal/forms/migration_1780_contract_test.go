// SPDX-License-Identifier: AGPL-3.0-only

package forms

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestMigration1780PinsGlobalPublishedFormSlugs(t *testing.T) {
	path := filepath.Join(
		"..", "..", "..", "..", "infra", "migrations",
		"1780_global_published_form_slugs.sql",
	)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1780: %v", err)
	}
	sql := string(raw)
	file := migrationrunner.MigrationFile{
		Version: "1780_global_published_form_slugs",
		Path:    path,
		SQL:     sql,
	}
	findings := migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file})
	for _, finding := range findings {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf("migration 1780 safety blocker %q at line %d: %s",
				finding.Rule, finding.Line, finding.Snippet)
		}
	}
	for _, finding := range migrationrunner.AssessRollbackContracts(
		migrationrunner.AssessRollbackPlans([]migrationrunner.MigrationFile{file}, findings),
	) {
		if finding.Severity == migrationrunner.SafetyBlocker ||
			finding.Severity == migrationrunner.SafetyWarning {
			t.Errorf("migration 1780 rollback contract %s: %s",
				finding.Severity, finding.Message)
		}
	}

	required := []string{
		"PARTITION BY lower(slug::text)",
		"ORDER BY created_at, id",
		"WHERE status = 'published'",
		"SET status = 'draft'",
		"AND r.publication_rank > 1",
		"CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS forms_public_slug_uniq",
		"ON forms (lower(slug::text))",
		"WHERE status = 'published'",
		"migration-execution: phased",
		"rollback-strategy: no-op",
		"rollback-details:",
	}
	for _, fragment := range required {
		if !strings.Contains(sql, fragment) {
			t.Errorf("migration 1780 lost required contract %q", fragment)
		}
	}
	if strings.Contains(strings.ToUpper(sql), "DELETE FROM") {
		t.Fatal("migration 1780 must preserve duplicate forms by demoting, not deleting, them")
	}
	repairAt := strings.Index(sql, "UPDATE forms AS f")
	indexAt := strings.Index(sql, "CREATE UNIQUE INDEX CONCURRENTLY")
	if repairAt < 0 || indexAt < 0 || repairAt > indexAt {
		t.Fatal("idempotent duplicate repair must run before the concurrent uniqueness guard")
	}
	if strings.Contains(sql, "BEGIN;") || strings.Contains(sql, "COMMIT;") {
		t.Fatal("repair and concurrent index must remain one restartable non-transactional phase")
	}
}
