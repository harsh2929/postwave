// SPDX-License-Identifier: AGPL-3.0-only

import { formatErrorMessage } from "@postwave/errors";

import { api, ApiError, apiErrorMessage } from "./api";
import {
  discardCampaignETag,
  isExactStrongCampaignETag,
} from "./campaigns-api";
import { newUUIDv7 } from "./http-fetch";

/**
 * The API's answer, on every assurance route, when the deployment runs
 * without the Campaign Assurance runtime. It is a state of the environment,
 * not a failure: retrying cannot change it, and with the runtime off no send
 * waits on an assurance receipt (the send gate refuses to start otherwise).
 */
export const CAMPAIGN_ASSURANCE_NOT_ENABLED = "campaign_assurance_not_enabled";

export function isCampaignAssuranceNotEnabled(error: unknown): boolean {
  return (
    error instanceof ApiError && error.code === CAMPAIGN_ASSURANCE_NOT_ENABLED
  );
}

/**
 * The dashboard's words for the assurance routes' "unavailable" answers. The
 * API's own messages address API clients — they name request_id and
 * Idempotency-Key, or how the deployment is configured — so the panel says
 * what the person in front of it can do instead.
 */
const UNAVAILABLE_COPY: Readonly<Record<string, string>> = {
  campaign_assurance_unavailable:
    "Campaign Assurance is temporarily unavailable. Try again in a few seconds.",
  campaign_assurance_metering_unavailable:
    "Campaign Assurance runs aren't available in this environment.",
  campaign_assurance_remediation_unavailable:
    "Automatic repairs aren't available in this environment.",
};

/** `apiErrorMessage`, with the assurance "unavailable" answers in UI copy. */
export function campaignAssuranceErrorMessage(
  error: unknown,
  fallback: string,
): string {
  if (error instanceof ApiError) {
    const copy = UNAVAILABLE_COPY[error.code];
    // Same shape as every other API error: the request id stays for support.
    if (copy) return formatErrorMessage(copy, error.requestId, fallback);
  }
  return apiErrorMessage(error, fallback);
}

export type CampaignAssuranceSourceClass =
  | "deterministic"
  | "modeled"
  | "controlled_observation";

export type CampaignAssuranceRunState =
  | "queued"
  | "running"
  | "complete"
  | "incomplete"
  | "failed"
  | "cancelled"
  | "stale";

export type CampaignAssuranceGateDecision =
  | "pending"
  | "pass"
  | "warn"
  | "block"
  | "unavailable";

export interface CampaignAssuranceSourceDisclosure {
  class: CampaignAssuranceSourceClass;
  present: boolean;
  meaning: string;
}

export interface CampaignAssuranceMeasurement {
  name: "Predicted Agent Comprehension";
  interpretation: string;
  source_classes: CampaignAssuranceSourceDisclosure[];
}

export interface CampaignAssuranceEnvelope<T> {
  measurement: CampaignAssuranceMeasurement;
  data: T;
}

