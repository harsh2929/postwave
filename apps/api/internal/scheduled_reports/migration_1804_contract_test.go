// SPDX-License-Identifier: AGPL-3.0-only
package scheduled_reports

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestScheduledReportDeliveryReceiptMigrationContract(t *testing.T) {
	t.Parallel()

	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve source path")
	}
	path := filepath.Clean(filepath.Join(
		filepath.Dir(source),
		"../../../../infra/migrations/1804_scheduled_report_delivery_receipts.sql",
	))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sql := string(raw)
	file := migrationrunner.MigrationFile{
		Version: "1804_scheduled_report_delivery_receipts",
		Path:    path,
		SQL:     sql,
	}
	for _, finding := range migrationrunner.AssessSafety(
		[]migrationrunner.MigrationFile{file},
	) {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf(
				"migration safety blocker %q at line %d: %s",
				finding.Rule,
				finding.Line,
				finding.Snippet,
			)
		}
	}

	for _, contract := range []string{
		"migration-execution: phased",
		"scheduled_reports_tenant_id_id_uidx",
		"ADD COLUMN IF NOT EXISTS delivery_next_due_at timestamptz",
		"scheduled_reports_legacy_cursor_redirect",
		"NEW.next_due_at := NULL",
		"scheduled_reports_delivery_due_idx",
		"ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'UTC'",
		"CREATE TABLE IF NOT EXISTS scheduled_report_runs",
		"CREATE TABLE IF NOT EXISTS scheduled_report_delivery_receipts",
		"FOREIGN KEY (tenant_id, scheduled_report_id)",
		"ON DELETE SET NULL (scheduled_report_id)",
		"scheduled_report_id_snapshot uuid NOT NULL",
		"scheduled_report_runs_occurrence_uidx",
		"scheduled_report_id_snapshot,\n        occurrence_at",
		"scheduled_report_runs_manual_idempotency_uidx",
		"(tenant_id, scheduled_report_id_snapshot, idempotency_key_hash)",
		"state IN",
		"'unknown'",
		"'skipped'",
		"attempt_count BETWEEN 0 AND 1",
		"octet_length(idempotency_key_hash) = 32",
		"octet_length(recipient_hash) = 32",
		"lease_expires_at",
		"retention_until",
		"interval '90 days'",
		"scheduled_report_runs_retention_idx",
		"scheduled_report_run_snapshot_guard",
		"scheduled_report_delivery_snapshot_guard",
		"ENABLE ROW LEVEL SECURITY",
		"FORCE ROW LEVEL SECURITY",
		"scheduled_report_runs_tenant",
		"scheduled_report_runs_worker",
		"scheduled_report_delivery_receipts_tenant",
		"scheduled_report_delivery_receipts_worker",
		"current_setting('app.tenant_id', true)",
		"current_setting('app.outbox_worker', true)",
		"ON DELETE SET NULL",
		"ON DELETE CASCADE",
		"last_run_error =",
		"before durable delivery receipts were enabled",
	} {
		if !strings.Contains(sql, contract) {
			t.Errorf("migration 1804 missing contract %q", contract)
		}
	}
}

func TestWorkerSourcePinsCrashBoundaryAndTenantScope(t *testing.T) {
	t.Parallel()

	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve source path")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(source), "worker.go"))
	if err != nil {
		t.Fatal(err)
	}
	worker := string(raw)
	for _, contract := range []string{
		"recoverAmbiguousDeliveries",
		"purgeExpiredRuns",
		"state = 'unknown'",
		"No automatic retry will occur.",
		"state = 'sending'",
		"FOR UPDATE SKIP LOCKED",
		"db.WithWorkerScope",
		"db.WithTenant",
		"db.WithTenantOptions",
		"pgx.RepeatableRead",
		"pgx.ReadOnly",
		"tenant_id = $",
		"scheduled_report_runs",
		"scheduled_report_delivery_receipts",
		"computeNextDue(",
		"item.DueAt",
		"context.WithTimeout(context.Background(), 30*time.Second)",
	} {
		if !strings.Contains(worker, contract) {
			t.Errorf("worker missing crash-safety contract %q", contract)
		}
	}
	// The old unsafe sequence released a row lock and then called fire().
	for _, forbidden := range []string{
		"w.fire(",
		"to+\": \"+err.Error()",
		"strings.Join(sendErrs",
		`"err", err.Error()`,
	} {
		if strings.Contains(worker, forbidden) {
			t.Errorf("worker retained unsafe/error-leaking pattern %q", forbidden)
		}
	}
}
