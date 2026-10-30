// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurance

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestCampaignAssuranceAuditPayloadIsClosedAndContentFree(t *testing.T) {
	expires := time.Date(2026, 8, 14, 4, 30, 0, 0, time.UTC)
	errorCode := "provider_unavailable"
	run := Run{
		ID: "71000000-0000-4000-8000-000000000001", TenantID: "71000000-0000-4000-8000-000000000002",
		CampaignID: "71000000-0000-4000-8000-000000000003", ContentRevisionID: "71000000-0000-4000-8000-000000000004",
		SendPlanID: "71000000-0000-4000-8000-000000000005", RequestID: "71000000-0000-4000-8000-000000000006",
		RunNo: 7, TriggerKind: TriggerQueue, Profile: ProfileFull,
		State: StateIncomplete, GateDecision: GateUnavailable, AttemptCount: 2,
		RequiredExtractionCount: 8, TerminalExtractionCount: 7,
		ExtractionErrorCount: 1, BlockingFindingCount: 0,
		SourceHash: strings.Repeat("1", 64), PlanHash: strings.Repeat("2", 64),
		ArtifactSetHash: strings.Repeat("3", 64), CoverageManifestHash: strings.Repeat("4", 64),
		AnalyzerSuiteVersion: "analyzer-v1", ModelSuiteVersion: "model-v1",
		ScoringVersion: "score-v1", GatePolicyVersion: "gate-v1",
		ErrorCode: &errorCode, CostMicrounits: 22, LatencyMS: 44,
	}
	override := &Override{
		ID:                 "71000000-0000-4000-8000-000000000007",
		FindingID:          "71000000-0000-4000-8000-000000000008",
		FindingReceiptHash: strings.Repeat("5", 64), Decision: "allow_send",
		Reason:    "private operator prose that must never be exported",
		ExpiresAt: &expires,
	}

	raw, err := json.Marshal(runAuditPayload(run, override))
	if err != nil {
		t.Fatal(err)
	}
	encoded := strings.ToLower(string(raw))
	for _, forbidden := range []string{
		"subject", "body", "mime", "normalized_extraction", "raw_output",
		"object_ref", "prompt", "provider_payload", "recipient", "mailbox",
		"secret", "error_message", "override_reason", "private operator prose",
	} {
		if strings.Contains(encoded, forbidden) {
			t.Errorf("audit payload leaked %q: %s", forbidden, raw)
		}
	}
	for _, required := range []string{
		`"schema_version":"campaign-assurance-audit.v1"`,
		`"content_revision_id"`, `"artifact_set_hash"`, `"error_code"`,
		`"override_id"`, `"finding_receipt_hash"`,
	} {
		if !strings.Contains(encoded, required) {
			t.Errorf("audit payload missing %s: %s", required, raw)
		}
	}
}

func TestCampaignAssuranceAuditActionsAreClosed(t *testing.T) {
	if err := appendRunAuditEvent(
		context.Background(), nil, "campaign.assurance_model_output", Run{}, "", nil,
	); err == nil || !strings.Contains(err.Error(), "unsupported audit action") {
		t.Fatalf("unknown action error = %v", err)
	}
}
