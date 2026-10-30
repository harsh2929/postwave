// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurance

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	auditAssuranceStarted    = "campaign.assurance_started"
	auditAssuranceCompleted  = "campaign.assurance_completed"
	auditAssuranceIncomplete = "campaign.assurance_incomplete"
	auditAssuranceBlocked    = "campaign.assurance_blocked"
	auditAssuranceOverridden = "campaign.assurance_overridden"
	auditAssuranceStale      = "campaign.assurance_stale"
)

// appendRunAuditEvent writes the domain transition through the canonical
// audit ledger in the same transaction as the lifecycle mutation. The audit
// ledger's transactional emitter makes the event exportable through the
// existing audit.created outbox without exposing message content.
//
// Keep this payload closed and content-free. In particular, it must never grow
// a generic metadata map, model output, extraction, MIME, prompt, error
// message, override reason, actor label, or recipient identity.
func appendRunAuditEvent(
	ctx context.Context,
	tx pgx.Tx,
	action string,
	run Run,
	actorID string,
	override *Override,
) error {
	switch action {
	case auditAssuranceStarted, auditAssuranceCompleted,
		auditAssuranceIncomplete, auditAssuranceBlocked,
		auditAssuranceOverridden, auditAssuranceStale:
	default:
		return fmt.Errorf("campaign assurance: unsupported audit action %q", action)
	}

	meta := db.AuditMeta{
		TenantID:   run.TenantID,
		ActorType:  "system",
		ActorLabel: "campaign_assurance",
	}
	if actorID != "" {
		meta.UserID = &actorID
		meta.ActorType = "human"
		meta.ActorLabel = "campaign_assurance_request"
		if action == auditAssuranceOverridden {
			meta.ActorLabel = "campaign_assurance_override"
		}
	}

	payload := runAuditPayload(run, override)

	if err := db.Audit(
		ctx,
		tx,
		meta,
		action,
		"campaign_assurance_run",
		run.ID,
		payload,
	); err != nil {
		return fmt.Errorf("campaign assurance: append %s audit event: %w", action, err)
	}
	return nil
}

func runAuditPayload(run Run, override *Override) map[string]any {
	payload := map[string]any{
		"schema_version":            "campaign-assurance-audit.v1",
		"campaign_id":               run.CampaignID,
		"content_revision_id":       run.ContentRevisionID,
		"send_plan_id":              run.SendPlanID,
		"run_no":                    run.RunNo,
		"request_id":                run.RequestID,
		"trigger_kind":              run.TriggerKind,
		"profile":                   run.Profile,
		"state":                     run.State,
		"gate_decision":             run.GateDecision,
		"attempt_count":             run.AttemptCount,
		"required_extraction_count": run.RequiredExtractionCount,
		"terminal_extraction_count": run.TerminalExtractionCount,
		"extraction_error_count":    run.ExtractionErrorCount,
		"blocking_finding_count":    run.BlockingFindingCount,
		"source_hash":               run.SourceHash,
		"plan_hash":                 run.PlanHash,
		"artifact_set_hash":         run.ArtifactSetHash,
		"coverage_manifest_hash":    run.CoverageManifestHash,
		"analyzer_suite_version":    run.AnalyzerSuiteVersion,
		"model_suite_version":       run.ModelSuiteVersion,
		"scoring_version":           run.ScoringVersion,
		"gate_policy_version":       run.GatePolicyVersion,
		"cost_microunits":           run.CostMicrounits,
		"latency_ms":                run.LatencyMS,
	}
	if run.ErrorCode != nil {
		// Error codes are bounded machine classifications. ErrorMessage is
		// intentionally excluded because it may contain provider text.
		payload["error_code"] = *run.ErrorCode
	}
	if override != nil {
		payload["override_id"] = override.ID
		payload["finding_id"] = override.FindingID
		payload["finding_receipt_hash"] = override.FindingReceiptHash
		payload["override_decision"] = override.Decision
		payload["override_expires_at"] = override.ExpiresAt
		// Override.Reason is intentionally absent: it is free-form operator
		// text and remains protected by the tenant-bound override ledger.
	}
	return payload
}

func appendFinalizationAuditEvents(ctx context.Context, tx pgx.Tx, run Run) error {
	action := auditAssuranceIncomplete
	if run.State == StateComplete {
		action = auditAssuranceCompleted
	}
	if err := appendRunAuditEvent(ctx, tx, action, run, "", nil); err != nil {
		return err
	}
	if run.GateDecision == GateBlock {
		return appendRunAuditEvent(ctx, tx, auditAssuranceBlocked, run, "", nil)
	}
	return nil
}
