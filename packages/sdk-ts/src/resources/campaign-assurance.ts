// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";
import type { Campaign } from "./campaigns.js";

export type FactContractIntentKind =
  | "inform"
  | "invite"
  | "promote"
  | "request_action"
  | "remind"
  | "survey"
  | "transact"
  | "onboard"
  | "retain"
  | "other";

export type FactContractPrimaryActionRole =
  | "navigate"
  | "register"
  | "purchase"
  | "rsvp"
  | "confirm"
  | "download"
  | "survey"
  | "reply"
  | "track";

export type FactContractSecondaryActionRole =
  | "unsubscribe"
  | "preferences"
  | "view_in_browser"
  | "social"
  | "legal"
  | "share"
  | "contact"
  | "reply";

export type FactContractFactType =
  | "text"
  | "datetime"
  | "money"
  | "location"
  | "code"
  | "percentage"
  | "quantity"
  | "url";

export type FactContractCriticality = "critical" | "important" | "supporting";

export interface FactContractDateTimeValueV1 {
  rfc3339: string;
  timezone: string;
}

export interface FactContractMoneyValueV1 {
  amount: string;
  currency: string;
}

export interface FactContractNumberValueV1 {
  value: string;
  unit?: string;
}

export interface FactContractRequiredFactV1 {
  id: string;
  type: FactContractFactType;
  display_value: string;
  criticality: FactContractCriticality;
  source_block_ids: string[];
  text_value?: string;
  datetime_value?: FactContractDateTimeValueV1;
  money_value?: FactContractMoneyValueV1;
  number_value?: FactContractNumberValueV1;
  url_value?: string;
}

/** Sender-authored expected-output oracle. It never represents inbox observation. */
export interface FactContractV1 {
  schema_version: 1;
  primary_intent: {
    kind: FactContractIntentKind;
    statement: string;
  };
  audience_context: {
    description: string;
    targeting_reference?: string;
  };
  core_claim: {
    statement: string;
    source_block_ids?: string[];
  };
  primary_action: {
    action_id: string;
    block_id: string;
    role: FactContractPrimaryActionRole;
    label: string;
    canonical_url?: string;
  };
  required_facts: FactContractRequiredFactV1[];
  forbidden_claims: Array<{ id: string; statement: string }>;
  allowed_secondary_actions: FactContractSecondaryActionRole[];
  language: string;
}

export type FactContractV1OrEmpty = FactContractV1 | Record<string, never>;

export interface SetFactContractOptions extends CampaignAssuranceMutationOptions {
  /** Exact strong campaign ETag returned by the version being edited. */
  ifMatch: string;
}

export interface SetFactContractResult {
  campaign: Campaign;
  /** New strong campaign ETag for the next conditional authoring write. */
  etag: string;
}

/** Server-owned assurance suite selected by a caller. */
export type CampaignAssuranceProfile = "fast" | "full" | "calibration";

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

export type CampaignAssuranceExtractionStatus =
  | "complete"
  | "error"
  | "unavailable";

export type CampaignAssuranceAppealDecision = "allow_send" | "reject";

export interface CampaignAssuranceSourceDisclosure {
  class: CampaignAssuranceSourceClass;
  present: boolean;
  meaning: string;
}

/**
 * Provenance attached to every Campaign Assurance success response.
 * `modeled` is a prediction, not an observation of a provider's private inbox.
 */
export interface CampaignAssuranceMeasurement {
  name: "Predicted Agent Comprehension";
  interpretation: string;
  source_classes: CampaignAssuranceSourceDisclosure[];
}

export interface CampaignAssuranceEnvelope<T> {
  measurement: CampaignAssuranceMeasurement;
  data: T;
}

export interface CreateCampaignAssuranceRunInput {
  profile: CampaignAssuranceProfile;
  /** Exact existing revision. Omit to freeze the current draft server-side. */
  content_revision_id?: string;
  /** Existing ready plan. Requires content_revision_id; omit for server-owned compilation. */
  send_plan_id?: string;
  /** Stable UUID identifying this logical run request. */
  request_id: string;
  /** Request named controlled seed observation; unavailable until an adapter is configured. */
  include_seed_test?: boolean;
  /** Stable adapter surface ids; valid only with include_seed_test=true. */
  observed_surfaces?: string[];
}

