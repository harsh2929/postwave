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

func TestMigration1788IdentityAndResumeContract(t *testing.T) {
	t.Parallel()

	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	path := filepath.Clean(filepath.Join(
		filepath.Dir(source),
		"../../../../infra/migrations/1788_outbound_webhook_source_event_idempotency.sql",
	))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1788: %v", err)
	}
	sql := string(raw)
	upper := strings.ToUpper(sql)

	file := migrationrunner.MigrationFile{
		Version: "1788_outbound_webhook_source_event_idempotency",
		Path:    path,
		SQL:     sql,
	}
	for _, finding := range migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file}) {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf(
				"migration 1788 safety blocker %q at line %d: %s",
				finding.Rule,
				finding.Line,
				finding.Snippet,
			)
		}
	}

	for _, contract := range []string{
		"ADD COLUMN IF NOT EXISTS source_event_id uuid",
		"CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS outbound_webhook_deliveries_source_event_uidx_v2",
		"(tenant_id, webhook_id, source_event_id)",
		"WHERE source_event_id IS NOT NULL",
		"AND parent_delivery_id IS NULL",
		"PRIMARY KEY (tenant_id, source_event_id)",
		"CHECK (octet_length(payload_sha256) = 32)",
		"ALTER TABLE outbound_webhook_event_receipts FORCE ROW LEVEL SECURITY",
		"CREATE POLICY outbound_webhook_event_receipts_tenant_select",
		"AS PERMISSIVE FOR SELECT",
		"CREATE POLICY outbound_webhook_event_receipts_tenant_insert",
		"AS PERMISSIVE FOR INSERT",
		"CREATE POLICY outbound_webhook_event_receipts_retention_delete",
		"AS PERMISSIVE FOR DELETE",
		"current_setting('app.retention_worker', true) = 'true'",
	} {
		if !strings.Contains(sql, contract) {
			t.Errorf("migration 1788 missing identity contract %q", contract)
		}
	}

	receiptBlockStart := strings.Index(upper, "BEGIN;")
	receiptBlockEnd := strings.Index(upper, "COMMIT;")
	uniqueIndexAt := strings.Index(
		upper,
		"CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS OUTBOUND_WEBHOOK_DELIVERIES_SOURCE_EVENT_UIDX_V2",
	)
	finalIndexAt := strings.Index(
		upper,
		"CREATE INDEX CONCURRENTLY IF NOT EXISTS OUTBOUND_WEBHOOK_EVENT_RECEIPTS_TIME_IDX",
	)
	if receiptBlockStart < 0 || receiptBlockEnd <= receiptBlockStart {
		t.Fatal("receipt table and policy must be one explicit transactional phase")
	}
	if uniqueIndexAt < 0 || uniqueIndexAt >= receiptBlockStart {
		t.Fatal("delivery unique index must be a resumable concurrent phase before receipt DDL")
	}
	if finalIndexAt <= receiptBlockEnd {
		t.Fatal("receipt time index must be a resumable concurrent phase after receipt DDL commits")
	}

	receiptBlock := upper[receiptBlockStart:receiptBlockEnd]
	for _, policy := range []string{
		"OUTBOUND_WEBHOOK_EVENT_RECEIPTS_TENANT_SELECT",
		"OUTBOUND_WEBHOOK_EVENT_RECEIPTS_TENANT_INSERT",
		"OUTBOUND_WEBHOOK_EVENT_RECEIPTS_RETENTION_DELETE",
	} {
		dropPolicyAt := strings.Index(receiptBlock, "DROP POLICY IF EXISTS "+policy)
		createPolicyAt := strings.Index(receiptBlock, "CREATE POLICY "+policy)
		if dropPolicyAt < 0 || createPolicyAt <= dropPolicyAt {
			t.Errorf("receipt policy %s must be dropped idempotently before recreation", policy)
		}
	}
	if strings.Contains(receiptBlock, "INDEX CONCURRENTLY") {
		t.Fatal("receipt transactional phase contains concurrent index DDL")
	}
}
