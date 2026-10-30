package sms

// Regression guard for the desktop-audit follow-up on migration 0370
// (sms_keyword_responses normalization): the migration originally
// contained DELETE FROM statements, which the migration-safety scanner
// (internal/migrationrunner/safety.go) classifies as a SafetyBlocker —
// the default deploy then refuses the ENTIRE pending set, not just
// 0370. The migration was reworked to neutralize legacy rows with
// UPDATEs (disable + tombstone-rename) instead of deleting them. This
// test pins that contract by running the real scanner over the real
// migration file.

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestMigration0370HasNoSafetyBlockers(t *testing.T) {
	// internal/sms sits four levels below the repo root.
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations", "0370_sms_keyword_responses.sql")
	sql, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 0370: %v", err)
	}

	findings := migrationrunner.AssessSafety([]migrationrunner.MigrationFile{{
		Version: "0370_sms_keyword_responses",
		Path:    path,
		SQL:     string(sql),
	}})

	for _, f := range findings {
		if f.Severity == migrationrunner.SafetyBlocker {
			t.Errorf("migration 0370 must deploy without AllowUnsafe; blocker %q at line %d: %s",
				f.Rule, f.Line, f.Snippet)
		}
	}

	// Belt and braces: the specific rule that used to fire. A DELETE
	// reintroduced inside a DO $$ block or multi-line statement still
	// trips the scanner (it matches per flushed statement), but assert
	// the rule by name so a regression reads clearly.
	for _, f := range findings {
		if f.Rule == "delete-from" {
			t.Errorf("migration 0370 reintroduced DELETE FROM at line %d: %s", f.Line, f.Snippet)
		}
	}
}
