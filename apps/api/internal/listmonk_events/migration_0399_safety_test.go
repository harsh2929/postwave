// SPDX-License-Identifier: AGPL-3.0-only
//
// migration_0399_safety_test.go — runs the real migration-safety scanner
// over 0399_sequence_enrollments.sql so the default deploy never refuses
// the pending set, and pins the RLS contract the goal-completion writer
// (recordSequenceGoalCompletion, this package) + the goal-progress reader
// + the external dispatcher's exit_on_goal lookup all depend on. Mirrors
// the 0388 guard in internal/sms.

package listmonk_events

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestMigration0399HasNoSafetyBlockers(t *testing.T) {
	// internal/listmonk_events sits four levels below the repo root
	// (apps/api/internal/listmonk_events).
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations", "0399_sequence_enrollments.sql")
	sql, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 0399: %v", err)
	}
	findings := migrationrunner.AssessSafety([]migrationrunner.MigrationFile{{
		Version: "0399_sequence_enrollments",
		Path:    path,
		SQL:     string(sql),
	}})
	for _, f := range findings {
		if f.Severity == migrationrunner.SafetyBlocker {
			t.Errorf("migration 0399 must deploy without AllowUnsafe; blocker %q at line %d: %s",
				f.Rule, f.Line, f.Snippet)
		}
	}

	text := string(sql)
	// The NULLIF tenant-GUC idiom (a raw cast crashes on an unset
	// app.tenant_id — the RLS-dead-worker bug the rules warn against).
	if !strings.Contains(text, "NULLIF(current_setting('app.tenant_id', true), '')::uuid") {
		t.Error("migration 0399 must use the NULLIF tenant-GUC idiom in its RLS policies")
	}
	// FORCE RLS so even the table owner is gated.
	if !strings.Contains(text, "FORCE  ROW LEVEL SECURITY") && !strings.Contains(text, "FORCE ROW LEVEL SECURITY") {
		t.Error("migration 0399 must FORCE row level security on sequence_enrollments")
	}
	// The worker-select policy the cross-tenant enumeration relies on,
	// and the RESTRICTIVE gate that admits worker scope on READ only.
	if !strings.Contains(text, "current_setting('app.outbox_worker', true) = 'true'") {
		t.Error("migration 0399 must keep the app.outbox_worker worker-scope policy")
	}
	if !strings.Contains(strings.ToUpper(text), "AS RESTRICTIVE") {
		t.Error("migration 0399 must use a RESTRICTIVE gate so worker scope can read but not write without a bound tenant")
	}
	// The unique key the goal-completion upsert + dispatcher lookup use.
	if !strings.Contains(text, "UNIQUE (tenant_id, sequence_id, subscriber_email)") {
		t.Error("migration 0399 must declare the (tenant_id, sequence_id, subscriber_email) unique key")
	}
}
