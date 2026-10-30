// SPDX-License-Identifier: AGPL-3.0-only
package audience_destinations

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestMigration1775PinsAudienceOperationSafetyContract(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations", "1775_audience_sync_operation_safety.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1775: %v", err)
	}
	file := migrationrunner.MigrationFile{
		Version: "1775_audience_sync_operation_safety",
		Path:    path,
		SQL:     string(raw),
	}
	findings := migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file})
	for _, finding := range findings {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf("migration 1775 safety blocker %q at line %d: %s", finding.Rule, finding.Line, finding.Snippet)
		}
	}
	for _, finding := range migrationrunner.AssessRollbackContracts(
		migrationrunner.AssessRollbackPlans([]migrationrunner.MigrationFile{file}, findings),
	) {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf("migration 1775 rollback blocker: %s", finding.Message)
		}
	}

	sql := string(raw)
	required := []string{
		"run_lease_owner uuid",
		"run_lease_expires_at timestamptz",
		"run_lease_operation_key text",
		"sync_lease_owner uuid",
		"operation_key text",
		"source_members_observed integer NOT NULL DEFAULT 0",
		"cap_exceeded boolean NOT NULL DEFAULT false",
		"audience_sync_runs_operation_key_uidx",
		"audience_sync_jobs_operation_key_uidx",
		"audience_syncs_worker_update",
		"CREATE TABLE IF NOT EXISTS audience_sync_run_attempts",
		"CREATE TABLE IF NOT EXISTS audience_sync_job_attempts",
		"FOREIGN KEY (tenant_id, run_id)",
		"FOREIGN KEY (tenant_id, job_id)",
		"FORCE ROW LEVEL SECURITY",
		"needs_reconciliation",
		"rollback-strategy: expand-contract",
	}
	for _, fragment := range required {
		if !strings.Contains(sql, fragment) {
			t.Errorf("migration 1775 lost required contract %q", fragment)
		}
	}
	for _, forbidden := range []string{"DROP TABLE", "DROP COLUMN", "DELETE FROM", "TRUNCATE "} {
		if strings.Contains(strings.ToUpper(sql), forbidden) {
			t.Errorf("migration 1775 contains destructive contract %q", forbidden)
		}
	}
}
