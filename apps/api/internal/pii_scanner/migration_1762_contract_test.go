// SPDX-License-Identifier: AGPL-3.0-only

package pii_scanner

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestMigration1762_DurableAllWriterCoverageContract(t *testing.T) {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../infra/migrations/1762_subscriber_pii_durable_coverage.sql"))
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1762: %v", err)
	}
	sql := string(body)
	file := migrationrunner.MigrationFile{Version: "1762_subscriber_pii_durable_coverage", Path: path, SQL: sql}
	findings := migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file})
	for _, finding := range findings {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Fatalf("migration safety blocker: %+v", finding)
		}
	}
	plans := migrationrunner.AssessRollbackPlans([]migrationrunner.MigrationFile{file}, findings)
	if len(plans) != 1 || !plans[0].Explicit || plans[0].Strategy != migrationrunner.RollbackStrategyNoOp {
		t.Fatalf("migration rollback contract=%+v", plans)
	}

	required := []string{
		"ADD COLUMN IF NOT EXISTS pii_scan_revision bigint NOT NULL DEFAULT 1",
		"BEFORE INSERT OR UPDATE ON subscribers",
		"AFTER INSERT ON subscribers",
		"AFTER UPDATE ON subscribers",
		"AFTER DELETE ON subscribers",
		"REFERENCING NEW TABLE AS new_rows",
		"REFERENCING OLD TABLE AS old_rows",
		"REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows",
		"SECURITY DEFINER",
		"subscriber_pii_scan_intents",
		"subscriber_pii_scan_states",
		"subscriber_pii_delete_statement",
		"tenant_pii_scan_coverage",
		"scan_contract",
		"scan_contract_history",
		"seeded_generation",
		"availability_status",
		"tenant_runtime_visible",
		"target_revision",
		"claimed_revision",
		"coalesced_revisions",
		"reconcile_lease_owner",
		"reconcile_lease_token",
		"lease_token",
		"dirty_epoch",
		"FOR KEY SHARE OF tenant",
		"subscriber_pii_jsonb_within_limits",
		"octet_length(document::text) > 2097152",
		"child_count > max_children",
		"ON DELETE CASCADE NOT VALID",
		"VALIDATE CONSTRAINT subscriber_pii_scan_intents_subscriber_fk",
		"VALIDATE CONSTRAINT subscriber_pii_scan_states_subscriber_fk",
		"NEW.custom_fields IS DISTINCT FROM OLD.custom_fields",
		"'pending', 'leased', 'retry_wait', 'dead_letter'",
		"ON DELETE CASCADE",
		"current_setting('app.outbox_worker', true) = 'true'",
		"pg_advisory_xact_lock(",
		"hashtextextended(row_tenant_id::text, 1762)",
		"snapshot_exact = false",
		"tenant_custom_fields_pii_policy_changed",
		"reconciliation_requested_at",
		"one-way HMAC key commitment",
		"no values or",
		"never subscriber values or value hashes",
	}
	for _, fragment := range required {
		if !strings.Contains(sql, fragment) {
			t.Errorf("migration 1762 missing contract fragment %q", fragment)
		}
	}
	projectionPath := filepath.Join(filepath.Dir(sourceFile), "coverage_repo.go")
	projectionBody, err := os.ReadFile(projectionPath)
	if err != nil {
		t.Fatalf("read durable projection: %v", err)
	}
	for _, fragment := range []string{
		"pg_advisory_xact_lock_shared",
		"func (r *Repo) LoadClaimedSubscriberSnapshot",
		"IsoLevel: pgx.ReadCommitted",
		"revisionSQL += ` FOR SHARE`",
		"coverage.status NOT IN ('disabled', 'unavailable')",
	} {
		if !strings.Contains(string(projectionBody), fragment) {
			t.Errorf("runtime claim/value boundary is missing %q", fragment)
		}
	}
	for _, column := range []string{
		"custom_fields", "merge_fields", "first_name", "last_name", "full_name",
		"display_name", "unsubscribe_reason", "tags", "groups", "gdpr_permissions",
		"activity_summary", "source_id", "source_platform", "external_id", "timezone",
		"locale", "language", "country", "region",
	} {
		if !strings.Contains(sql, "NEW."+column+" IS DISTINCT FROM OLD."+column) {
			t.Errorf("revision trigger is missing projected column %q", column)
		}
		if !strings.Contains(string(projectionBody), "s."+column) {
			t.Errorf("snapshot projection is missing revisioned column %q", column)
		}
	}
	for _, computed := range []string{"engagement_score", "engagement_score_at", "churn_score", "rating"} {
		if strings.Contains(sql, "NEW."+computed+" IS DISTINCT FROM OLD."+computed) {
			t.Errorf("high-frequency computed column %q would create a scan storm", computed)
		}
	}
	// The durable queue/coverage evidence must never become a second PII store.
	intentStart := strings.Index(sql, "CREATE TABLE IF NOT EXISTS subscriber_pii_scan_intents")
	intentEnd := strings.Index(sql[intentStart:], "COMMENT ON TABLE subscriber_pii_scan_intents")
	if intentStart < 0 || intentEnd < 0 {
		t.Fatal("could not isolate intent DDL")
	}
	intentDDL := sql[intentStart : intentStart+intentEnd]
	for _, forbidden := range []string{"email", "raw_value", "payload", "custom_fields", "merge_fields", "value_hash"} {
		if strings.Contains(strings.ToLower(intentDDL), forbidden) {
			t.Errorf("intent DDL contains forbidden value-bearing fragment %q", forbidden)
		}
	}
}
