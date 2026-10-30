// SPDX-License-Identifier: AGPL-3.0-only
package migrationrunner

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const migration2007Version = "2007_webhook_playground_fire_receipts"

func loadMigration2007(t *testing.T) MigrationFile {
	t.Helper()
	files, err := LoadFiles(filepath.Join("..", "..", "..", "..", "infra", "migrations"))
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		if file.Version == migration2007Version {
			return file
		}
	}
	t.Fatalf("migration %s not found", migration2007Version)
	return MigrationFile{}
}

func TestMigration2007UsesOnlineOwnershipIndexAndRollingWriterBridge(t *testing.T) {
	t.Parallel()
	target := loadMigration2007(t)
	if !strings.Contains(strings.ToLower(target.SQL), phasedExecutionDirective) {
		t.Fatal("migration 2007 must explicitly declare phased execution")
	}
	phases, err := splitMigrationPhases(splitSQLStatements(target.SQL))
	if err != nil {
		t.Fatal(err)
	}
	if len(phases) != 2 {
		t.Fatalf("migration 2007 phases = %d, want online-index plus transactional adoption", len(phases))
	}
	if phases[0].Transactional || len(phases[0].Statements) != 1 {
		t.Fatalf("migration 2007 index phase = %#v, want one non-transactional statement", phases[0])
	}
	name, _, ok, err := concurrentIndexIdentity(phases[0].Statements[0])
	if err != nil || !ok || name != "outbound_webhooks_tenant_id_id_key" {
		t.Fatalf("migration 2007 concurrent index identity name=%q ok=%v err=%v", name, ok, err)
	}
	if !phases[1].Transactional {
		t.Fatal("migration 2007 constraint adoption and compatibility trigger must be transactional")
	}
	transactional := strings.Join(phases[1].Statements, "\n")
	for _, required := range []string{
		"ADD COLUMN config_version",
		"UNIQUE USING INDEX outbound_webhooks_tenant_id_id_key",
		"IF NEW.config_version IS NOT DISTINCT FROM OLD.config_version THEN",
		"NEW.config_version := OLD.config_version + 1",
		"ELSIF NEW.config_version IS DISTINCT FROM OLD.config_version + 1 THEN",
		"SET LOCAL lock_timeout = '5s'",
	} {
		if !strings.Contains(transactional, required) {
			t.Fatalf("migration 2007 transactional phase is missing %q", required)
		}
	}
	for _, finding := range AssessSafety([]MigrationFile{target}) {
		if finding.Rule == "add-nonconcurrent-unique-constraint" {
			t.Fatalf("migration 2007 rebuilt a UNIQUE index under table lock: %+v", finding)
		}
	}
}

func TestMigration2007DeployRunbookPinsDrainRollbackAndLockResponse(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "runbooks", "deploy-procedure.md"))
	if err != nil {
		t.Fatal(err)
	}
	runbook := strings.ReplaceAll(strings.Join(strings.Fields(string(raw)), " "), "**", "")
	for _, required := range []string{
		"Migration 2007 webhook writer cutover",
		"drain every pre-2007 API and worker task",
		"Do not increase or disable `lock_timeout`",
		"Leave the 2007 schema objects in place",
		"future contract migration",
	} {
		if !strings.Contains(runbook, required) {
			t.Fatalf("migration 2007 deploy runbook is missing %q", required)
		}
	}
}
