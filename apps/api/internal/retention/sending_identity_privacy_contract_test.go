// SPDX-License-Identifier: AGPL-3.0-only

package retention

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestSendingIdentityRetentionWindowIsBoundedByProductContracts(t *testing.T) {
	tests := []struct {
		name string
		days int
		want int
	}{
		{name: "malformed low cannot erase frequency lookback", days: 1, want: 30},
		{name: "minimum", days: 30, want: 30},
		{name: "tenant setting", days: 365, want: 365},
		{name: "malformed high cannot become indefinite", days: 999999, want: 2555},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			s := &Sweeper{Privacy: fakePrivacy{days: test.days}}
			got, err := s.sendingIdentityRetentionDays(context.Background(), "tenant")
			if err != nil {
				t.Fatalf("sendingIdentityRetentionDays: %v", err)
			}
			if got != test.want {
				t.Fatalf("retention days = %d, want %d", got, test.want)
			}
		})
	}
	if _, err := (&Sweeper{}).sendingIdentityRetentionDays(context.Background(), "tenant"); err == nil {
		t.Fatal("missing privacy-policy authority did not fail closed")
	}
}

func TestMigration2037PinsSendingIdentityPrivacyLifecycle(t *testing.T) {
	const path = "../../../../infra/migrations/2037_sending_identity_privacy_lifecycle.sql"
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 2037: %v", err)
	}
	sql := string(raw)
	file := migrationrunner.MigrationFile{
		Version: "2037_sending_identity_privacy_lifecycle",
		Path:    path,
		SQL:     sql,
	}
	findings := migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file})
	for _, finding := range findings {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf("migration 2037 safety blocker %q at line %d: %s",
				finding.Rule, finding.Line, finding.Snippet)
		}
	}
	for _, finding := range migrationrunner.AssessRollbackContracts(
		migrationrunner.AssessRollbackPlans([]migrationrunner.MigrationFile{file}, findings),
	) {
		if finding.Severity == migrationrunner.SafetyBlocker ||
			finding.Severity == migrationrunner.SafetyWarning {
			t.Errorf("migration 2037 rollback contract %s: %s",
				finding.Severity, finding.Message)
		}
	}

	required := []string{
		"migration-execution: phased",
		"CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriber_send_log_retention_idx",
		"ON subscriber_send_log (tenant_id, sent_at, id)",
		"CREATE INDEX CONCURRENTLY IF NOT EXISTS intelligent_retry_events_retention_idx",
		"ON intelligent_retry_events (tenant_id, created_at, id)",
		"ALTER POLICY tenant_isolation ON subscriber_send_log",
		"subscriber_send_log_retention_worker_select",
		"intelligent_retry_events_retention_worker_select",
		"current_setting('app.outbox_worker', true)",
		"current_setting('app.retention_worker', true)",
		"FOR SELECT TO postwave_app",
	}
	for _, fragment := range required {
		if !strings.Contains(sql, fragment) {
			t.Errorf("migration 2037 lost required contract %q", fragment)
		}
	}
	for _, policy := range []string{
		"subscriber_send_log_retention_worker_select",
		"intelligent_retry_events_retention_worker_select",
	} {
		start := strings.Index(sql, "CREATE POLICY "+policy)
		if start < 0 {
			t.Fatalf("worker policy %s not found", policy)
		}
		end := strings.Index(sql[start:], ");")
		if end < 0 {
			t.Fatalf("worker policy %s has no terminator", policy)
		}
		body := sql[start : start+end+2]
		for _, forbidden := range []string{"FOR ALL", "FOR INSERT", "FOR UPDATE", "FOR DELETE", "WITH CHECK"} {
			if strings.Contains(body, forbidden) {
				t.Errorf("worker policy %s must remain SELECT-only; found %q", policy, forbidden)
			}
		}
	}
}

