package zerocopy_triggers

// Regression guard for migration 1859 (zero-copy durable receipts).
//
// The first draft deduplicated the fires table in-migration with a DELETE.
// `internal/migrationrunner/safety.go` classifies `DELETE FROM` as a
// SafetyBlocker, and `cmd/migrate` exits 5 without --allow-unsafe — so the
// default deploy would have refused the ENTIRE pending set, not just 1859. The
// migration now REFUSES (RAISE EXCEPTION) when duplicates exist and leaves
// cleanup to an audited job, which is what the safety rule prescribes.
//
// An adversarial review found this; the repo already had this test pattern for
// migrations 0370, 0399, 1778 and 1780, and 1859 simply did not have one.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

const migration1859 = "1859_zerocopy_trigger_durable_receipts"

func TestMigration1859HasNoSafetyBlockers(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations", migration1859+".sql")
	sql, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1859: %v", err)
	}

	findings := migrationrunner.AssessSafety([]migrationrunner.MigrationFile{{
		Version: migration1859,
		Path:    path,
		SQL:     string(sql),
	}})

	for _, f := range findings {
		if f.Severity == migrationrunner.SafetyBlocker {
			t.Errorf("migration 1859 must deploy without AllowUnsafe; blocker %q at line %d: %s",
				f.Rule, f.Line, f.Snippet)
		}
	}
}

// The receipt's whole purpose is uniqueness, so the index it depends on must
// actually be in the file — and it must be CONCURRENTLY, because a plain
// CREATE INDEX holds a write lock for the length of the build.
func TestMigration1859CreatesTheReceiptIndexConcurrently(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations", migration1859+".sql")
	sql, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1859: %v", err)
	}
	body := string(sql)
	for _, want := range []string{
		"CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS external_warehouse_trigger_fires_receipt_idx",
		"md5(cursor_value), md5(profile_key)",
		"'claimed', 'enqueueing'",
		"NOT VALID",
		"VALIDATE CONSTRAINT",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("migration 1859 is missing %q", want)
		}
	}
	// Statements only. The header explains WHY the DELETE was removed, and a
	// naive whole-file scan flags its own explanation — the linter itself
	// assesses per flushed statement, so this must too.
	var statements strings.Builder
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "--") {
			continue
		}
		statements.WriteString(line)
		statements.WriteString("\n")
	}
	if strings.Contains(strings.ToUpper(statements.String()), "DELETE FROM") {
		t.Error("migration 1859 must not DELETE: the fires table is the ledger linking warehouse rows to the runs they produced")
	}
}