export interface CampaignAssuranceMutationOptions {
  /**
   * Stable key for an exact retry across processes. If omitted, the SDK mints
   * one key and reuses it for its own transport retries.
   */
  idempotencyKey?: string;
}

export interface CampaignAssuranceApplyOptions extends CampaignAssuranceMutationOptions {
  /** Exact strong campaign ETag returned by the draft version the editor reviewed. */
  ifMatch: string;
}

export interface CampaignAssuranceStartRun {
  run_id: string;
  campaign_id: string;
  content_revision_id: string;
  send_plan_id: string;
  request_id: string;
  profile: CampaignAssuranceProfile;
  state: CampaignAssuranceRunState;
  required_scenario_count: number;
  required_extraction_count: number;
  status_url: string;
  evidence_url: string;
  events_url: string;
}

export interface CampaignAssuranceRun {
  id: string;
  campaign_id: string;
  content_revision_id: string;
  send_plan_id: string;
  run_no: number;
  request_id: string;
  request_hash: string;
  trigger_kind: string;
  profile: CampaignAssuranceProfile;
  state: CampaignAssuranceRunState;
  source_hash: string;
  plan_hash: string;
  artifact_set_hash: string;
  coverage_manifest_hash: string;
  configuration_manifest_hash: string;
  target_manifest_hash: string;
  renderer_version: string;
  compiler_version: string;
  fixture_set_version: string;
  plan_policy_version: string;
  analyzer_suite_version: string;
  model_suite_version: string;
  prompt_suite_version: string;
  prompt_suite_hash: string;
  normalization_version: string;
  scoring_version: string;
  gate_policy_version: string;
  methodology_version: string;
  required_scenario_count: number;
  required_configuration_count: number;
  required_extraction_count: number;
  terminal_extraction_count: number;
  successful_extraction_count: number;
  extraction_error_count: number;
  finding_count: number;
  blocking_finding_count: number;
  component_scores?: unknown;
  overall_score: number | null;
  score_min: number | null;
  score_max: number | null;
  score_spread: number | null;
  agreement: number | null;
  gate_decision: CampaignAssuranceGateDecision;
  input_tokens: number;
  output_tokens: number;
  cost_microunits: number;
  max_modeled_cost_microunits: number;
  latency_ms: number;
  snapshot_frozen_at?: string;
  lease_expires_at?: string;
  heartbeat_at?: string;
  attempt_count: number;
  max_attempts: number;
  retry_not_before?: string;
  error_code?: string;
  error_message?: string;
  created_by?: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  cancelled_at?: string;
  stale_at?: string;
  updated_at: string;
}

export interface CampaignAssuranceRunArtifact {
  campaign_id: string;
  run_id: string;
  send_plan_id: string;
  artifact_id: string;
  ordinal: number;
  scenario_id: string;
  outbound_mime_hash: string;
  mime_structure_hash: string;
  snapshotted_at: string;
}

export interface CampaignAssuranceRunConfiguration {
  campaign_id: string;
  run_id: string;
  ordinal: number;
  configuration_id: string;
  source_class: CampaignAssuranceSourceClass;
  configuration_hash: string;
  configuration: Record<string, unknown>;
  snapshotted_at: string;
}

export interface CampaignAssuranceRunTarget {
  campaign_id: string;
  run_id: string;
  send_plan_id: string;
  artifact_id: string;
  configuration_id: string;
  ordinal: number;
  source_class: CampaignAssuranceSourceClass;
  configuration_hash: string;
  outbound_mime_hash: string;
  snapshotted_at: string;
}

export interface CampaignAssuranceManifest {
  run: CampaignAssuranceRun;
  artifacts: CampaignAssuranceRunArtifact[];
  configurations: CampaignAssuranceRunConfiguration[];
  targets: CampaignAssuranceRunTarget[];
}

export interface CampaignAssuranceRunDetail {
  run: CampaignAssuranceRun;
  manifest: CampaignAssuranceManifest;
  source_classes: CampaignAssuranceSourceClass[];
}