func TestMigration2038PinsNarrowSendingIdentityRotationPrivilege(t *testing.T) {
	const path = "../../../../infra/migrations/2038_sending_identity_email_rotation.sql"
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 2038: %v", err)
	}
	sql := string(raw)
	file := migrationrunner.MigrationFile{
		Version: "2038_sending_identity_email_rotation",
		Path:    path,
		SQL:     sql,
	}
	findings := migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file})
	for _, finding := range findings {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf("migration 2038 safety blocker %q at line %d: %s",
				finding.Rule, finding.Line, finding.Snippet)
		}
	}
	for _, finding := range migrationrunner.AssessRollbackContracts(
		migrationrunner.AssessRollbackPlans([]migrationrunner.MigrationFile{file}, findings),
	) {
		if finding.Severity == migrationrunner.SafetyBlocker ||
			finding.Severity == migrationrunner.SafetyWarning {
			t.Errorf("migration 2038 rollback contract %s: %s",
				finding.Severity, finding.Message)
		}
	}

	for _, fragment := range []string{
		"migration-execution: transactional",
		"rollback-strategy: restore",
		"GRANT UPDATE (subscriber_email) ON subscriber_send_log TO postwave_app",
	} {
		if !strings.Contains(sql, fragment) {
			t.Errorf("migration 2038 lost required contract %q", fragment)
		}
	}
	for _, forbidden := range []string{
		"GRANT UPDATE ON subscriber_send_log",
		"GRANT ALL",
		"DISABLE ROW LEVEL SECURITY",
		"NO FORCE ROW LEVEL SECURITY",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("migration 2038 broadened its privilege boundary with %q", forbidden)
		}
	}
}

func TestSendingIdentitySweepsStayWiredToDiscoveryAndSharedRetryLease(t *testing.T) {
	raw, err := os.ReadFile("raw_payloads.go")
	if err != nil {
		t.Fatalf("read retention fan-out: %v", err)
	}
	fanout := string(raw)
	for _, fragment := range []string{
		`{"subscriber_send_log", func() (int64, error)`,
		`{"intelligent_retry_events", func() (int64, error)`,
		"SELECT DISTINCT tenant_id::text FROM subscriber_send_log",
		"SELECT DISTINCT tenant_id::text FROM intelligent_retry_events",
	} {
		if !strings.Contains(fanout, fragment) {
			t.Errorf("retention fan-out/discovery lost %q", fragment)
		}
	}

	raw, err = os.ReadFile("sweep_sending_identity.go")
	if err != nil {
		t.Fatalf("read sending identity sweep: %v", err)
	}
	sweep := string(raw)
	for _, fragment := range []string{
		"statement_timestamp() - make_interval(days => $2::int)",
		"candidate.sent_at < (SELECT cutoff_at FROM policy)",
		"candidate.created_at < (SELECT cutoff_at FROM policy)",
		"candidate.status <> 'retrying'",
		"intelligent_retry.RetryClaimLeaseDuration",
		"FOR UPDATE SKIP LOCKED",
		"campaign_assurance_legal_hold_active",
		"pg_advisory_xact_lock",
		"audit.PurgeAction",
		"writeSendingIdentityPurgeReceipt",
		`"deleted_count"`,
		`"cutoff_at"`,
	} {
		if !strings.Contains(sweep, fragment) {
			t.Errorf("sending identity sweep lost %q", fragment)
		}
	}
	if strings.Contains(sweep, "candidate.updated_at < now() - make_interval(days") {
		t.Fatal("retry privacy deadline regressed from created_at to extendable updated_at")
	}
	metadataStart := strings.Index(sweep, "metadata, err := json.Marshal")
	if metadataStart < 0 {
		t.Fatal("sending identity receipt metadata block not found")
	}
	metadataEnd := strings.Index(sweep[metadataStart:], "if err != nil")
	if metadataEnd < 0 {
		t.Fatal("sending identity receipt metadata terminator not found")
	}
	metadataBlock := sweep[metadataStart : metadataStart+metadataEnd]
	for _, forbiddenReceiptField := range []string{
		`"subscriber_email"`,
		`"email"`,
		`"campaign_id"`,
		`"subscriber_id"`,
		`"deleted_ids"`,
	} {
		if strings.Contains(metadataBlock, forbiddenReceiptField) {
			t.Errorf("sending identity purge receipt contains identity field %s", forbiddenReceiptField)
		}
	}
}
