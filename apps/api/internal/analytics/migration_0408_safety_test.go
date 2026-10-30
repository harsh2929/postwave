// SPDX-License-Identifier: AGPL-3.0-only
//
// migration_0408_safety_test.go — runs the real migration-safety scanner
// over 0408_engagement_panel_idx.sql so the default deploy never refuses
// the pending set because of this migration, and pins the additive,
// index-only shape the open-decoupled conversion count relies on. Mirrors
// the 0398 guard in this package.
package analytics

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestMigration0408HasNoSafetyBlockers(t *testing.T) {
	// internal/analytics sits four levels below the repo root
	// (apps/api/internal/analytics).
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations", "0408_engagement_panel_idx.sql")
	sql, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 0408: %v", err)
	}
	findings := migrationrunner.AssessSafety([]migrationrunner.MigrationFile{{
		Version: "0408_engagement_panel_idx",
		Path:    path,
		SQL:     string(sql),
	}})
	for _, f := range findings {
		if f.Severity == migrationrunner.SafetyBlocker {
			t.Errorf("migration 0408 must deploy without AllowUnsafe; blocker %q at line %d: %s",
				f.Rule, f.Line, f.Snippet)
		}
	}

	text := string(sql)
	up := strings.ToUpper(text)

	// Additive, idempotent index-only migration: the partial index the
	// panel's open-decoupled count needs.
	if !strings.Contains(up, "CONVERSIONS_ENGAGEMENT_PANEL_IDX") {
		t.Error("migration 0408 must create conversions_engagement_panel_idx")
	}
	if !strings.Contains(up, "IF NOT EXISTS") {
		t.Error("migration 0408 must be idempotent (IF NOT EXISTS)")
	}
	// conversions is an existing, write-hot, non-allowlisted table, so the
	// index MUST be built CONCURRENTLY (enforced by scripts/lint-migrations.sh)
	// and therefore must NOT be wrapped in BEGIN/COMMIT (CONCURRENTLY
	// cannot run inside a transaction).
	if !strings.Contains(up, "CREATE INDEX CONCURRENTLY") {
		t.Error("migration 0408 must build the index CONCURRENTLY on the existing conversions table")
	}
	if strings.Contains(up, "BEGIN;") || strings.Contains(up, "COMMIT;") {
		t.Error("migration 0408 must NOT use BEGIN/COMMIT (CONCURRENTLY cannot run in a transaction)")
	}
	// No new table → no new RLS policy required (NULLIF idiom not needed).
	if strings.Contains(up, "CREATE TABLE") {
		t.Error("migration 0408 must NOT create a new table (index-only, additive)")
	}
	if strings.Contains(up, "CREATE POLICY") {
		t.Error("migration 0408 must NOT create a new RLS policy")
	}
	// Must not be a unique index (would be a rollback-risky warning) and
	// must be additive (no DROP).
	if strings.Contains(up, "CREATE UNIQUE INDEX") {
		t.Error("migration 0408 must use a plain (non-unique) index")
	}
	if strings.Contains(up, "DROP ") {
		t.Error("migration 0408 must be additive (no DROP)")
	}
}
