// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurancerawstore

import (
	"os"
	"strings"
	"testing"
)

func TestRawOutputWriteReceiptMigrationContract(t *testing.T) {
	body, err := os.ReadFile("../../../../infra/migrations/2016_campaign_assurance_raw_output_write_receipts.sql")
	if err != nil {
		t.Fatal(err)
	}
	sql := string(body)
	for _, required := range []string{
		"CREATE TABLE campaign_assurance_raw_output_write_intents",
		"CREATE TABLE campaign_assurance_raw_output_write_receipts",
		"CREATE TABLE campaign_assurance_raw_output_cleanup_receipts",
		"byte_size BETWEEN 1 AND 131072",
		"checksum_sha256_base64",
		"storage_version_id",
		"kms_key_id_sha256",
		"provider_proof_sha256",
		"provider_request_id_sha256",
		"campaign_assurance_extractions_raw_output_write_receipt_gate",
		"new raw-output extraction reference has no durable write receipt",
		"raw-output cleanup receipt is not bound to an unreferenced active lease",
		"intent.lease_expires_at <= statement_timestamp()",
		"campaign_assurance_raw_output_cleanup_success_once_idx",
		"ENABLE ROW LEVEL SECURITY",
		"FORCE ROW LEVEL SECURITY",
		"REVOKE UPDATE, DELETE, TRUNCATE ON campaign_assurance_raw_output_write_receipts",
		"REVOKE UPDATE, DELETE, TRUNCATE ON campaign_assurance_raw_output_cleanup_receipts",
		"rollback-strategy: no-op",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("migration lacks %q", required)
		}
	}
	repository, err := os.ReadFile("repository.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"FOR UPDATE SKIP LOCKED",
		"limit < 1 || limit > 500",
		"lease_expires_at <= statement_timestamp()",
		"NOT EXISTS (\n            SELECT 1 FROM campaign_assurance_extractions",
	} {
		if !strings.Contains(string(repository), required) {
			t.Errorf("bounded orphan repository lacks %q", required)
		}
	}
	for _, forbidden := range []string{
		"DELETE FROM campaign_assurance_extractions",
		"UPDATE campaign_assurance_extractions",
		"GRANT DELETE",
		"GRANT TRUNCATE",
	} {
		if strings.Contains(sql, forbidden) {
			t.Errorf("migration contains unsafe fragment %q", forbidden)
		}
	}
}

func TestRawOutputStoreHasOneVersionMandatoryDeleteBoundary(t *testing.T) {
	body, err := os.ReadFile("reconcile.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(body)
	if strings.Count(source, ".DeleteObject(") != 1 {
		t.Fatalf("DeleteObject boundary count = %d, want exactly one", strings.Count(source, ".DeleteObject("))
	}
	for _, required := range []string{
		"VersionId: aws.String(receipt.VersionID)",
		"receipt.VersionID == \"\"",
		"NoSuchVersion",
		"NoSuchKey",
		"ProviderRequestIDHash",
		"sha256Hex([]byte(requestID))",
	} {
		if !strings.Contains(source, required) {
			t.Errorf("exact deletion boundary lacks %q", required)
		}
	}
	if strings.Contains(source, `ProviderRequestID string`) {
		t.Fatal("exact deletion boundary carries a plaintext provider request ID")
	}
}

func TestGenericUploadsStoreCannotSatisfyRawOutputBoundary(t *testing.T) {
	body, err := os.ReadFile("../campaignassuranceworker/types.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "CampaignAssuranceRawOutputStore()") {
		t.Fatal("raw-output writer lost its explicit security marker")
	}
	wiring, err := os.ReadFile("../campaignassuranceworker/wiring.go")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(wiring), "_ RawOutputStore      = (uploads.Store)(nil)") {
		t.Fatal("generic key-only uploads.Store again satisfies raw-output writer")
	}
}
