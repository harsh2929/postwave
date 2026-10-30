package warehouse

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestMigration2003IsSafeAndPinsConcurrencyInvariants(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations", "2003_warehouse_concurrency_and_streaming_cursor.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 2003: %v", err)
	}
	findings := migrationrunner.AssessSafety([]migrationrunner.MigrationFile{{
		Version: "2003_warehouse_concurrency_and_streaming_cursor", Path: path, SQL: string(raw),
	}})
	for _, finding := range findings {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf("migration 2003 must deploy without AllowUnsafe; blocker %q at line %d: %s", finding.Rule, finding.Line, finding.Snippet)
		}
	}
	sql := strings.ToLower(string(raw))
	for _, required := range []string{
		"warehouse_connections_version_positive",
		"warehouse_import_mappings_version_positive",
		"warehouse_reverse_etl_mappings_version_positive",
		"check (version > 0)",
		"cursor_from bigint not null default 0",
		"cursor_to bigint not null default 0",
		"has_more boolean not null default false",
		"check (cursor_from >= 0 and cursor_to >= cursor_from)",
		"streaming_export_runs_cursor_idx",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("migration 2003 is missing %q", required)
		}
	}
}
