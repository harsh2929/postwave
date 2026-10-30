// SPDX-License-Identifier: AGPL-3.0-only

package consent

import (
	"os"
	"strings"
	"testing"
)

func TestMigration1979ConsentEvidenceIntegrityContract(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile("../../../../infra/migrations/1979_consent_evidence_read_integrity.sql")
	if err != nil {
		t.Fatalf("read migration 1979: %v", err)
	}
	source := string(raw)
	for _, required := range []string{
		"ADD COLUMN IF NOT EXISTS recorded_at timestamptz",
		"ALTER COLUMN recorded_at SET DEFAULT clock_timestamp()",
		"NEW.recorded_at := pg_catalog.clock_timestamp()",
		"consent receipt recording chronology is immutable",
		"ADD COLUMN IF NOT EXISTS recorded_xid xid8",
		"consent_evidence_stamp_recorded_xid",
		"NEW.recorded_xid := pg_catalog.pg_current_xact_id()",
		"consent evidence recording transaction is immutable",
		"aa_1979_consent_receipts_recorded_xid",
		"aa_1979_consent_records_recorded_xid",
		"aa_1979_consent_events_recorded_xid",
		"ADD COLUMN IF NOT EXISTS decision_id uuid",
		"ADD COLUMN IF NOT EXISTS request_fingerprint text",
		"consent_events_decision_fingerprint_pair",
		"consent_events_decision_identity_immutable",
		"consent_evidence_token_is_safe",
		"consent_evidence_unicode_trim",
		`U&'\0009\000A\000B\000C\000D\0020\0085\00A0`,
		`pg_catalog.strpos(value, U&'\206F') = 0`,
		`pg_catalog.strpos(value, U&'\FEFF') = 0`,
		"consent_evidence_narrative_is_safe",
		"consent_evidence_email_is_safe",
		"consent_evidence_timestamp_is_safe",
		"consent_evidence_uuid_is_safe",
		"pg_catalog.substr(value::text, 15, 1) ~ '^[1-8]$'",
		"pg_catalog.substr(value::text, 20, 1) ~ '^[89ab]$'",
		"value > TIMESTAMPTZ '0001-01-01 00:00:00+00'",
		"value < TIMESTAMPTZ '10000-01-01 00:00:00+00'",
		"consent_events_read_contract_bounds",
		"consent_receipts_read_contract_bounds",
		"consent_records_read_contract_bounds",
		"pg_catalog.jsonb_typeof(preferences) = 'object'",
		"id IS NOT NULL AND id > 0",
		"public.consent_evidence_uuid_is_safe(id)",
		"public.consent_evidence_timestamp_is_safe(COALESCE(recorded_at, created_at))",
		"public.consent_evidence_timestamp_is_safe(COALESCE(recorded_at, at))",
		") NOT VALID",
		"CREATE POLICY consent_receipts_tenant_isolation",
		"AS RESTRICTIVE FOR ALL TO postwave_app",
		"ALTER TABLE public.consent_receipts FORCE ROW LEVEL SECURITY",
		"CREATE INDEX CONCURRENTLY IF NOT EXISTS consent_receipts_recorded_page_idx",
		"CREATE INDEX CONCURRENTLY IF NOT EXISTS consent_records_recorded_page_idx",
		"CREATE INDEX CONCURRENTLY IF NOT EXISTS consent_events_recorded_page_idx",
		"CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS consent_events_decision_category_uidx",
		"WHERE decision_id IS NOT NULL",
	} {
		if !strings.Contains(source, required) {
			t.Errorf("migration 1979 lost required contract %q", required)
		}
	}
	if strings.Contains(strings.ToLower(source), "update public.consent_receipts\n   set recorded_at") {
		t.Error("migration 1979 must not perform a blocking historical recorded_at backfill")
	}
	if count := strings.Count(source, "ADD COLUMN IF NOT EXISTS recorded_xid xid8"); count != 3 {
		t.Errorf("migration 1979 must add one nullable recording xid to each exact source plane; count=%d", count)
	}
	if strings.Contains(source, "ALTER COLUMN recorded_xid SET DEFAULT") ||
		strings.Contains(strings.ToLower(source), "set recorded_xid =") {
		t.Error("migration 1979 must not rewrite or default historical recording xids")
	}
	if strings.Contains(source, "VALIDATE CONSTRAINT consent_") {
		t.Error("migration 1979 must not run an unbounded legacy validation scan")
	}

	policyStart := strings.Index(source, "CREATE POLICY consent_receipts_tenant_isolation")
	policyEnd := strings.Index(source, "ALTER TABLE public.consent_receipts ENABLE ROW LEVEL SECURITY")
	if policyStart < 0 || policyEnd <= policyStart {
		t.Fatal("could not isolate consent_receipts RLS policy block")
	}
	policyBlock := source[policyStart:policyEnd]
	if strings.Contains(policyBlock, "app.outbox_worker") {
		t.Error("consent_receipts policy retained the generic outbox-worker cross-tenant bypass")
	}
	if strings.Count(policyBlock, "tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid") < 4 {
		t.Error("consent_receipts USING/WITH CHECK predicates are not tenant-bound in both policies")
	}

	commitAt := strings.Index(source, "COMMIT;")
	firstConcurrentIndex := strings.Index(source, "CREATE INDEX CONCURRENTLY")
	if commitAt < 0 || firstConcurrentIndex < commitAt {
		t.Error("online evidence indexes must be built outside the migration transaction")
	}
}
