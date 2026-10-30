// SPDX-License-Identifier: AGPL-3.0-only
package subscribers

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestMigration1768ScrubsTerminalRecoveryPayloadsWithoutDeletingAuditRows(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations", "1768_subscriber_bulk_recovery_privacy_boundary.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1768: %v", err)
	}
	file := migrationrunner.MigrationFile{
		Version: "1768_subscriber_bulk_recovery_privacy_boundary",
		Path:    path,
		SQL:     string(raw),
	}
	findings := migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file})
	for _, finding := range findings {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf("migration 1768 safety blocker %q at line %d: %s",
				finding.Rule, finding.Line, finding.Snippet)
		}
	}
	for _, finding := range migrationrunner.AssessRollbackContracts(
		migrationrunner.AssessRollbackPlans([]migrationrunner.MigrationFile{file}, findings),
	) {
		if finding.Severity == migrationrunner.SafetyBlocker ||
			finding.Severity == migrationrunner.SafetyWarning {
			t.Errorf("migration 1768 rollback contract %s: %s",
				finding.Severity, finding.Message)
		}
	}

	sql := strings.Join(strings.Fields(string(raw)), " ")
	for _, required := range []string{
		"-- rollback-strategy: no-op",
		"UPDATE public.subscriber_bulk_recovery SET subscriber_snapshot = '{}'::jsonb",
		"operation IN ('delete', 'unsubscribe')",
		"recovery_until = LEAST(recovery_until, statement_timestamp())",
		"redeemed_at = GREATEST(",
		"operation IN ('tag', 'untag') OR",
		"subscriber_snapshot = '{}'::jsonb AND redeemed_at IS NOT NULL AND recovery_until <= redeemed_at",
		"VALIDATE CONSTRAINT subscriber_bulk_recovery_operation_check",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("migration 1768 lost terminal-recovery boundary %q", required)
		}
	}
}