export interface CampaignAssuranceApplicability {
  applicable_to_frozen_snapshot: boolean;
  freshness: "frozen_snapshot_current" | "stale" | "cancelled";
  basis: string;
}

export interface CampaignAssuranceLatest {
  detail: CampaignAssuranceRunDetail;
  applicability: CampaignAssuranceApplicability;
}

export interface CampaignAssuranceExtraction {
  id: string;
  campaign_id: string;
  run_id: string;
  send_plan_id: string;
  attempt_count: number;
  receipt_hash: string;
  artifact_id: string;
  configuration_id: string;
  source_class: CampaignAssuranceSourceClass;
  configuration_hash: string;
  outbound_mime_hash: string;
  status: CampaignAssuranceExtractionStatus;
  normalized_extraction?: unknown;
  evidence_manifest: unknown;
  unsupported_claims: unknown;
  ambiguities: unknown;
  raw_output_object_ref?: string;
  raw_output_hash?: string;
  raw_output_expires_at?: string;
  model_provider: string;
  model_id: string;
  model_version: string;
  prompt_version: string;
  prompt_hash: string;
  seed_value?: string;
  temperature?: number;
  input_tokens: number;
  output_tokens: number;
  cost_microunits: number;
  latency_ms: number;
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
  campaign_id: string;
  run_id: string;
  send_plan_id: string;
  attempt_count: number;
  configuration_hash: string;
  outbound_mime_hash: string;
  finding_key: string;
  receipt_hash: string;
  artifact_id: string;
  configuration_id: string;
  extraction_id?: string;
  code: string;
  source_class: CampaignAssuranceSourceClass;
  severity: string;
  blocking: boolean;
  overridable: boolean;
  dimension: string;
  block_references: unknown;
  evidence_references: unknown;
  expected_value?: unknown;
  observed_value?: unknown;
  explanation: string;
  remediation: unknown;
  typed_patch?: unknown;
  typed_patch_schema_version?: number;
  detector_version: string;
  policy_version: string;
  created_at: string;
}

export interface CampaignAssuranceOverride {
  id: string;
  campaign_id: string;
  run_id: string;
  attempt_count: number;
  finding_id: string;
  finding_receipt_hash: string;
  request_id: string;
  request_hash: string;
  artifact_set_hash: string;
  actor_id: string;
  actor_role: string;
  decision: CampaignAssuranceAppealDecision;
  reason: string;
  expires_at?: string;
  created_at: string;
}

export interface CampaignAssuranceApplyFindingInput {
  /** Stable UUID identifying this exact logical patch application. */
  request_id: string;
}

/** Append-only receipt for the server-owned typed patch that was applied. */
export interface CampaignAssurancePatchApplication {
  id: string;
  campaign_id: string;
  run_id: string;
  attempt_count: number;
  finding_id: string;
  request_id: string;
  request_hash: string;
  finding_receipt_hash: string;
  typed_patch_hash: string;
  typed_patch_schema_version: 1;
  base_content_revision_id: string;
  created_content_revision_id: string;
  actor_id: string;
  /** Post-application campaign timestamp retained for exact replay ETags. */
  campaign_updated_at: string;
  created_at: string;
}

/** New immutable campaign content revision created by applying the finding. */
export interface CampaignAssuranceAppliedRevision {
  id: string;
  campaign_id: string;
  revision_no: number;
  source_mode: "semantic" | "legacy_html";
  content_schema_version: number;
  subject: string;
  preview_text?: string;
  semantic_tree: unknown;
  legacy_html?: string;
  reviewed_plain_text?: string;
  fact_contract: unknown;
  variants: unknown;
  locales: unknown;
  source_hash: string;
  created_by?: string;
  created_at: string;
}

