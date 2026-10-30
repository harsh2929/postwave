// SPDX-License-Identifier: AGPL-3.0-only
//
// migration_0406_safety_test.go — runs the real migration-safety scanner
// over 0406_activation_exclusion_receipts.sql so the default deploy never
// refuses the pending set, and pins the RLS contract the firewall's repo
// (WriteExclusions / ListExclusions, this package) + the compliance
// list/download surfaces depend on. Mirrors the 0399 guard in
// internal/listmonk_events.
package activation_firewall

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestMigration0406HasNoSafetyBlockers(t *testing.T) {
	// internal/activation_firewall sits four levels below the repo root.
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations", "0406_activation_exclusion_receipts.sql")
	sql, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 0406: %v", err)
	}
	findings := migrationrunner.AssessSafety([]migrationrunner.MigrationFile{{
		Version: "0406_activation_exclusion_receipts",
		Path:    path,
		SQL:     string(sql),
	}})
	for _, f := range findings {
		if f.Severity == migrationrunner.SafetyBlocker {
			t.Errorf("migration 0406 must deploy without AllowUnsafe; blocker %q at line %d: %s",
				f.Rule, f.Line, f.Snippet)
		}
	}

	text := string(sql)
	// NULLIF tenant-GUC idiom (raw cast crashes on unset app.tenant_id).
	if !strings.Contains(text, "NULLIF(current_setting('app.tenant_id', true), '')::uuid") {
		t.Error("migration 0406 must use the NULLIF tenant-GUC idiom in its RLS policies")
	}
	// FORCE RLS so even the table owner is gated.
	if !strings.Contains(text, "FORCE ROW LEVEL SECURITY") && !strings.Contains(text, "FORCE  ROW LEVEL SECURITY") {
		t.Error("migration 0406 must FORCE row level security on activation_exclusion_receipts")
	}
	// Worker-select policy + the RESTRICTIVE gate that admits worker scope
	// on READ only (read-but-never-write without a bound tenant).
	if !strings.Contains(text, "current_setting('app.outbox_worker', true) = 'true'") {
		t.Error("migration 0406 must keep the app.outbox_worker worker-scope policy")
	}
	if !strings.Contains(strings.ToUpper(text), "AS RESTRICTIVE") {
		t.Error("migration 0406 must use a RESTRICTIVE gate so worker scope can read but not write without a bound tenant")
	}
	// The CHECK constraints the firewall writer + readers depend on.
	if !strings.Contains(text, "run_type IN ('audience_sync', 'zerocopy_trigger')") {
		t.Error("migration 0406 must constrain run_type to audience_sync|zerocopy_trigger")
	}
	if !strings.Contains(text, "rule_class IN ('consent', 'suppression', 'policy')") {
		t.Error("migration 0406 must constrain rule_class to consent|suppression|policy")
	}
	// The signature column carries the per-row tamper-evidence.
	if !strings.Contains(text, "signature") {
		t.Error("migration 0406 must declare the signature column")
	}
}