export interface CampaignAssuranceRun {
  id: string;
  campaign_id: string;
  content_revision_id: string;
  send_plan_id: string;
  run_no: number;
  profile: "fast" | "full" | "calibration";
  state: CampaignAssuranceRunState;
  source_hash: string;
  plan_hash: string;
  artifact_set_hash: string;
  coverage_manifest_hash: string;
  configuration_manifest_hash: string;
  target_manifest_hash: string;
  renderer_version: string;
  compiler_version: string;
  analyzer_suite_version: string;
  model_suite_version: string;
  prompt_suite_version: string;
  normalization_version: string;
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
  score_spread: number | null;
  agreement: number | null;
  gate_decision: CampaignAssuranceGateDecision;
  input_tokens?: number;
  output_tokens?: number;
  cost_microunits?: number;
  max_modeled_cost_microunits?: number;
  latency_ms?: number;
  error_code?: string;
  error_message?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

export interface CampaignAssuranceRunArtifact {
  artifact_id: string;
  ordinal: number;
  scenario_id: string;
  outbound_mime_hash: string;
  mime_structure_hash: string;
}

export interface CampaignAssuranceManifest {
  run: CampaignAssuranceRun;
  artifacts: CampaignAssuranceRunArtifact[];
  configurations: Array<{
    configuration_id: string;
    source_class: CampaignAssuranceSourceClass;
    configuration_hash: string;
  }>;
  targets: Array<{
    artifact_id: string;
    configuration_id: string;
    source_class: CampaignAssuranceSourceClass;
    configuration_hash: string;
    outbound_mime_hash: string;
  }>;
}

export interface CampaignAssuranceLatest {
  detail: {
    run: CampaignAssuranceRun;
    manifest: CampaignAssuranceManifest;
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
  artifact_id: string;
  configuration_id: string;
  source_class: CampaignAssuranceSourceClass;
  status: "complete" | "error" | "unavailable";
  model_provider: string;
  model_id: string;
  model_version: string;
  prompt_version: string;
  prompt_hash: string;
  model_cache_key?: string;
  model_input_manifest_hash?: string;
  model_invocation_id?: string;
  execution_kind?: "invoked" | "cache_reuse";
  reused_from_extraction_id?: string;
  reused_from_receipt_hash?: string;
  reused_original_cost_microunits?: number;
  error_code?: string;
  error_message?: string;
  created_at: string;
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
  created_at: string;
}

export interface CampaignAssuranceOverride {
  id: string;
  finding_id: string;
  finding_receipt_hash: string;
  actor_role: string;
  decision: "allow_send" | "reject";
  reason: string;
  expires_at?: string;
  created_at: string;
}

export interface CampaignAssurancePage<T> {
  items: T[];
  offset: number;
  limit: number;
  total: number;
  next_offset?: number;
}

export interface CampaignAssuranceEvidence {
  run: CampaignAssuranceRun;
  source_classes: CampaignAssuranceSourceClass[];
  extractions: CampaignAssurancePage<CampaignAssuranceExtraction>;
  findings: CampaignAssurancePage<CampaignAssuranceFinding>;
  overrides: CampaignAssurancePage<CampaignAssuranceOverride>;
}

export interface CampaignContentRevision {
  id: string;
  campaign_id: string;
  revision_no: number;
  source_mode: "semantic" | "legacy_html" | string;
  content_schema_version: number;
  subject: string;
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

export interface CampaignAssuranceApplyResult {
  receipt: CampaignAssuranceEnvelope<CampaignAssurancePatchApplication>;
  campaignETag: string;
  location: string;
}

export interface CampaignAssuranceStartRun {
  run_id: string;
  campaign_id: string;
  content_revision_id: string;
  send_plan_id: string;
  request_id: string;
  profile: "fast" | "full" | "calibration";
  state: CampaignAssuranceRunState;
  required_scenario_count: number;
  required_extraction_count: number;
  status_url: string;
  evidence_url: string;
  events_url: string;
}

/**
 * Freezes the current draft, compiles the complete server-owned scenario set,
 * materializes its exact artifacts, and starts one durable run. The client
 * supplies no revision, plan, compiler, prompt, or artifact identities.
 */
export function startCurrentCampaignAssurance(
  campaignId: string,
  profile: "fast" | "full" | "calibration" = "full",
): Promise<CampaignAssuranceEnvelope<CampaignAssuranceStartRun>> {
  return api.post(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/assurance-runs`,
    { profile, request_id: newUUIDv7() },
    { requireOnline: true, maxAttempts: 3 },
  );
}

export function getLatestCampaignAssurance(
  campaignId: string,
): Promise<CampaignAssuranceEnvelope<CampaignAssuranceLatest>> {
  return api.get(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/assurance`,
  );
}

export function getCampaignAssuranceEvidence(
  campaignId: string,
  runId: string,
  offset = 0,
): Promise<CampaignAssuranceEnvelope<CampaignAssuranceEvidence>> {
  return api.get(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/assurance-runs/${encodeURIComponent(runId)}/evidence?limit=200&offset=${offset}`,
  );
}

export function getCampaignContentRevision(
  campaignId: string,
  revisionId: string,
): Promise<CampaignContentRevision> {
  return api.get(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/content-revisions/${encodeURIComponent(revisionId)}`,
  );
}

export function overrideCampaignAssuranceFinding(
  campaignId: string,
  runId: string,
  findingId: string,
  input: {
    decision: "allow_send" | "reject";
    reason: string;
    expires_at?: string;
  },
): Promise<CampaignAssuranceEnvelope<CampaignAssuranceOverride>> {
  return api.post(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/assurance-runs/${encodeURIComponent(runId)}/findings/${encodeURIComponent(findingId)}/overrides`,
    { request_id: newUUIDv7(), ...input },
    { requireOnline: true },
  );
}

export async function applyCampaignAssuranceFinding(
  campaignId: string,
  runId: string,
  findingId: string,
  campaignETag: string,
): Promise<CampaignAssuranceApplyResult> {
  if (!isExactStrongCampaignETag(campaignETag)) {
    throw new Error(
      "A strong campaign ETag captured with the held campaign is required.",
    );
  }
  let responseETag = "";
  let location: string | null = null;
  try {
    // The body identity is minted once, and the shared transport mints one
    // Idempotency-Key for this call. Its three bounded wire attempts and a
    // possible step-up replay reuse both identities verbatim.
    const receipt = await api.post<
      CampaignAssuranceEnvelope<CampaignAssurancePatchApplication>
    >(
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/assurance-runs/${encodeURIComponent(runId)}/findings/${encodeURIComponent(findingId)}/apply`,
      { request_id: newUUIDv7() },
      {
        requireOnline: true,
        headers: { "If-Match": campaignETag },
        maxAttempts: 3,
        onResponse: (response) => {
          responseETag = response.headers.get("ETag") ?? "";
          location = response.headers.get("Location");
        },
      },
    );
    const expectedLocation = campaignRevisionLocation(
      campaignId,
      receipt.data.revision?.id,
    );
    if (
      !isExactStrongCampaignETag(responseETag) ||
      responseETag !== receipt.data.campaign_etag ||
      receipt.data.originating_run_state !== "stale" ||
      receipt.data.rerun_required !== true ||
      !expectedLocation ||
      typeof location !== "string" ||
      location !== expectedLocation
    ) {
      throw new CampaignAssuranceApplyProvenanceError();
    }
    return {
      receipt,
      campaignETag: responseETag,
      location,
    };
  } finally {
    // Success, 412, and an ambiguous transport failure all make the held
    // representation unsafe for another governed repair until a fresh GET.
    discardCampaignETag(campaignId);
  }
}

export class CampaignAssuranceApplyProvenanceError extends Error {
  readonly code = "campaign_assurance_apply_provenance_invalid";