export interface CampaignAssuranceApplyFindingResult {
  application: CampaignAssurancePatchApplication;
  revision: CampaignAssuranceAppliedRevision;
  campaign_etag: string;
  originating_run_state: "stale";
  rerun_required: true;
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

export interface CampaignAssuranceEvidenceParams {
  /** 1..200; defaults to 100. */
  limit?: number;
  /** 0..100000; defaults to 0. */
  offset?: number;
}

/**
 * Current aggregate state returned from the `/events` route. The backend does
 * not currently expose durable event history or an SSE stream on this route.
 */
export interface CampaignAssuranceProgressSnapshot {
  run_id: string;
  state: CampaignAssuranceRunState;
  gate_decision: CampaignAssuranceGateDecision;
  attempt_count: number;
  required_extractions: number;
  terminal_extractions: number;
  successful_extractions: number;
  extraction_errors: number;
  finding_count: number;
  blocking_finding_count: number;
  updated_at: string;
  completed_at?: string;
  event_history_available: false;
  event_history_explanation: string;
  source_classes: CampaignAssuranceSourceClass[];
}

export interface CampaignAssuranceAppealInput {
  /** Stable UUID identifying this logical governed decision. */
  request_id: string;
  decision: CampaignAssuranceAppealDecision;
  /** Governed rationale; the API requires 10..2000 Unicode characters. */
  reason: string;
  expires_at?: string;
}

/**
 * Immutable Campaign Assurance runs, governed decisions, and conditional
 * applications of server-stored deterministic remediations.
 *
 * Read calls require `read:campaigns`; run creation and cancellation require
 * `write:campaigns`; applying a stored patch also requires an editor and an
 * exact strong campaign ETag. Appeals/overrides require both `write:campaigns` and
 * `send:transactional` plus an owner/admin actor bound to the tenant.
 */
export class CampaignAssuranceResource extends Resource {
  /**
   * Replace the mutable draft's complete Fact Contract. Pass `{}` only to
   * explicitly clear it. The API normalizes and validates the closed v1 shape.
   */
  async setFactContract(
    campaignId: string,
    contract: FactContractV1OrEmpty,
    options: SetFactContractOptions,
  ): Promise<SetFactContractResult> {
    let etag = "";
    const campaign = await this.client.request<Campaign>(
      "PUT",
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/fact-contract`,
      {
        body: contract,
        idempotencyKey: options.idempotencyKey,
        headers: { "If-Match": campaignAssuranceIfMatch(options.ifMatch) },
        onResponseHeaders: (headers) => {
          etag = headers.get("etag") ?? "";
        },
      },
    );
    etag = campaignAssuranceIfMatch(etag);
    return { campaign, etag };
  }

  createRun(
    campaignId: string,
    input: CreateCampaignAssuranceRunInput,
    options: CampaignAssuranceMutationOptions = {},
  ): Promise<CampaignAssuranceEnvelope<CampaignAssuranceStartRun>> {
    validateCreateRunObservationRequest(input);
    return this.client.request(
      "POST",
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/assurance-runs`,
      { body: input, idempotencyKey: options.idempotencyKey },
    );
  }

  getLatest(
    campaignId: string,
  ): Promise<CampaignAssuranceEnvelope<CampaignAssuranceLatest>> {
    return this.client.request(
      "GET",
      `/api/v1/campaigns/${encodeURIComponent(campaignId)}/assurance`,
    );
  }

  getRun(
    campaignId: string,
    runId: string,
  ): Promise<CampaignAssuranceEnvelope<CampaignAssuranceRunDetail>> {
    return this.client.request("GET", `${runPath(campaignId, runId)}`);
  }

  getManifest(
    campaignId: string,
    runId: string,
  ): Promise<CampaignAssuranceEnvelope<CampaignAssuranceManifest>> {
    return this.client.request("GET", `${runPath(campaignId, runId)}/manifest`);
  }

  getEvidence(
    campaignId: string,
    runId: string,
    params: CampaignAssuranceEvidenceParams = {},
  ): Promise<CampaignAssuranceEnvelope<CampaignAssuranceEvidence>> {
    return this.client.request(
      "GET",
      `${runPath(campaignId, runId)}/evidence`,
      {
        query: params as Record<string, number | undefined>,
      },
    );
  }

