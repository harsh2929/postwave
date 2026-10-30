// SPDX-License-Identifier: AGPL-3.0-only

package merge_fields

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestMigration1756IsAdditivePhasedAndFullyValidated(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations", "1756_merge_field_schema_contracts.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1756: %v", err)
	}
	sql := string(raw)
	upper := strings.ToUpper(sql)
	for _, required := range []string{
		"MIGRATION-EXECUTION: PHASED",
		"ROLLBACK-STRATEGY: NO-OP",
		"SET LOCAL LOCK_TIMEOUT = '5S'",
		"SET LOCK_TIMEOUT = '5S'",
		"RESET LOCK_TIMEOUT",
		"MERGE_FIELD_SCHEMA_KEY_CONTRACT_CHECK",
		"MERGE_FIELD_SCHEMA_LABEL_CONTRACT_CHECK",
		"MERGE_FIELD_SCHEMA_POSITION_CONTRACT_CHECK",
		"MERGE_FIELD_SCHEMA_DEFAULT_CONTRACT_CHECK",
		"MERGE_FIELD_VALUES_VALUE_CONTRACT_CHECK",
		"NOT VALID",
		"VALIDATE CONSTRAINT MERGE_FIELD_SCHEMA_KEY_CONTRACT_CHECK",
		"VALIDATE CONSTRAINT MERGE_FIELD_SCHEMA_LABEL_CONTRACT_CHECK",
		"VALIDATE CONSTRAINT MERGE_FIELD_SCHEMA_POSITION_CONTRACT_CHECK",
		"VALIDATE CONSTRAINT MERGE_FIELD_SCHEMA_DEFAULT_CONTRACT_CHECK",
		"VALIDATE CONSTRAINT MERGE_FIELD_VALUES_VALUE_CONTRACT_CHECK",
	} {
		if !strings.Contains(upper, required) {
			t.Errorf("migration 1756 missing %q", required)
		}
	}
	if strings.Contains(upper, "DROP CONSTRAINT") || strings.Contains(upper, "DROP TABLE") || strings.Contains(upper, "DELETE FROM") {
		t.Fatal("migration 1756 must remain additive and non-destructive")
	}

	file := migrationrunner.MigrationFile{
		Version: "1756_merge_field_schema_contracts",
		Path:    path,
		SQL:     sql,
	}
	findings := migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file})
	for _, finding := range findings {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf("migration 1756 safety blocker %q at line %d: %s", finding.Rule, finding.Line, finding.Snippet)
		}
	}
	plans := migrationrunner.AssessRollbackPlans([]migrationrunner.MigrationFile{file}, findings)
	if len(plans) != 1 || !plans[0].Explicit || plans[0].Strategy != migrationrunner.RollbackStrategyNoOp || plans[0].Details == "" {
		t.Fatalf("migration 1756 rollback plan = %+v; want explicit documented no-op", plans)
	}
	for _, finding := range migrationrunner.AssessRollbackContracts(plans) {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf("migration 1756 rollback blocker %q: %s", finding.Rule, finding.Message)
		}
	}
}
