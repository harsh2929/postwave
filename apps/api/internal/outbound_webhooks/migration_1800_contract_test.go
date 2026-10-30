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

func TestOutboundWebhookScopeIntegrityMigrationContract(t *testing.T) {
	t.Parallel()

	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	path := filepath.Clean(filepath.Join(
		filepath.Dir(source),
		"../../../../infra/migrations/1800_outbound_webhook_scope_integrity.sql",
	))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sql := string(raw)
	file := migrationrunner.MigrationFile{
		Version: "1800_outbound_webhook_scope_integrity",
		Path:    path,
		SQL:     sql,
	}
	for _, finding := range migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file}) {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf(
				"migration 1800 safety blocker %q at line %d: %s",
				finding.Rule,
				finding.Line,
				finding.Snippet,
			)
		}
	}
	for _, contract := range []string{
		"CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS list_id_map_tenant_postwave_uuid_uidx",
		"FOREIGN KEY (tenant_id, list_id)",
		"REFERENCES list_id_map (tenant_id, postwave_uuid)",
		"VALIDATE CONSTRAINT outbound_webhooks_tenant_list_fkey",
		"char_length(description) <= 512",
		"VALIDATE CONSTRAINT outbound_webhooks_description_length_check",
	} {
		if !strings.Contains(sql, contract) {
			t.Errorf("migration 1800 missing contract %q", contract)
		}
	}
}