  /** Returns the current snapshot; `event_history_available` is currently false. */
  getEvents(
    campaignId: string,
    runId: string,
  ): Promise<CampaignAssuranceEnvelope<CampaignAssuranceProgressSnapshot>> {
    return this.client.request("GET", `${runPath(campaignId, runId)}/events`);
  }

  appealFinding(
    campaignId: string,
    runId: string,
    findingId: string,
    input: CampaignAssuranceAppealInput,
    options: CampaignAssuranceMutationOptions = {},
  ): Promise<CampaignAssuranceEnvelope<CampaignAssuranceOverride>> {
    return this.client.request(
      "POST",
      `${findingPath(campaignId, runId, findingId)}/appeals`,
      { body: input, idempotencyKey: options.idempotencyKey },
    );
  }

  /** Compatibility spelling for the same governed decision contract. */
  overrideFinding(
    campaignId: string,
    runId: string,
    findingId: string,
    input: CampaignAssuranceAppealInput,
    options: CampaignAssuranceMutationOptions = {},
  ): Promise<CampaignAssuranceEnvelope<CampaignAssuranceOverride>> {
    return this.client.request(
      "POST",
      `${findingPath(campaignId, runId, findingId)}/overrides`,
      { body: input, idempotencyKey: options.idempotencyKey },
    );
  }

  /**
   * Apply the exact server-stored deterministic patch as a new immutable
   * revision. The caller cannot supply patch instructions. The returned
   * revision requires a new Campaign Assurance run.
   */
  applyFinding(
    campaignId: string,
    runId: string,
    findingId: string,
    input: CampaignAssuranceApplyFindingInput,
    options: CampaignAssuranceApplyOptions,
  ): Promise<CampaignAssuranceEnvelope<CampaignAssuranceApplyFindingResult>> {
    return this.client.request(
      "POST",
      `${findingPath(campaignId, runId, findingId)}/apply`,
      {
        // Deliberately project the closed public body so a value originating
        // in untyped JavaScript cannot smuggle patch instructions.
        body: { request_id: input.request_id },
        idempotencyKey: options.idempotencyKey,
        headers: { "If-Match": campaignAssuranceIfMatch(options.ifMatch) },
      },
    );
  }

  cancelRun(
    campaignId: string,
    runId: string,
    options: CampaignAssuranceMutationOptions = {},
  ): Promise<CampaignAssuranceEnvelope<CampaignAssuranceRun>> {
    return this.client.request("POST", `${runPath(campaignId, runId)}/cancel`, {
      idempotencyKey: options.idempotencyKey,
    });
  }
}

function runPath(campaignId: string, runId: string): string {
  return `/api/v1/campaigns/${encodeURIComponent(campaignId)}/assurance-runs/${encodeURIComponent(runId)}`;
}

function findingPath(
  campaignId: string,
  runId: string,
  findingId: string,
): string {
  return `${runPath(campaignId, runId)}/findings/${encodeURIComponent(findingId)}`;
}

function campaignAssuranceIfMatch(value: string): string {
  const byteLength = new TextEncoder().encode(value).byteLength;
  if (
    value !== value.trim() ||
    byteLength < 3 ||
    byteLength > 512 ||
    value === "*" ||
    value.startsWith("W/") ||
    value.includes(",") ||
    value[0] !== '"' ||
    value[value.length - 1] !== '"' ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new Error(
      "Campaign Assurance ifMatch must be the exact strong campaign ETag returned by the API",
    );
  }
  return value;
}

function validateCreateRunObservationRequest(
  input: CreateCampaignAssuranceRunInput,
): void {
  if (input.observed_surfaces !== undefined && !input.include_seed_test) {
    throw new Error(
      "Campaign Assurance observed_surfaces require include_seed_test=true",
    );
  }
  const surfaces = input.observed_surfaces ?? [];
  if (
    surfaces.length > 32 ||
    new Set(surfaces).size !== surfaces.length ||
    surfaces.some(
      (surface) =>
        new TextEncoder().encode(surface).byteLength > 128 ||
        !/^[A-Za-z0-9._:-]+$/u.test(surface),
    )
  ) {
    throw new Error(
      "Campaign Assurance observed_surfaces must be at most 32 unique stable 1-128 byte identifiers",
    );
  }
}
