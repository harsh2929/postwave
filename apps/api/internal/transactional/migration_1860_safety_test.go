package transactional

// Safety guard for migration 1860 (transactional intent lifecycle), matching
// the convention already used for 1859/1780/1778/1775/1772/1771/1734/1715.
// An adversarial review noted 1860 shipped without one.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

const migration1860 = "1860_transactional_intent_lifecycle"

func TestMigration1860HasNoSafetyBlockers(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations", migration1860+".sql")
	sql, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1860: %v", err)
	}
	findings := migrationrunner.AssessSafety([]migrationrunner.MigrationFile{{
		Version: migration1860, Path: path, SQL: string(sql),
	}})
	for _, f := range findings {
		if f.Severity == migrationrunner.SafetyBlocker {
			t.Errorf("migration 1860 must deploy without AllowUnsafe; blocker %q at line %d: %s",
				f.Rule, f.Line, f.Snippet)
		}
	}
}

func TestMigration1860KeepsTheLedgerContractIntact(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations", migration1860+".sql")
	sql, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1860: %v", err)
	}
	body := string(sql)
	for _, want := range []string{
		// The uniqueness the whole mechanism rests on.
		"CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS transactional_emails_intent_key_idx",
		"WHERE intent_key IS NOT NULL",
		// The distinction between "did not happen" and "we cannot tell".
		"'prepared', 'submitted', 'acknowledged', 'rejected', 'unknown'",
		"'none', 'partial', 'full', 'unknown'",
		// Locks kept short on a live send ledger.
		"NOT VALID",
		"VALIDATE CONSTRAINT",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("migration 1860 is missing %q", want)
		}
	}
	// `status` is in the OpenAPI contract and six SDKs. The duplicate is fixed
	// by the claim predicate, not by renaming what callers already read.
	if strings.Contains(body, "DROP COLUMN status") || strings.Contains(body, "RENAME COLUMN status") {
		t.Error("migration 1860 must not change the `status` column: it is public contract")
	}
}
