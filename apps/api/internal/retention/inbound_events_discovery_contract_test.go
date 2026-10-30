// SPDX-License-Identifier: AGPL-3.0-only

package retention

import (
	"os"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestInboundEventTenantDiscoveryUsesTransactionLocalWorkerScope(t *testing.T) {
	raw, err := os.ReadFile("raw_payloads.go")
	if err != nil {
		t.Fatalf("read raw_payloads.go: %v", err)
	}
	source := string(raw)

	required := []string{
		"db.WithWorkerScope(ctx, s.Pool)",
		"SELECT set_config('app.tenant_id', $1, true)",
		"workerNoTenantID",
		"rows, err := tx.Query(ctx, `",
		"SELECT DISTINCT tenant_id::text FROM inbound_events",
		"defer func() { _ = tx.Rollback(ctx) }()",
	}
	for _, fragment := range required {
		if !strings.Contains(source, fragment) {
			t.Errorf("retention discovery lost required worker-scope contract %q", fragment)
		}
	}
	if strings.Contains(source, "rows, err := s.Pool.Query(ctx, `\nSELECT DISTINCT tenant_id::text FROM bounce_events") {
		t.Fatal("tenant discovery regressed to an unscoped pooled query")
	}
}

func TestMigration1787PinsInboundEventWorkerReadOnlyPolicy(t *testing.T) {
	const path = "../../../../infra/migrations/1787_inbound_events_retention_worker_discovery.sql"
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1787: %v", err)
	}
	sql := string(raw)
	file := migrationrunner.MigrationFile{
		Version: "1787_inbound_events_retention_worker_discovery",
		Path:    path,
		SQL:     sql,
	}
	findings := migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file})
	for _, finding := range findings {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf("migration 1787 safety blocker %q at line %d: %s",
				finding.Rule, finding.Line, finding.Snippet)
		}
	}
	for _, finding := range migrationrunner.AssessRollbackContracts(
		migrationrunner.AssessRollbackPlans([]migrationrunner.MigrationFile{file}, findings),
	) {
		if finding.Severity == migrationrunner.SafetyBlocker ||
			finding.Severity == migrationrunner.SafetyWarning {
			t.Errorf("migration 1787 rollback contract %s: %s",
				finding.Severity, finding.Message)
		}
	}

	required := []string{
		"ALTER POLICY tenant_isolation ON inbound_events",
		"NULLIF(current_setting('app.tenant_id', true), '')::uuid",
		"COALESCE(current_setting('app.outbox_worker', true), '') = 'true'",
		"CREATE POLICY inbound_events_retention_worker_select ON inbound_events",
		"AS PERMISSIVE",
		"FOR SELECT",
		"TO postwave_app",
	}
	for _, fragment := range required {
		if !strings.Contains(sql, fragment) {
			t.Errorf("migration 1787 lost required contract %q", fragment)
		}
	}

	policyStart := strings.Index(sql, "CREATE POLICY inbound_events_retention_worker_select")
	if policyStart < 0 {
		t.Fatal("worker policy not found")
	}
	workerPolicy := sql[policyStart:]
	for _, forbidden := range []string{"FOR ALL", "FOR INSERT", "FOR UPDATE", "FOR DELETE", "WITH CHECK"} {
		if strings.Contains(workerPolicy, forbidden) {
			t.Errorf("worker policy must remain SELECT-only; found %q", forbidden)
		}
	}
}
