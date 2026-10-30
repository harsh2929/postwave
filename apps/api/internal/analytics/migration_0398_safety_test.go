// SPDX-License-Identifier: AGPL-3.0-only
//
// migration_0398_safety_test.go — runs the real migration-safety scanner
// over 0398_sequence_funnel_variant_key.sql so the default deploy never
// refuses the pending set because of this migration, and pins the
// additive (no-data-loss) shape the per-variant funnel aggregation relies
// on. Mirrors the 0388 guard in internal/sms.

package analytics

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestMigration0398HasNoSafetyBlockers(t *testing.T) {
	// internal/analytics sits four levels below the repo root
	// (apps/api/internal/analytics).
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations", "0398_sequence_funnel_variant_key.sql")
	sql, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 0398: %v", err)
	}
	findings := migrationrunner.AssessSafety([]migrationrunner.MigrationFile{{
		Version: "0398_sequence_funnel_variant_key",
		Path:    path,
		SQL:     string(sql),
	}})
	for _, f := range findings {
		if f.Severity == migrationrunner.SafetyBlocker {
			t.Errorf("migration 0398 must deploy without AllowUnsafe; blocker %q at line %d: %s",
				f.Rule, f.Line, f.Snippet)
		}
	}

	text := string(sql)
	// Additive column the aggregation prefers when present.
	if !strings.Contains(text, "ADD COLUMN IF NOT EXISTS variant_key text") {
		t.Error("migration 0398 must add a nullable variant_key text column")
	}
	// Must NOT drop/alter existing data — additive only.
	if strings.Contains(strings.ToUpper(text), "DROP COLUMN") || strings.Contains(strings.ToUpper(text), "DROP TABLE") {
		t.Error("migration 0398 must be additive (no DROP)")
	}
}
