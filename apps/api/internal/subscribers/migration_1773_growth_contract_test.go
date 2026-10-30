// SPDX-License-Identifier: AGPL-3.0-only
package subscribers

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestMigration1773IsolatesVerifiedGrowthFromLegacyWriters(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations", "1773_subscriber_growth_verified_history.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1773: %v", err)
	}
	file := migrationrunner.MigrationFile{
		Version: "1773_subscriber_growth_verified_history",
		Path:    path,
		SQL:     string(raw),
	}
	findings := migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file})
	for _, finding := range findings {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf("migration 1773 safety blocker %q at line %d: %s",
				finding.Rule, finding.Line, finding.Snippet)
		}
	}
	for _, finding := range migrationrunner.AssessRollbackContracts(
		migrationrunner.AssessRollbackPlans([]migrationrunner.MigrationFile{file}, findings),
	) {
		if finding.Severity == migrationrunner.SafetyBlocker ||
			finding.Severity == migrationrunner.SafetyWarning {
			t.Errorf("migration 1773 rollback contract %s: %s",
				finding.Severity, finding.Message)
		}
	}

	sql := strings.Join(strings.Fields(string(raw)), " ")
	for _, required := range []string{
		"-- rollback-strategy: no-op",
		"ADD COLUMN metric_contract_version text NOT NULL DEFAULT 'legacy-heuristic-v1'",
		"CHECK (metric_contract_version = 'legacy-heuristic-v1') NOT VALID",
		"VALIDATE CONSTRAINT subscriber_growth_history_metric_contract_check",
		"CREATE TABLE public.subscriber_growth_verified_history",
		"REFERENCES public.tenants(id) ON DELETE CASCADE",
		"CHECK (metric_contract_version = 'verified-exact-ledger-v2')",
		"CHECK (snapshot_date = (evaluated_at AT TIME ZONE 'UTC')::date)",
		"CHECK (lapsed_count = 0)",
		"ALTER TABLE public.subscriber_growth_verified_history ENABLE ROW LEVEL SECURITY",
		"ALTER TABLE public.subscriber_growth_verified_history FORCE ROW LEVEL SECURITY",
		"AS RESTRICTIVE FOR ALL TO postwave_app",
		"AS PERMISSIVE FOR ALL TO postwave_app",
		"GRANT SELECT, INSERT, UPDATE ON TABLE public.subscriber_growth_verified_history TO postwave_app",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("migration 1773 lost verified-growth boundary %q", required)
		}
	}

	for _, forbidden := range []string{
		"ALTER COLUMN metric_contract_version SET DEFAULT 'verified-exact-ledger-v2'",
		"UPDATE public.subscriber_growth_history SET metric_contract_version",
		"INSERT INTO public.subscriber_growth_verified_history SELECT",
		"GRANT DELETE ON TABLE public.subscriber_growth_verified_history",
		"USING (true)",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("migration 1773 retained unsafe rolling-deploy behavior %q", forbidden)
		}
	}
}
