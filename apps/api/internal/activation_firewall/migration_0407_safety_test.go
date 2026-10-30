// SPDX-License-Identifier: AGPL-3.0-only
//
// migration_0407_safety_test.go — asserts the additive run-shape
// migration deploys clean (no AllowUnsafe) and pins the two additive
// changes the firewall wiring depends on: audience_sync_runs.excluded_count
// and the nullable audience_syncs.required_consent_purpose override (D3).
package activation_firewall

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestMigration0407HasNoSafetyBlockers(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations", "0407_audience_sync_runs_excluded_count.sql")
	sql, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 0407: %v", err)
	}
	findings := migrationrunner.AssessSafety([]migrationrunner.MigrationFile{{
		Version: "0407_audience_sync_runs_excluded_count",
		Path:    path,
		SQL:     string(sql),
	}})
	for _, f := range findings {
		if f.Severity == migrationrunner.SafetyBlocker {
			t.Errorf("migration 0407 must deploy without AllowUnsafe; blocker %q at line %d: %s",
				f.Rule, f.Line, f.Snippet)
		}
	}

	text := string(sql)
	// Additive column on the run ledger (the "− N excluded" surface).
	if !strings.Contains(text, "ADD COLUMN IF NOT EXISTS excluded_count integer NOT NULL DEFAULT 0") {
		t.Error("migration 0407 must add excluded_count additively to audience_sync_runs")
	}
	// Nullable per-sync purpose override (D3).
	if !strings.Contains(text, "ADD COLUMN IF NOT EXISTS required_consent_purpose text") {
		t.Error("migration 0407 must add the nullable required_consent_purpose override to audience_syncs")
	}
	// The CHECK pins it to the canonical consent.Purpose values + NULL.
	if !strings.Contains(text, "required_consent_purpose IS NULL") {
		t.Error("migration 0407 must allow NULL required_consent_purpose (use default mapping)")
	}
	if !strings.Contains(text, "'targeted_ads'") || !strings.Contains(text, "'profiling'") {
		t.Error("migration 0407 must constrain required_consent_purpose to the canonical purposes")
	}
	// Additive only — no destructive ops.
	upper := strings.ToUpper(text)
	if strings.Contains(upper, "DROP COLUMN") || strings.Contains(upper, "DROP TABLE") {
		t.Error("migration 0407 must be additive (no DROP COLUMN/TABLE)")
	}
}
