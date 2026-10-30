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

func TestMigration1760_ImmutableTenantScopedReceiptContract(t *testing.T) {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../infra/migrations/1760_subscriber_pii_review_receipts.sql"))
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1760: %v", err)
	}
	sql := string(body)
	file := migrationrunner.MigrationFile{Version: "1760_subscriber_pii_review_receipts", Path: path, SQL: sql}
	findings := migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file})
	for _, finding := range findings {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Fatalf("migration safety blocker: %+v", finding)
		}
	}
	plans := migrationrunner.AssessRollbackPlans([]migrationrunner.MigrationFile{file}, findings)
	if len(plans) != 1 || !plans[0].Explicit || plans[0].Strategy != migrationrunner.RollbackStrategyNoOp || plans[0].Details == "" {
		t.Fatalf("migration rollback contract=%+v", plans)
	}
	for _, finding := range migrationrunner.AssessRollbackContracts(plans) {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Fatalf("rollback contract blocker: %+v", finding)
		}
	}

	required := []string{
		"FOREIGN KEY (tenant_id, subscriber_id)",
		"FOREIGN KEY (tenant_id, finding_id)",
		"UNIQUE (tenant_id, finding_id)",
		"actor_type = 'legacy' AND reason = 'legacy_migrated'",
		"status = 'pending'",
		"reviewed_at = NULL",
		"subscriber_pii_findings_zz_review_guard",
		"subscriber_pii_review_receipts_immutable",
		"REVOKE DELETE, TRUNCATE ON subscriber_pii_findings FROM postwave_app, PUBLIC",
		"REVOKE UPDATE, DELETE, TRUNCATE ON subscriber_pii_review_receipts FROM postwave_app, PUBLIC",
		"ENABLE ROW LEVEL SECURITY",
		"FORCE ROW LEVEL SECURITY",
		"subscriber_pii_findings_fingerprint_token_check",
		"fingerprint_scheme = 'legacy-redacted-v1'",
		"fingerprint_key_version = 'legacy'",
		"scanner_name = 'legacy-unversioned'",
		"detector_version = 'unknown-pre-1760'",
		"policy_version = 'unknown-pre-1760'",
		"fingerprint_scheme = 'hmac-sha256-v1'",
		"encode(gen_random_bytes(32), 'hex')",
		"NEW.id IS DISTINCT FROM OLD.id",
		"NEW.confidence IS DISTINCT FROM OLD.confidence",
		"NEW.fingerprint_scheme IS DISTINCT FROM OLD.fingerprint_scheme",
		"NEW.created_at IS DISTINCT FROM OLD.created_at",
		"subscriber_pii_findings_detection_metadata_check",
		"subscriber_pii_review_receipts_comment_no_raw_pii_check",
		"finding_fingerprint <> NEW.raw_value_hash",
		"subscriber_pii_findings_fingerprint_prefix_idx",
		"WHERE fingerprint_scheme = 'hmac-sha256-v1'",
		"subscriber_pii_findings_tenant_created_page_idx",
		"subscriber_pii_findings_subscriber_page_idx",
		"subscriber_pii_findings_versioned_evidence_uniq_idx",
		"DROP CONSTRAINT IF EXISTS subscriber_pii_findings_tenant_id_subscriber_id_field_name__key",
	}
	for _, fragment := range required {
		if !strings.Contains(sql, fragment) {
			t.Errorf("migration 1760 missing contract fragment %q", fragment)
		}
	}
	for _, forbidden := range []string{
		"encode(digest(COALESCE(NULLIF(f.reviewed_by",
		"Contains a SHA-256 evidence token",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("migration 1760 retained unsafe legacy contract fragment %q", forbidden)
		}
	}
}
