// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceretention

import (
	"os"
	"strings"
	"testing"
)

func TestRawOutputRetentionMigrationContract(t *testing.T) {
	body, err := os.ReadFile("../../../../infra/migrations/2013_campaign_assurance_raw_output_retention.sql")
	if err != nil {
		t.Fatal(err)
	}
	sql := string(body)
	for _, required := range []string{
		"CREATE TABLE campaign_assurance_raw_output_retention_tasks",
		"CREATE TABLE campaign_assurance_raw_output_version_receipts",
		"CREATE TABLE campaign_assurance_raw_output_retention_receipts",
		"storage_version_id",
		"provider_proof_sha256",
		"campaign_assurance_legal_hold_active",
		"pg_advisory_xact_lock",
		"campaign_assurance_legal_holds_raw_output_fence",
		"campaign_assurance_raw_output_retention_deleted_once_idx",
		"campaign_assurance_extractions_raw_output_enqueue",
		"raw-output references have conflicting hash or expiry identity",
		"FORCE ROW LEVEL SECURITY",
		"REVOKE UPDATE, DELETE, TRUNCATE ON campaign_assurance_raw_output_version_receipts",
		"REVOKE UPDATE, DELETE, TRUNCATE ON campaign_assurance_raw_output_retention_receipts",
		"raw-output deletion is not expired, exact-version, and hold-free",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("migration lacks %q", required)
		}
	}
	if strings.Contains(sql, "DELETE FROM campaign_assurance_extractions") ||
		strings.Contains(sql, "UPDATE campaign_assurance_extractions") {
		t.Fatal("retention migration must not rewrite append-only extraction evidence")
	}
	repositorySource, err := os.ReadFile("repository.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"FOR UPDATE SKIP LOCKED",
		"lease_expires_at <= statement_timestamp()",
		"pg_advisory_xact_lock",
		"DeleteUnderLegalHoldFence",
	} {
		if !strings.Contains(string(repositorySource), required) {
			t.Errorf("repository lacks %q", required)
		}
	}
}

func TestModeledCacheReuseAlreadyRequiresLiveRawOutput(t *testing.T) {
	body, err := os.ReadFile("../../../../infra/migrations/1931_campaign_assurance_modeled_cache_and_cost_budget.sql")
	if err != nil {
		t.Fatal(err)
	}
	sql := string(body)
	if !strings.Contains(sql, "source.raw_output_expires_at > statement_timestamp()") {
		t.Fatal("modeled cache reuse is not fenced by raw-output expiry")
	}
}
