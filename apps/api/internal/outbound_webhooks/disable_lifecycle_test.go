// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestOutboundDisableLifecycleMigrationContract(t *testing.T) {
	t.Parallel()

	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	path := filepath.Clean(filepath.Join(
		filepath.Dir(source),
		"../../../../infra/migrations/1795_outbound_webhook_disable_lifecycle.sql",
	))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1795: %v", err)
	}
	sql := string(raw)
	file := migrationrunner.MigrationFile{
		Version: "1795_outbound_webhook_disable_lifecycle",
		Path:    path,
		SQL:     sql,
	}
	for _, finding := range migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file}) {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf(
				"migration 1795 safety blocker %q at line %d: %s",
				finding.Rule,
				finding.Line,
				finding.Snippet,
			)
		}
	}
	for _, contract := range []string{
		"ADD COLUMN IF NOT EXISTS disabled_reason text",
		"ADD COLUMN IF NOT EXISTS disabled_paused_at timestamptz",
		"outbound_webhooks_disabled_reason_check",
		"'auto_failures'",
		"outbound_webhook_deliveries_disabled_paused_idx",
		"postwave_pause_delivery_for_inactive_webhook",
		"outbound_webhook_delivery_inactive_pause",
	} {
		if !strings.Contains(sql, contract) {
			t.Errorf("migration 1795 missing contract %q", contract)
		}
	}
}

func TestOutboundOperatorNotificationOutboxMigrationContract(t *testing.T) {
	t.Parallel()

	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	path := filepath.Clean(filepath.Join(
		filepath.Dir(source),
		"../../../../infra/migrations/1798_outbound_webhook_operator_notification_outbox.sql",
	))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1798: %v", err)
	}
	sql := string(raw)
	file := migrationrunner.MigrationFile{
		Version: "1798_outbound_webhook_operator_notification_outbox",
		Path:    path,
		SQL:     sql,
	}
	for _, finding := range migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file}) {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf(
				"migration 1798 safety blocker %q at line %d: %s",
				finding.Rule,
				finding.Line,
				finding.Snippet,
			)
		}
	}
	for _, contract := range []string{
		"CREATE TABLE IF NOT EXISTS outbound_webhook_operator_notifications",
		"outbound_webhook_operator_notifications_due_idx",
		"current_setting('app.outbox_worker', true) = 'true'",
		"contains no receiver URL or recipient email",
	} {
		if !strings.Contains(sql, contract) {
			t.Errorf("migration 1798 missing contract %q", contract)
		}
	}
}

func TestOutboundDisableLifecycleSourceContracts(t *testing.T) {
	t.Parallel()

	storeRaw, err := os.ReadFile("store.go")
	if err != nil {
		t.Fatalf("read store: %v", err)
	}
	store := string(storeRaw)
	for _, contract := range []string{
		"AND parent.active = true",
		"disabled_paused_at = COALESCE(disabled_paused_at, now())",
		"disabled_reason = 'auto_failures'",
		"newCount >= AutoDisableThreshold",
		"CASE WHEN active THEN 0 ELSE consecutive_failures END",
		"lease_owner = $4 AND lease_expires_at > now()",
		"lease_owner = $7 AND lease_expires_at > now()",
		"return ErrLeaseLost",
		"INSERT INTO outbound_webhook_operator_notifications",
	} {
		if !strings.Contains(store, contract) {
			t.Errorf("disable/lease lifecycle missing contract %q", contract)
		}
	}

	notificationWorkerRaw, err := os.ReadFile("operator_notification_worker.go")
	if err != nil {
		t.Fatalf("read notification worker: %v", err)
	}
	notificationWorker := string(notificationWorkerRaw)
	for _, contract := range []string{
		"db.WithWorkerScope(ctx, w.Pool)",
		"FOR UPDATE SKIP LOCKED",
		"maxOperatorNotificationAttempts",
		"lease_owner = $2",
		"outbound_webhook_operator_notification_sent_total",
		"outbound_webhook_operator_notification_exhausted_total",
	} {
		if !strings.Contains(notificationWorker, contract) {
			t.Errorf("operator notification worker missing contract %q", contract)
		}
	}

	operationsRaw, err := os.ReadFile("operations.go")
	if err != nil {
		t.Fatalf("read operations: %v", err)
	}
	operations := string(operationsRaw)
	for _, contract := range []string{
		"outbound_webhook_exhausted_total",
		"outbound_webhook_lease_acquired_total",
		"COALESCE(preference.notify_auto_disabled, true) = true",
		"Queued deliveries are safely paused",
	} {
		if !strings.Contains(operations, contract) {
			t.Errorf("operations wiring missing contract %q", contract)
		}
	}
}

func TestAutoDisableNotifierFailsClosedWhenUnconfigured(t *testing.T) {
	t.Parallel()
	if err := (&EmailAutoDisableNotifier{}).NotifyWebhookAutoDisabled(
		context.Background(),
		"tenant",
		"webhook",
	); !errors.Is(err, ErrAutoDisableNotifierUnconfigured) {
		t.Fatalf("unconfigured notifier error = %v", err)
	}
}
