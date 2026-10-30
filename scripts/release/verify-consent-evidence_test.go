package main

import (
	"strings"
	"testing"
)

func TestConsentEvidencePreflightReportsOnlySafeIdentifiers(t *testing.T) {
	if maxReportedEvidenceIDs != 20 {
		t.Fatalf("reported identifier cap = %d", maxReportedEvidenceIDs)
	}
	for _, check := range consentEvidenceChecks {
		if check.name == "" || check.table == "" || check.idColumn != "id::text" {
			t.Fatalf("unsafe or incomplete check descriptor: %+v", check)
		}
		for _, unsafeProjection := range []string{
			"subject_email::text AS", "subscriber_email AS", "email::text AS",
			"user_agent AS", "ip_addr AS", "proof_text AS", "captured_text AS",
		} {
			if strings.Contains(check.idColumn, unsafeProjection) {
				t.Fatalf("%s sample projection exposes %q", check.name, unsafeProjection)
			}
		}
	}
	if !strings.Contains(consentEvidenceChecks[0].predicate, "jsonb_typeof(preferences) = 'object'") {
		t.Fatal("event preflight does not reject scalar/array/null JSON preferences")
	}
	for _, check := range consentEvidenceChecks {
		if !strings.Contains(check.predicate, "consent_evidence_timestamp_is_safe(") {
			t.Fatalf("%s preflight does not reject zero/out-of-range/infinite chronology", check.name)
		}
		if !strings.Contains(check.predicate, "id IS NOT NULL") {
			if !strings.Contains(check.predicate, "consent_evidence_uuid_is_safe(id)") {
				t.Fatalf("%s preflight does not reject missing/non-RFC row identity", check.name)
			}
		}
	}
	if !strings.Contains(consentEvidenceChecks[0].predicate, "decision_id IS NULL OR public.consent_evidence_uuid_is_safe(decision_id)") {
		t.Fatal("event preflight does not reject an invalid public-decision identity")
	}
	if !strings.Contains(consentEvidenceChecks[0].predicate, "(subject_id IS NOT NULL AND subject_id <> '') OR subject_email IS NOT NULL") {
		t.Fatal("event preflight does not require a durable subject identifier")
	}
	if !strings.Contains(consentEvidenceChecks[1].predicate, "id > 0") {
		t.Fatal("receipt preflight does not enforce the positive decimal identity contract")
	}
}

func TestConsentEvidencePreflightCoversEveryStrictReadSource(t *testing.T) {
	want := map[string]bool{
		"consent_events":   true,
		"consent_receipts": true,
		"consent_records":  true,
	}
	for _, check := range consentEvidenceChecks {
		delete(want, check.name)
		if !strings.Contains(check.predicate, "consent_evidence_") {
			t.Fatalf("%s does not reuse the database read-bound helpers", check.name)
		}
	}
	if len(want) != 0 {
		t.Fatalf("missing strict-read source checks: %v", want)
	}
}

func TestConsentEvidencePreflightTreatsSQLUnknownAsViolation(t *testing.T) {
	got := evidenceViolationPredicate("required_value IS NOT NULL AND safe(required_value)")
	if got != "(required_value IS NOT NULL AND safe(required_value)) IS NOT TRUE" {
		t.Fatalf("unexpected violation predicate: %q", got)
	}
	if strings.HasPrefix(got, "NOT (") {
		t.Fatal("plain NOT would silently exclude SQL NULL/UNKNOWN rows")
	}
}

func TestConsentEvidencePreflightCannotSilentlyScanThroughTenantRLS(t *testing.T) {
	if consentEvidenceDisableRLS != "SET LOCAL row_security = off" {
		t.Fatal("release-wide evidence scan can silently return zero rows through tenant RLS")
	}
}
