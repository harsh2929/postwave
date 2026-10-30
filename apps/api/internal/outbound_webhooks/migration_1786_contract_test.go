// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestMigration1786KeepsReplayLineageStableAfterParentRetention(t *testing.T) {
	t.Parallel()

	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	path := filepath.Clean(filepath.Join(
		filepath.Dir(source),
		"../../../../infra/migrations/1786_outbound_webhook_replay_lineage.sql",
	))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1786: %v", err)
	}
	sql := string(raw)
	var ddlLines []string
	for _, line := range strings.Split(sql, "\n") {
		if !strings.HasPrefix(strings.TrimSpace(line), "--") {
			ddlLines = append(ddlLines, line)
		}
	}
	ddlUpper := strings.ToUpper(strings.Join(ddlLines, "\n"))

	file := migrationrunner.MigrationFile{
		Version: "1786_outbound_webhook_replay_lineage",
		Path:    path,
		SQL:     sql,
	}
	for _, finding := range migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file}) {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf(
				"migration 1786 safety blocker %q at line %d: %s",
				finding.Rule,
				finding.Line,
				finding.Snippet,
			)
		}
	}

	for _, contract := range []string{
		"ADD COLUMN IF NOT EXISTS parent_delivery_id uuid",
		"DROP CONSTRAINT IF EXISTS outbound_webhook_deliveries_parent_delivery_id_fkey",
		"CREATE INDEX IF NOT EXISTS outbound_webhook_deliveries_parent_idx",
		"(tenant_id, parent_delivery_id)",
		"WHERE parent_delivery_id IS NOT NULL",
	} {
		if !strings.Contains(sql, contract) {
			t.Errorf("migration 1786 missing lineage contract %q", contract)
		}
	}
	if strings.Contains(ddlUpper, "REFERENCES OUTBOUND_WEBHOOK_DELIVERIES") {
		t.Error("replay lineage must not use a self-FK that mutates children when a parent ages out")
	}
	if strings.Contains(ddlUpper, "ON DELETE SET NULL") {
		t.Error("replay lineage DDL must not null child lineage during parent retention")
	}
}