  constructor() {
    super(
      "Campaign Assurance apply response omitted matching ETag or revision location provenance.",
    );
    this.name = "CampaignAssuranceApplyProvenanceError";
  }
}

export const CAMPAIGN_ASSURANCE_SOURCE_LABELS = {
  deterministic: "Deterministic",
  modeled: "Modeled prediction",
  controlled_observation: "Controlled observation",
  unavailable: "Unavailable evidence",
} as const;

export function remediationSummary(remediation: unknown): string {
  if (typeof remediation === "string" && remediation.trim()) {
    return remediation.trim();
  }
  if (!isRecord(remediation)) return "Review the cited content and finding.";
  for (const key of ["description", "message", "instruction", "kind"]) {
    const value = remediation[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const field = typeof remediation["field"] === "string" ? remediation["field"] : "";
  const representation =
    typeof remediation["representation"] === "string"
      ? remediation["representation"]
      : "";
  if (field || representation) {
    return `Update ${[representation, field].filter(Boolean).join(" / ")}.`;
  }
  return "Review the cited content and finding.";
}

export function factContractSummary(contract: unknown): {
  available: boolean;
  intent: string;
  claim: string;
  action: string;
  facts: Array<{ id: string; value: string; criticality: string }>;
} {
  if (!isRecord(contract) || Object.keys(contract).length === 0) {
    return { available: false, intent: "", claim: "", action: "", facts: [] };
  }
  const intent = isRecord(contract["primary_intent"])
    ? text(contract["primary_intent"]["statement"])
    : "";
  const claim = isRecord(contract["core_claim"])
    ? text(contract["core_claim"]["statement"])
    : "";
  const action = isRecord(contract["primary_action"])
    ? text(contract["primary_action"]["label"])
    : "";
  const facts = Array.isArray(contract["required_facts"])
    ? contract["required_facts"].flatMap((item) => {
        if (!isRecord(item)) return [];
        return [
          {
            id: text(item["id"]) || "Required fact",
            value: text(item["display_value"]),
            criticality: text(item["criticality"]) || "unspecified",
          },
        ];
      })
    : [];
  return {
    available: Boolean(intent && claim && action),
    intent,
    claim,
    action,
    facts,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function campaignRevisionLocation(
  campaignId: string,
  revisionId: string | undefined,
): string | null {
  if (!revisionId) return null;
  return `/api/v1/campaigns/${encodeURIComponent(campaignId)}/content-revisions/${encodeURIComponent(revisionId)}`;
}
