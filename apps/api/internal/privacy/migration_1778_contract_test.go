// SPDX-License-Identifier: AGPL-3.0-only

package privacy

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestMigration1778GrantsOnlyDSARErasureColumns(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations", "1778_dsar_erasure_update_permissions.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1778: %v", err)
	}
	sql := string(raw)

	for _, want := range []string{
		"GRANT UPDATE (subscriber_email, user_agent, ip)\n    ON subscriber_events TO postwave_app",
		"GRANT UPDATE (subscriber_email, ip)\n    ON consent_receipts TO postwave_app",
	} {
		if !strings.Contains(sql, want) {
			t.Fatalf("migration 1778 missing least-privilege grant %q", want)
		}
	}
	upper := strings.ToUpper(sql)
	if strings.Contains(upper, "GRANT UPDATE ON") || strings.Contains(upper, "GRANT DELETE") ||
		strings.Contains(sql, "app.outbox_worker") {
		t.Fatal("migration 1778 must not grant table-wide mutation or cross-tenant worker bypass")
	}

	findings := migrationrunner.AssessSafety([]migrationrunner.MigrationFile{{
		Version: "1778_dsar_erasure_update_permissions",
		Path:    path,
		SQL:     sql,
	}})
	for _, finding := range findings {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf("migration 1778 safety blocker %q at line %d: %s", finding.Rule, finding.Line, finding.Snippet)
		}
	}
}
