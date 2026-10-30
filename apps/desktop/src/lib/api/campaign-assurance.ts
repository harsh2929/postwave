// SPDX-License-Identifier: AGPL-3.0-only

import { apiRequest } from "../api-client";
import { newUUIDv7 } from "../http-fetch";
import type { ApiResult } from "./result";

export type CampaignAssuranceSourceClass =
  | "deterministic"
  | "modeled"
  | "controlled_observation";

export interface CampaignAssuranceMeasurement {
  name: "Predicted Agent Comprehension";
  interpretation: string;
  source_classes: Array<{
    class: CampaignAssuranceSourceClass;
    present: boolean;
    meaning: string;
  }>;
}

export interface CampaignAssuranceEnvelope<T> {
  measurement: CampaignAssuranceMeasurement;
  data: T;
}

export interface CampaignAssuranceRun {
  id: string;
  content_revision_id: string;
  send_plan_id: string;
  run_no: number;
  profile: "fast" | "full" | "calibration";
  state:
    | "queued"
    | "running"
    | "complete"
    | "incomplete"
    | "failed"
    | "cancelled"
    | "stale";
  source_hash: string;
  plan_hash: string;
  artifact_set_hash: string;
  coverage_manifest_hash?: string;
  configuration_manifest_hash?: string;
  target_manifest_hash?: string;
  renderer_version: string;
  compiler_version: string;
  analyzer_suite_version: string;
  model_suite_version: string;
  prompt_suite_version: string;
  normalization_version?: string;
  scoring_version: string;
  gate_policy_version: string;
  methodology_version: string;
  required_extraction_count: number;
  terminal_extraction_count: number;
  successful_extraction_count: number;
  extraction_error_count: number;
  finding_count: number;
  blocking_finding_count: number;
  overall_score: number | null;
  score_min: number | null;
  score_max: number | null;
  score_spread?: number | null;
  agreement?: number | null;
  gate_decision: "pending" | "pass" | "warn" | "block" | "unavailable";
  input_tokens?: number;
  output_tokens?: number;
  cost_microunits?: number;
  max_modeled_cost_microunits?: number;
  latency_ms?: number;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

export interface CampaignAssuranceLatest {
  detail: {
    run: CampaignAssuranceRun;
    manifest: {
      artifacts: Array<{
        artifact_id: string;
        scenario_id: string;
        outbound_mime_hash: string;
        mime_structure_hash: string;
      }>;
      configurations: Array<{
        configuration_id: string;
        source_class: CampaignAssuranceSourceClass;
        configuration_hash: string;
      }>;
      targets: Array<{
        artifact_id: string;
        configuration_id: string;
        source_class: CampaignAssuranceSourceClass;
      }>;
    };
    source_classes: CampaignAssuranceSourceClass[];
  };
  applicability: {
    applicable_to_frozen_snapshot: boolean;
    freshness: "frozen_snapshot_current" | "stale" | "cancelled";
    basis: string;
  };
}

export interface CampaignAssuranceExtraction {
  id: string;
  receipt_hash: string;
  source_class: CampaignAssuranceSourceClass;
  status: "complete" | "error" | "unavailable";
  model_provider: string;
  model_id: string;
  model_version: string;
  model_cache_key?: string;
  model_input_manifest_hash?: string;
  model_invocation_id?: string;
  execution_kind?: "invoked" | "cache_reuse";
  reused_from_extraction_id?: string;
  reused_from_receipt_hash?: string;
  reused_original_cost_microunits?: number;
  error_code?: string;
  error_message?: string;
}

export interface CampaignAssuranceFinding {
  id: string;
  receipt_hash: string;
  code: string;
  source_class: CampaignAssuranceSourceClass;
  severity: string;
  blocking: boolean;
  overridable: boolean;
  dimension: string;
  explanation: string;
  remediation: unknown;
  typed_patch?: unknown;
}

export interface CampaignAssuranceOverride {
  id: string;
  finding_id: string;
  decision: "allow_send" | "reject";
  reason: string;
  expires_at?: string;
  created_at: string;
}

export interface CampaignAssuranceEvidence {
  run: CampaignAssuranceRun;
  source_classes: CampaignAssuranceSourceClass[];
  extractions: {
    items: CampaignAssuranceExtraction[];
    total: number;
    next_offset?: number;
  };
  findings: {
    items: CampaignAssuranceFinding[];
    total: number;
    next_offset?: number;
  };
  overrides: {
    items: CampaignAssuranceOverride[];
    total: number;
    next_offset?: number;
  };
}

export interface CampaignContentRevision {
  id: string;
  campaign_id: string;
  revision_no: number;
  source_mode: string;
  content_schema_version: number;
  fact_contract: unknown;
  source_hash: string;
  created_at: string;
}

export interface CampaignAssurancePatchApplication {
  application: unknown;
  revision: CampaignContentRevision;
  campaign_etag: string;
  originating_run_state: "stale";
  rerun_required: true;
}

export interface CampaignAssuranceStartRun {
  run_id: string;
  campaign_id: string;
  content_revision_id: string;
  send_plan_id: string;
  request_id: string;
  profile: "fast" | "full" | "calibration";
  state: CampaignAssuranceRun["state"];
  required_scenario_count: number;
  required_extraction_count: number;
  status_url: string;
  evidence_url: string;
  events_url: string;
}

export function startCurrentCampaignAssurance(
  campaignId: string,
  profile: "fast" | "full" | "calibration" = "full",
): Promise<ApiResult<CampaignAssuranceEnvelope<CampaignAssuranceStartRun>>> {
  return apiRequest(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/assurance-runs`,
    {
      method: "POST",
      body: JSON.stringify({ profile, request_id: newUUIDv7() }),
    },
    { requireOnline: true, maxAttempts: 3 },
  );
}

export function getLatestCampaignAssurance(
  campaignId: string,
): Promise<ApiResult<CampaignAssuranceEnvelope<CampaignAssuranceLatest>>> {
  return apiRequest(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/assurance`,
  );
}

export function getCampaignAssuranceEvidence(
  campaignId: string,
  runId: string,
  offset = 0,
): Promise<ApiResult<CampaignAssuranceEnvelope<CampaignAssuranceEvidence>>> {
  return apiRequest(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/assurance-runs/${encodeURIComponent(runId)}/evidence?limit=200&offset=${offset}`,
  );
}

export function getCampaignContentRevision(
  campaignId: string,
  revisionId: string,
): Promise<ApiResult<CampaignContentRevision>> {
  return apiRequest(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/content-revisions/${encodeURIComponent(revisionId)}`,
  );
}

export function overrideCampaignAssuranceFinding(
  campaignId: string,
  runId: string,
  findingId: string,
  input: { decision: "allow_send" | "reject"; reason: string },
): Promise<ApiResult<CampaignAssuranceEnvelope<CampaignAssuranceOverride>>> {
  return apiRequest(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/assurance-runs/${encodeURIComponent(runId)}/findings/${encodeURIComponent(findingId)}/overrides`,
    {
      method: "POST",
      body: JSON.stringify({ request_id: newUUIDv7(), ...input }),
    },
    { requireOnline: true, maxAttempts: 1 },
  );
}

export async function applyCampaignAssuranceFinding(
  campaignId: string,
  runId: string,
  findingId: string,
  campaignETag: string,
): Promise<
  ApiResult<CampaignAssuranceEnvelope<CampaignAssurancePatchApplication>>
> {
  if (!isExactStrongCampaignETag(campaignETag)) {
    return {
      error: {
        kind: "invalid_config",
        code: "campaign_etag_required",
        message:
          "A strong campaign ETag captured with the held campaign is required.",
      },
      retryability: "not-retryable",
    };
  }
  // The request UUID is created once, before the shared transport makes its
  // bounded attempts. apiRequest likewise mints one Idempotency-Key and reuses
  // it for all three attempts and a possible step-up replay.
  const requestId = newUUIDv7();
  const result = await apiRequest<
    CampaignAssuranceEnvelope<CampaignAssurancePatchApplication>
  >(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/assurance-runs/${encodeURIComponent(runId)}/findings/${encodeURIComponent(findingId)}/apply`,
    {
      method: "POST",
      headers: { "If-Match": campaignETag },
      body: JSON.stringify({ request_id: requestId }),
    },
    { requireOnline: true, maxAttempts: 3 },
  );
  if (result.error) return result;

  const applied = result.data.data;
  const expectedLocation = campaignRevisionLocation(
    campaignId,
    applied.revision?.id,
  );
  if (
    !isExactStrongCampaignETag(result.serverVersion) ||
    result.serverVersion !== applied.campaign_etag ||
    applied.originating_run_state !== "stale" ||
    applied.rerun_required !== true ||
    !expectedLocation ||
    result.responseLocation !== expectedLocation
  ) {
    return {
      error: {
        kind: "parse",
        code: "campaign_assurance_apply_provenance_invalid",
        message:
          "The repair acknowledgement omitted a matching ETag or revision Location.",
      },
      retryability: "not-retryable",
    };
  }
  return result;
}

export const ASSURANCE_SOURCE_LABELS = {
  deterministic: "Deterministic",
  modeled: "Modeled prediction",
  controlled_observation: "Controlled observation",
  unavailable: "Unavailable evidence",
} as const;

export function remediationSummary(remediation: unknown): string {
  if (typeof remediation === "string" && remediation.trim()) {
    return remediation.trim();
  }
  if (!record(remediation)) return "Review the cited content and finding.";
  for (const key of ["description", "message", "instruction", "kind"]) {
    const value = remediation[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const field = text(remediation.field);
  const representation = text(remediation.representation);
  return field || representation
    ? `Update ${[representation, field].filter(Boolean).join(" / ")}.`
    : "Review the cited content and finding.";
}

export function factContractSummary(contract: unknown): {
  available: boolean;
  intent: string;
  claim: string;
  action: string;
  facts: string[];
} {
  if (!record(contract) || Object.keys(contract).length === 0) {
    return { available: false, intent: "", claim: "", action: "", facts: [] };
  }
  const intent = record(contract.primary_intent)
    ? text(contract.primary_intent.statement)
    : "";
  const claim = record(contract.core_claim)
    ? text(contract.core_claim.statement)
    : "";
  const action = record(contract.primary_action)
    ? text(contract.primary_action.label)
    : "";
  const facts = Array.isArray(contract.required_facts)
    ? contract.required_facts.flatMap((fact) =>
        record(fact)
          ? [
              `${text(fact.display_value) || text(fact.id) || "Required fact"} (${text(fact.criticality) || "unspecified"})`,
            ]
          : [],
      )
    : [];
  return {
    available: Boolean(intent && claim && action),
    intent,
    claim,
    action,
    facts,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isExactStrongCampaignETag(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (new TextEncoder().encode(value).byteLength > 512) return false;
  return /^"[^,\u0000-\u001f\u007f-\u009f]+"$/.test(value);
}

function campaignRevisionLocation(
  campaignId: string,
  revisionId: string | undefined,
): string | null {
  if (!revisionId) return null;
  return `/api/v1/campaigns/${encodeURIComponent(campaignId)}/content-revisions/${encodeURIComponent(revisionId)}`;
}
