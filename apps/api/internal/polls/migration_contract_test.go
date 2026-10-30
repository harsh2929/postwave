// SPDX-License-Identifier: AGPL-3.0-only

package polls

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestPollHardeningMigrationCarriesTenantAndHumanOnlyContracts(t *testing.T) {
	t.Parallel()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate migration contract test")
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(sourceFile),
		"../../../../infra/migrations/1952_campaign_poll_security_hardening.sql"))
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read poll hardening migration: %v", err)
	}
	sql := string(body)
	for _, required := range []string{
		"CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS campaign_polls_tenant_id_id_uidx",
		"CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS campaign_poll_options_tenant_poll_id_id_uidx",
		"CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS campaign_poll_responses_tenant_token_uniq",
		"FOREIGN KEY (tenant_id, campaign_id)",
		"FOREIGN KEY (tenant_id, poll_id)",
		"FOREIGN KEY (tenant_id, poll_id, option_id)",
		"classification = 'human'",
		"unclassified_excluded",
		"confirmation_token_hash",
		"confirmation_expires_at",
		"confirmation_used_at",
		"campaign_polls FORCE ROW LEVEL SECURITY",
		"campaign_poll_options FORCE ROW LEVEL SECURITY",
		"campaign_poll_responses FORCE ROW LEVEL SECURITY",
		"ON campaign_poll_responses (tenant_id, token_hash)",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("migration omitted %q", required)
		}
	}
	stateReplacement := strings.Index(sql, "ADD CONSTRAINT campaign_poll_responses_state_check CHECK")
	legacyRepair := strings.Index(sql, "SET classification = 'unknown',\n       state = 'unclassified_excluded'")
	stateValidation := strings.Index(sql, "VALIDATE CONSTRAINT campaign_poll_responses_state_check")
	if stateReplacement < 0 || legacyRepair < 0 || stateValidation < 0 ||
		stateReplacement > legacyRepair || legacyRepair > stateValidation {
		t.Fatalf("state vocabulary must expand before legacy repair and validate after it: replacement=%d repair=%d validation=%d",
			stateReplacement, legacyRepair, stateValidation)
	}
}

func TestPollTokenProvenanceMigrationCarriesImmutableReceiptContracts(t *testing.T) {
	t.Parallel()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate migration contract test")
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(sourceFile),
		"../../../../infra/migrations/2015_campaign_poll_token_provenance.sql"))
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read poll token provenance migration: %v", err)
	}
	sql := string(body)
	for _, required := range []string{
		"content_revision_source_hash",
		"poll_contract_sha256",
		"token_version = 3",
		"accepting_responses",
		"campaign_poll_response_receipts",
		"link_token_key_id",
		"token_issued_at",
		"token_expires_at",
		"submission_key_sha256",
		"upstream_classification",
		"classifier_version",
		"methodology_version",
		"registry_version",
		"configuration_hash",
		"evidence_sha256",
		"receipt_sha256",
		"campaign_poll_response_receipt_append_only",
		"BEFORE UPDATE OR DELETE",
		"FORCE ROW LEVEL SECURITY",
		"GRANT SELECT, INSERT ON campaign_poll_response_receipts TO postwave_app",
		"campaign_polls_revision_key_uniq",
		"superseded_choice",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("migration omitted %q", required)
		}
	}
	if strings.Contains(sql, "GRANT UPDATE") || strings.Contains(sql, "GRANT DELETE") {
		t.Fatal("append-only receipt migration grants mutation privileges")
	}
}
