// SPDX-License-Identifier: AGPL-3.0-only
package sending_identity

import (
	"os"
	"strings"
	"testing"
)

func TestDMARCEvidenceMigrationIsPhasedReconciledAndValidated(t *testing.T) {
	raw, err := os.ReadFile("../../../../infra/migrations/1854_dmarc_evidence_hardening.sql")
	if err != nil {
		t.Fatalf("read migration 1854: %v", err)
	}
	sql := string(raw)
	upper := strings.ToUpper(sql)

	for _, required := range []string{
		"migration-execution: phased",
		"SET LOCAL lock_timeout = '5s'",
		"SET LOCAL statement_timeout = '5min'",
		"SET LOCAL statement_timeout = '10min'",
		"ALTER TABLE dmarc_aggregate_records FORCE ROW LEVEL SECURITY",
		"ALTER TABLE sending_identities NO FORCE ROW LEVEL SECURITY",
		"ALTER TABLE dmarc_aggregate_reports NO FORCE ROW LEVEL SECURITY",
		"ALTER TABLE dmarc_aggregate_records NO FORCE ROW LEVEL SECURITY",
		"SET LOCAL row_security = off",
		"UPDATE sending_identities",
		"dmarc_record_value = 'v=DMARC1; p=none; aspf=r; adkim=r'",
		"dmarc_verified_at = CASE",
		"verified_at = NULL",
		"sending_identities_dns_instruction_safety_check",
		"VALIDATE CONSTRAINT dmarc_reports_date_order_check",
		"VALIDATE CONSTRAINT sending_identities_dns_instruction_safety_check",
		"CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dmarc_reports_tenant_domain_period",
		"CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dmarc_records_report_source",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("migration 1854 is missing %q", required)
		}
	}

	if strings.Contains(strings.ToLower(sql), "mailto:dmarc-") {
		t.Fatal("migration retained an unqualified Moosewave DMARC reporting destination")
	}
	if strings.Contains(upper, "DELETE FROM DMARC_AGGREGATE_RECORDS") {
		t.Fatal("migration must preserve malformed historical DMARC evidence for audited cleanup")
	}
	if strings.Contains(upper, "VALIDATE CONSTRAINT DMARC_RECORDS_POSITIVE_COUNT_CHECK") {
		t.Fatal("positive-count check cannot be validated while legacy non-positive evidence is preserved")
	}
	lastNoForce := strings.LastIndex(upper, "NO FORCE ROW LEVEL SECURITY")
	firstDataUpdate := strings.Index(upper, "UPDATE SENDING_IDENTITIES")
	lastDataUpdate := strings.LastIndex(upper, "UPDATE DMARC_AGGREGATE_RECORDS")
	lastForce := strings.LastIndex(upper, "FORCE ROW LEVEL SECURITY")
	if lastNoForce < 0 || firstDataUpdate < lastNoForce || lastDataUpdate < firstDataUpdate || lastForce < lastDataUpdate {
		t.Fatal("migration must relax FORCE RLS only around reconciliation and restore it before commit")
	}
	lastCommit := strings.LastIndex(upper, "COMMIT;")
	firstConcurrentIndex := strings.Index(upper, "CREATE INDEX CONCURRENTLY")
	if lastCommit < 0 || firstConcurrentIndex < 0 || firstConcurrentIndex < lastCommit {
		t.Fatal("concurrent DMARC indexes must be built after the final explicit transaction")
	}
	if strings.Contains(upper[firstConcurrentIndex:], "BEGIN;") {
		t.Fatal("concurrent DMARC index phase unexpectedly opens an explicit transaction")
	}
}
