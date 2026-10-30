// SPDX-License-Identifier: AGPL-3.0-only
package privacy

import "testing"

func TestConversionHMACPseudonymsAreInTheErasureInventory(t *testing.T) {
	declared := make(map[string]bool, len(declaredSubjectDataTables))
	for _, table := range declaredSubjectDataTables {
		declared[table] = true
	}
	for _, table := range []string{
		"conversion_attribution_touches",
		"conversion_email_hmac_bindings",
		"conversion_email_hmac_projection_tasks",
		"conversions",
	} {
		if !declared[table] {
			t.Errorf("conversion HMAC subject table %q is absent from erasure inventory", table)
		}
	}
}

func TestFrequencyCapEventsAreDeclaredAndActivelyErased(t *testing.T) {
	declared := make(map[string]bool, len(declaredSubjectDataTables))
	for _, table := range declaredSubjectDataTables {
		declared[table] = true
	}
	covered := make(map[string]bool, len(erasureCoveredTables))
	for _, table := range erasureCoveredTables {
		covered[table] = true
	}
	if !declared["frequency_cap_events"] {
		t.Fatal("frequency_cap_events plaintext subscriber identity is absent from the authoritative inventory")
	}
	if !covered["frequency_cap_events"] {
		t.Fatal("frequency_cap_events is declared but the active erasure path does not reach it")
	}
}

func TestSendingOperationalIdentityIsDeclaredAndActivelyErased(t *testing.T) {
	declared := make(map[string]bool, len(declaredSubjectDataTables))
	for _, table := range declaredSubjectDataTables {
		declared[table] = true
	}
	covered := make(map[string]bool, len(erasureCoveredTables))
	for _, table := range erasureCoveredTables {
		covered[table] = true
	}
	for _, table := range []string{"subscriber_send_log", "intelligent_retry_events"} {
		if !declared[table] {
			t.Errorf("%s plaintext subscriber identity is absent from the authoritative inventory", table)
		}
		if !covered[table] {
			t.Errorf("%s is declared but the active erasure path does not reach it", table)
		}
	}
}

func TestContentReportNotifierIdentityIsDeclaredAndReleaseHeld(t *testing.T) {
	declared := make(map[string]bool, len(declaredSubjectDataTables))
	for _, table := range declaredSubjectDataTables {
		declared[table] = true
	}
	covered := make(map[string]bool, len(erasureCoveredTables))
	for _, table := range erasureCoveredTables {
		covered[table] = true
	}
	if !declared["content_reports"] {
		t.Fatal("content_reports notifier_email is absent from the authoritative erasure inventory")
	}
	if covered["content_reports"] {
		t.Fatal("content_reports claims active erasure coverage before its notice-evidence retention policy is approved")
	}
	if erasureHistoryCoverageComplete {
		t.Fatal("global erasure completion became true while content-report notifier identity remains release-held")
	}
}

func TestHelpdeskRelationalErasureInventoryIsExplicitlyUncovered(t *testing.T) {
	covered := make(map[string]bool, len(erasureCoveredTables))
	for _, table := range erasureCoveredTables {
		covered[table] = true
	}
	want := map[string]bool{
		"customer_hub_configs":          true,
		"support_conversations":         true,
		"support_messages":              true,
		"support_tickets":               true,
		"support_assignments":           true,
		"support_spam_assessments":      true,
		"support_agent_runs":            true,
		"support_internal_note_intents": true,
		"support_ingest_conflicts":      true,
		"support_integrations":          true,
		"support_sync_runs":             true,
		"support_webhook_events":        true,
	}
	for _, table := range declaredHelpdeskRelationalSubjectTables {
		delete(want, table)
		if covered[table] {
			t.Fatalf("%q unexpectedly claims active erasure coverage", table)
		}
	}
	for table := range want {
		t.Errorf("Helpdesk relational inventory omits %q", table)
	}
}
