// SPDX-License-Identifier: AGPL-3.0-only
//
// migration_0388_safety_test.go — runs the real migration-safety
// scanner (internal/migrationrunner/safety.go) over the real
// 0388_sms_broadcasts.sql file so the default deploy never refuses the
// pending set because of this migration. Mirrors the 0370 guard.

package sms

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestMigration0388HasNoSafetyBlockers(t *testing.T) {
	// internal/sms sits four levels below the repo root.
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations", "0388_sms_broadcasts.sql")
	sql, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 0388: %v", err)
	}

	findings := migrationrunner.AssessSafety([]migrationrunner.MigrationFile{{
		Version: "0388_sms_broadcasts",
		Path:    path,
		SQL:     string(sql),
	}})
	for _, f := range findings {
		if f.Severity == migrationrunner.SafetyBlocker {
			t.Errorf("migration 0388 must deploy without AllowUnsafe; blocker %q at line %d: %s",
				f.Rule, f.Line, f.Snippet)
		}
	}

	// Pin the historical tenant policy, and separately prove the later Route40
	// containment migration removes the caller-settable worker-GUC bypass.
	text := string(sql)
	if !strings.Contains(text, "NULLIF(current_setting('app.tenant_id', true), '')::uuid") {
		t.Error("migration 0388 must use the NULLIF tenant-GUC idiom in its RLS policy")
	}
	if !strings.Contains(text, "FORCE ROW LEVEL SECURITY") {
		t.Error("migration 0388 must FORCE row level security on sms_broadcasts")
	}
	containmentPath := filepath.Join("..", "..", "..", "..", "infra", "migrations", "1982_sms_rls_remove_caller_guc_bypass.sql")
	containment, err := os.ReadFile(containmentPath)
	if err != nil {
		t.Fatalf("read migration 1982: %v", err)
	}
	for _, policy := range []string{
		"sms_worker_campaigns", "sms_worker_recipients", "sms_worker_messages",
		"sms_worker_broadcasts", "sms_worker_sender_profiles", "sms_worker_throttle_state",
		"sms_click_redirect_lookup", "sms_click_redirect_insert",
	} {
		if !strings.Contains(string(containment), "DROP POLICY IF EXISTS "+policy) {
			t.Errorf("migration 1982 does not remove %s", policy)
		}
	}
}
