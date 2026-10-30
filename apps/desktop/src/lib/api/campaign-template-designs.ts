import { apiRequest } from "../api-client";
import { registerPrivateSessionReset } from "../private-session-state";
import {
  vaultDelete,
  vaultDeletePrefix,
  vaultReadJSON,
  vaultSetJSON,
} from "../secure-vault";
import type { ApiResult } from "./result";

export type CampaignTemplateDesignMode = "adapt" | "generate";
export type CampaignTemplateDesignStatus =
  | "queued"
  | "generating"
  | "ready"
  | "failed"
  | "saved"
  | "campaign_created"
  | "archived";

export interface CampaignTemplateDesignOutput {
  name: string;
  subject: string;
  preview_text?: string;
  body_html: string;
  body_mjml?: string;
  variables?: Record<string, unknown>;
  unresolved_variables: string[];
  reference_template_ids: string[];
  warnings: string[];
}

export interface CampaignTemplateDesignWarning {
  code: string;
  message: string;
  recommended_action?: string;
}

export interface CampaignTemplateDesignValidationCheck {
  code: string;
  status: "pass" | "warn" | "fail";
  message: string;
  repaired?: boolean;
}

export interface CampaignTemplateDesignValidation {
  status: "pass" | "warn" | "fail";
  checks: CampaignTemplateDesignValidationCheck[];
}

export interface CampaignTemplateDesignRevision {
  id: string;
  draft_id: string;
  revision: number;
  operation: "initial" | "refine" | "repair";
  base_revision?: number;
  output: CampaignTemplateDesignOutput;
  output_hash: string;
  validation: CampaignTemplateDesignValidation;
  warnings: CampaignTemplateDesignWarning[];
  created_at: string;
}

export interface CampaignTemplateDesignCapabilities {
  can_refine: boolean;
  can_retry: boolean;
  can_save: boolean;
  can_create_campaign: boolean;
  can_archive: boolean;
}

export interface CreateCampaignTemplateDesignInput {
  mode: CampaignTemplateDesignMode;
  source_template_id?: string;
  brief?: string;
  instructions?: string;
  kind?: "newsletter" | "promo" | "announcement";
  tone?: string;
  fidelity?: "close" | "balanced" | "inspired";
  name?: string;
  subject?: string;
  preview_text?: string;
  goal?: string;
  category?: string;
  audience?: string;
  industry?: string;
  style?: string;
  layout?: string;
  sections?: string[];
  cta?: string;
  brand?: Record<string, unknown>;
  content?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  reference_template_ids?: string[];
}

export interface CampaignTemplateDesignDraft {
  id: string;
  mode: CampaignTemplateDesignMode;
  status: CampaignTemplateDesignStatus;
  source_template_id?: string;
  reference_template_ids: string[];
  current_revision: number;
  revision?: CampaignTemplateDesignRevision;
  attempt_count: number;
  last_error_code?: string;
  last_error_message?: string;
  saved_template_id?: string;
  saved_revision?: number;
  created_campaign_id?: string;
  campaign_revision?: number;
  capabilities: CampaignTemplateDesignCapabilities;
  recommended_action: string;
  retry_after_seconds?: number;
  expires_at: string;
  created_at: string;
  updated_at: string;
  request: CreateCampaignTemplateDesignInput;
}

export interface CampaignTemplateDesignSummary {
  id: string;
  mode: CampaignTemplateDesignMode;
  status: Exclude<CampaignTemplateDesignStatus, "archived">;
  source_template_id?: string;
  current_revision: number;
  attempt_count: number;
  last_error_code?: string;
  last_error_message?: string;
  saved_template_id?: string;
  saved_revision?: number;
  created_campaign_id?: string;
  campaign_revision?: number;
  capabilities: CampaignTemplateDesignCapabilities;
  recommended_action: string;
  retry_after_seconds?: number;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface CampaignTemplateDesignSummaryPage {
  items: CampaignTemplateDesignSummary[];
  next_cursor?: string;
}

export interface CampaignTemplateDesignCommit {
  revision: number;
  output_hash: string;
}

type DesignMutationOptions = {
  signal?: AbortSignal;
  idempotencyKey?: string;
};

function mutationHeaders(
  options: DesignMutationOptions,
): Pick<RequestInit, "headers"> {
  return options.idempotencyKey
    ? { headers: { "Idempotency-Key": options.idempotencyKey } }
    : {};
}

const DESIGN_STATUSES = new Set<CampaignTemplateDesignStatus>([
  "queued",
  "generating",
  "ready",
  "failed",
  "saved",
  "campaign_created",
  "archived",
]);
const DESIGN_MODES = new Set<CampaignTemplateDesignMode>(["adapt", "generate"]);
const REVISION_OPERATIONS = new Set(["initial", "refine", "repair"]);
const RECOMMENDED_ACTIONS = new Set([
  "none",
  "poll_campaign_template_design",
  "review_campaign_template_design",
  "retry_campaign_template_design",
  "use_saved_campaign_template",
  "open_campaign_draft",
  "get_campaign_template_design",
]);
const VALIDATION_STATUSES = new Set(["pass", "warn", "fail"]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function strings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function finiteInteger(value: unknown, min = 0): value is number {
  return Number.isInteger(value) && Number(value) >= min;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function decodeOutput(value: unknown): CampaignTemplateDesignOutput | null {
  const output = record(value);
  if (
    !output ||
    typeof output.name !== "string" ||
    output.name.trim() === "" ||
    typeof output.subject !== "string" ||
    typeof output.body_html !== "string" ||
    output.body_html.trim() === "" ||
    (output.preview_text !== undefined &&
      typeof output.preview_text !== "string") ||
    (output.body_mjml !== undefined && typeof output.body_mjml !== "string") ||
    !strings(output.unresolved_variables) ||
    !strings(output.reference_template_ids) ||
    output.reference_template_ids.length > 3 ||
    !strings(output.warnings)
  ) {
    return null;
  }
  if (output.variables !== undefined && record(output.variables) === null) {
    return null;
  }
  return {
    name: output.name,
    subject: output.subject,
    body_html: output.body_html,
    ...(typeof output.preview_text === "string"
      ? { preview_text: output.preview_text }
      : {}),
    ...(typeof output.body_mjml === "string"
      ? { body_mjml: output.body_mjml }
      : {}),
    ...(output.variables !== undefined
      ? { variables: output.variables as Record<string, unknown> }
      : {}),
    unresolved_variables: output.unresolved_variables,
    reference_template_ids: output.reference_template_ids,
    warnings: output.warnings,
  };
}

function decodeWarnings(
  value: unknown,
): CampaignTemplateDesignWarning[] | null {
  if (!Array.isArray(value)) return null;
  const warnings: CampaignTemplateDesignWarning[] = [];
  for (const item of value) {
    const warning = record(item);
    if (
      !warning ||
      typeof warning.code !== "string" ||
      warning.code.trim() === "" ||
      typeof warning.message !== "string" ||
      warning.message.trim() === "" ||
      (warning.recommended_action !== undefined &&
        typeof warning.recommended_action !== "string")
    ) {
      return null;
    }
    warnings.push({
      code: warning.code,
      message: warning.message,
      ...(typeof warning.recommended_action === "string"
        ? { recommended_action: warning.recommended_action }
        : {}),
    });
  }
  return warnings;
}

function decodeValidation(
  value: unknown,
): CampaignTemplateDesignValidation | null {
  const validation = record(value);
  if (
    !validation ||
    typeof validation.status !== "string" ||
    !VALIDATION_STATUSES.has(validation.status) ||
    !Array.isArray(validation.checks)
  ) {
    return null;
  }
  const checks: CampaignTemplateDesignValidationCheck[] = [];
  for (const item of validation.checks) {
    const check = record(item);
    if (
      !check ||
      typeof check.code !== "string" ||
      check.code.trim() === "" ||
      typeof check.status !== "string" ||
      !VALIDATION_STATUSES.has(check.status) ||
      typeof check.message !== "string" ||
      check.message.trim() === "" ||
      (check.repaired !== undefined && typeof check.repaired !== "boolean")
    ) {
      return null;
    }
    checks.push({
      code: check.code,
      status: check.status as CampaignTemplateDesignValidationCheck["status"],
      message: check.message,
      ...(typeof check.repaired === "boolean"
        ? { repaired: check.repaired }
        : {}),
    });
  }
  return {
    status: validation.status as CampaignTemplateDesignValidation["status"],
    checks,
  };
}

export function decodeCampaignTemplateDesignRevision(
  value: unknown,
): CampaignTemplateDesignRevision | null {
  const revision = record(value);
  if (
    !revision ||
    typeof revision.id !== "string" ||
    revision.id.trim() === "" ||
    typeof revision.draft_id !== "string" ||
    revision.draft_id.trim() === "" ||
    !finiteInteger(revision.revision, 1) ||
    typeof revision.operation !== "string" ||
    !REVISION_OPERATIONS.has(revision.operation) ||
    (revision.base_revision !== undefined &&
      !finiteInteger(revision.base_revision, 1)) ||
    typeof revision.output_hash !== "string" ||
    !/^[a-f0-9]{64}$/i.test(revision.output_hash) ||
    !validTimestamp(revision.created_at)
  ) {
    return null;
  }
  const output = decodeOutput(revision.output);
  const validation = decodeValidation(revision.validation);
  const warnings = decodeWarnings(revision.warnings);
  if (!output || !validation || !warnings) return null;
  return {
    id: revision.id,
    draft_id: revision.draft_id,
    revision: revision.revision,
    operation:
      revision.operation as CampaignTemplateDesignRevision["operation"],
    ...(typeof revision.base_revision === "number"
      ? { base_revision: revision.base_revision }
      : {}),
    output,
    output_hash: revision.output_hash.toLowerCase(),
    validation,
    warnings,
    created_at: revision.created_at,
  };
}

export function decodeCampaignTemplateDesignDraft(
  value: unknown,
): CampaignTemplateDesignDraft | null {
  const draft = record(value);
  if (
    !draft ||
    typeof draft.id !== "string" ||
    draft.id.trim() === "" ||
    typeof draft.mode !== "string" ||
    !DESIGN_MODES.has(draft.mode as CampaignTemplateDesignMode) ||
    typeof draft.status !== "string" ||
    !DESIGN_STATUSES.has(draft.status as CampaignTemplateDesignStatus) ||
    (draft.source_template_id !== undefined &&
      typeof draft.source_template_id !== "string") ||
    !strings(draft.reference_template_ids) ||
    draft.reference_template_ids.length > 3 ||
    !finiteInteger(draft.current_revision) ||
    !finiteInteger(draft.attempt_count) ||
    draft.attempt_count > 20 ||
    typeof draft.recommended_action !== "string" ||
    !RECOMMENDED_ACTIONS.has(draft.recommended_action) ||
    !validTimestamp(draft.expires_at) ||
    !validTimestamp(draft.created_at) ||
    !validTimestamp(draft.updated_at) ||
    record(draft.request) === null
  ) {
    return null;
  }
  const capabilities = record(draft.capabilities);
  if (
    !capabilities ||
    [
      "can_refine",
      "can_retry",
      "can_save",
      "can_create_campaign",
      "can_archive",
    ].some((key) => typeof capabilities[key] !== "boolean")
  ) {
    return null;
  }
  const revision =
    draft.revision === undefined
      ? undefined
      : decodeCampaignTemplateDesignRevision(draft.revision);
  if (draft.revision !== undefined && !revision) return null;
  const hasSavedTemplate = typeof draft.saved_template_id === "string";
  const hasSavedRevision = typeof draft.saved_revision === "number";
  const hasCreatedCampaign = typeof draft.created_campaign_id === "string";
  const hasCampaignRevision = typeof draft.campaign_revision === "number";
  if (
    (revision !== undefined &&
      revision !== null &&
      (revision.draft_id !== draft.id ||
        revision.revision !== draft.current_revision)) ||
    (draft.current_revision === 0) !== (revision === undefined) ||
    (draft.last_error_code !== undefined &&
      typeof draft.last_error_code !== "string") ||
    (draft.last_error_message !== undefined &&
      typeof draft.last_error_message !== "string") ||
    (draft.saved_template_id !== undefined &&
      (typeof draft.saved_template_id !== "string" ||
        draft.saved_template_id.trim() === "")) ||
    (draft.created_campaign_id !== undefined &&
      (typeof draft.created_campaign_id !== "string" ||
        draft.created_campaign_id.trim() === "")) ||
    (draft.retry_after_seconds !== undefined &&
      !finiteInteger(draft.retry_after_seconds, 1)) ||
    (draft.saved_revision !== undefined &&
      !finiteInteger(draft.saved_revision, 1)) ||
    (draft.campaign_revision !== undefined &&
      !finiteInteger(draft.campaign_revision, 1)) ||
    hasSavedTemplate !== hasSavedRevision ||
    hasCreatedCampaign !== hasCampaignRevision ||
    (draft.status === "saved" && !hasSavedTemplate) ||
    (draft.status === "campaign_created" && !hasCreatedCampaign)
  ) {
    return null;
  }
  return {
    id: draft.id,
    mode: draft.mode as CampaignTemplateDesignMode,
    status: draft.status as CampaignTemplateDesignStatus,
    ...(typeof draft.source_template_id === "string"
      ? { source_template_id: draft.source_template_id }
      : {}),
    reference_template_ids: draft.reference_template_ids,
    current_revision: draft.current_revision,
    ...(revision ? { revision } : {}),
    attempt_count: draft.attempt_count,
    ...(typeof draft.last_error_code === "string"
      ? { last_error_code: draft.last_error_code }
      : {}),
    ...(typeof draft.last_error_message === "string"
      ? { last_error_message: draft.last_error_message }
      : {}),
    ...(typeof draft.saved_template_id === "string"
      ? { saved_template_id: draft.saved_template_id }
      : {}),
    ...(typeof draft.saved_revision === "number"
      ? { saved_revision: draft.saved_revision }
      : {}),
    ...(typeof draft.created_campaign_id === "string"
      ? { created_campaign_id: draft.created_campaign_id }
      : {}),
    ...(typeof draft.campaign_revision === "number"
      ? { campaign_revision: draft.campaign_revision }
      : {}),
    capabilities: capabilities as unknown as CampaignTemplateDesignCapabilities,
    recommended_action: draft.recommended_action,
    ...(typeof draft.retry_after_seconds === "number"
      ? { retry_after_seconds: draft.retry_after_seconds }
      : {}),
    expires_at: draft.expires_at,
    created_at: draft.created_at,
    updated_at: draft.updated_at,
    request: draft.request as unknown as CreateCampaignTemplateDesignInput,
  };
}

export function decodeCampaignTemplateDesignSummary(
  value: unknown,
): CampaignTemplateDesignSummary | null {
  const summary = record(value);
  const capabilities = record(summary?.capabilities);
  const hasSavedTemplate = typeof summary?.saved_template_id === "string";
  const hasSavedRevision = typeof summary?.saved_revision === "number";
  const hasCreatedCampaign = typeof summary?.created_campaign_id === "string";
  const hasCampaignRevision = typeof summary?.campaign_revision === "number";
  if (
    !summary ||
    typeof summary.id !== "string" ||
    summary.id.trim() === "" ||
    typeof summary.mode !== "string" ||
    !DESIGN_MODES.has(summary.mode as CampaignTemplateDesignMode) ||
    typeof summary.status !== "string" ||
    !DESIGN_STATUSES.has(summary.status as CampaignTemplateDesignStatus) ||
    summary.status === "archived" ||
    (summary.source_template_id !== undefined &&
      typeof summary.source_template_id !== "string") ||
    !finiteInteger(summary.current_revision) ||
    !finiteInteger(summary.attempt_count) ||
    summary.attempt_count > 20 ||
    typeof summary.recommended_action !== "string" ||
    !RECOMMENDED_ACTIONS.has(summary.recommended_action) ||
    !validTimestamp(summary.expires_at) ||
    !validTimestamp(summary.created_at) ||
    !validTimestamp(summary.updated_at) ||
    !capabilities ||
    [
      "can_refine",
      "can_retry",
      "can_save",
      "can_create_campaign",
      "can_archive",
    ].some((key) => typeof capabilities[key] !== "boolean") ||
    (summary.last_error_code !== undefined &&
      typeof summary.last_error_code !== "string") ||
    (summary.last_error_message !== undefined &&
      typeof summary.last_error_message !== "string") ||
    (summary.saved_template_id !== undefined &&
      (typeof summary.saved_template_id !== "string" ||
        summary.saved_template_id.trim() === "")) ||
    (summary.created_campaign_id !== undefined &&
      (typeof summary.created_campaign_id !== "string" ||
        summary.created_campaign_id.trim() === "")) ||
    (summary.retry_after_seconds !== undefined &&
      !finiteInteger(summary.retry_after_seconds, 1)) ||
    (summary.saved_revision !== undefined &&
      !finiteInteger(summary.saved_revision, 1)) ||
    (summary.campaign_revision !== undefined &&
      !finiteInteger(summary.campaign_revision, 1)) ||
    hasSavedTemplate !== hasSavedRevision ||
    hasCreatedCampaign !== hasCampaignRevision ||
    (summary.status === "saved" && !hasSavedTemplate) ||
    (summary.status === "campaign_created" && !hasCreatedCampaign)
  ) {
    return null;
  }
  return {
    id: summary.id,
    mode: summary.mode as CampaignTemplateDesignMode,
    status: summary.status as CampaignTemplateDesignSummary["status"],
    ...(typeof summary.source_template_id === "string"
      ? { source_template_id: summary.source_template_id }
      : {}),
    current_revision: summary.current_revision,
    attempt_count: summary.attempt_count,
    ...(typeof summary.last_error_code === "string"
      ? { last_error_code: summary.last_error_code }
      : {}),
    ...(typeof summary.last_error_message === "string"
      ? { last_error_message: summary.last_error_message }
      : {}),
    ...(typeof summary.saved_template_id === "string"
      ? { saved_template_id: summary.saved_template_id }
      : {}),
    ...(typeof summary.saved_revision === "number"
      ? { saved_revision: summary.saved_revision }
      : {}),
    ...(typeof summary.created_campaign_id === "string"
      ? { created_campaign_id: summary.created_campaign_id }
      : {}),
    ...(typeof summary.campaign_revision === "number"
      ? { campaign_revision: summary.campaign_revision }
      : {}),
    capabilities: capabilities as unknown as CampaignTemplateDesignCapabilities,
    recommended_action: summary.recommended_action,
    ...(typeof summary.retry_after_seconds === "number"
      ? { retry_after_seconds: summary.retry_after_seconds }
      : {}),
    expires_at: summary.expires_at,
    created_at: summary.created_at,
    updated_at: summary.updated_at,
  };
}

function decodeDraftResult(
  result: ApiResult<unknown>,
): ApiResult<CampaignTemplateDesignDraft> {
  if (result.error) return result;
  const draft = decodeCampaignTemplateDesignDraft(result.data);
  return draft
    ? {
        data: draft,
        ...(result.serverVersion
          ? { serverVersion: result.serverVersion }
          : {}),
      }
    : {
        error: {
          message:
            "The server returned an invalid campaign-template design record.",
          code: "invalid_design_response",
          kind: "parse",
        },
        retryability: "manual",
      };
}

export const campaignTemplateDesignsApi = {
  async list(
    options: { limit?: number; cursor?: string; signal?: AbortSignal } = {},
  ): Promise<ApiResult<CampaignTemplateDesignSummaryPage>> {
    if (
      (options.limit !== undefined &&
        (!Number.isInteger(options.limit) ||
          options.limit < 1 ||
          options.limit > 50)) ||
      (options.cursor !== undefined &&
        (typeof options.cursor !== "string" ||
          options.cursor.length === 0 ||
          options.cursor.length > 1024 ||
          options.cursor.trim() !== options.cursor ||
          /[\u0000-\u001f\u007f]/u.test(options.cursor)))
    ) {
      return {
        error: {
          message:
            "Design recovery pagination is outside the supported bounds.",
          code: "invalid_design_recovery_page",
          kind: "invalid_config",
        },
        retryability: "not-retryable",
      };
    }
    const query = new URLSearchParams();
    if (options.limit !== undefined) {
      query.set("limit", String(options.limit));
    }
    if (options.cursor !== undefined) query.set("cursor", options.cursor);
    const result = await apiRequest<unknown>(
      `/api/v1/campaign-template-designs${query.size > 0 ? `?${query.toString()}` : ""}`,
      {},
      { signal: options.signal, maxAttempts: 1 },
    );
    if (result.error) return result;
    const page = record(result.data);
    if (
      !page ||
      !Array.isArray(page.items) ||
      page.items.length > (options.limit ?? 20) ||
      (page.next_cursor !== undefined &&
        (typeof page.next_cursor !== "string" ||
          page.next_cursor.length === 0 ||
          page.next_cursor.length > 1024 ||
          page.next_cursor.trim() !== page.next_cursor ||
          /[\u0000-\u001f\u007f]/u.test(page.next_cursor) ||
          page.next_cursor === options.cursor))
    ) {
      return {
        error: {
          message: "The server returned an invalid design recovery page.",
          code: "invalid_design_recovery_response",
          kind: "parse",
        },
        retryability: "manual",
      };
    }
    const items = page.items.map(decodeCampaignTemplateDesignSummary);
    const ids = new Set(
      items.flatMap((item) => (item === null ? [] : [item.id])),
    );
    if (items.some((item) => item === null) || ids.size !== items.length) {
      return {
        error: {
          message: "The server returned an invalid design recovery item.",
          code: "invalid_design_recovery_response",
          kind: "parse",
        },
        retryability: "manual",
      };
    }
    return {
      data: {
        items: items as CampaignTemplateDesignSummary[],
        ...(typeof page.next_cursor === "string"
          ? { next_cursor: page.next_cursor }
          : {}),
      },
      ...(result.serverVersion ? { serverVersion: result.serverVersion } : {}),
    };
  },

  async create(
    input: CreateCampaignTemplateDesignInput,
    options: DesignMutationOptions = {},
  ): Promise<ApiResult<CampaignTemplateDesignDraft>> {
    return decodeDraftResult(
      await apiRequest<unknown>(
        "/api/v1/campaign-template-designs",
        {
          method: "POST",
          body: JSON.stringify(input),
          ...mutationHeaders(options),
        },
        {
          requireOnline: true,
          maxAttempts: 1,
          signal: options.signal,
          timeoutMs: 60_000,
        },
      ),
    );
  },

  async get(
    id: string,
    options: DesignMutationOptions = {},
  ): Promise<ApiResult<CampaignTemplateDesignDraft>> {
    return decodeDraftResult(
      await apiRequest<unknown>(
        `/api/v1/campaign-template-designs/${encodeURIComponent(id)}`,
        {},
        { signal: options.signal, maxAttempts: 1 },
      ),
    );
  },

  async revisions(
    id: string,
    options: DesignMutationOptions = {},
  ): Promise<ApiResult<{ items: CampaignTemplateDesignRevision[] }>> {
    const result = await apiRequest<unknown>(
      `/api/v1/campaign-template-designs/${encodeURIComponent(id)}/revisions`,
      {},
      { signal: options.signal, maxAttempts: 1 },
    );
    if (result.error) return result;
    const response = record(result.data);
    if (!response || !Array.isArray(response.items)) {
      return {
        error: {
          message: "The server returned an invalid design revision history.",
          code: "invalid_design_revisions_response",
          kind: "parse",
        },
        retryability: "manual",
      };
    }
    const items = response.items.map(decodeCampaignTemplateDesignRevision);
    const decoded = items.filter(
      (item): item is CampaignTemplateDesignRevision => item !== null,
    );
    const revisionNumbers = new Set(decoded.map((item) => item.revision));
    const revisionIDs = new Set(decoded.map((item) => item.id));
    if (
      decoded.length !== items.length ||
      decoded.some((item) => item.draft_id !== id) ||
      revisionNumbers.size !== decoded.length ||
      revisionIDs.size !== decoded.length
    ) {
      return {
        error: {
          message: "The server returned an invalid design revision history.",
          code: "invalid_design_revisions_response",
          kind: "parse",
        },
        retryability: "manual",
      };
    }
    return {
      data: { items: decoded },
      ...(result.serverVersion ? { serverVersion: result.serverVersion } : {}),
    };
  },

  async refine(
    id: string,
    input: { instructions: string; base_revision: number },
    options: DesignMutationOptions = {},
  ): Promise<ApiResult<CampaignTemplateDesignDraft>> {
    return decodeDraftResult(
      await apiRequest<unknown>(
        `/api/v1/campaign-template-designs/${encodeURIComponent(id)}/refine`,
        {
          method: "POST",
          body: JSON.stringify(input),
          ...mutationHeaders(options),
        },
        {
          requireOnline: true,
          maxAttempts: 1,
          signal: options.signal,
          timeoutMs: 60_000,
        },
      ),
    );
  },

  async retry(
    id: string,
    options: DesignMutationOptions = {},
  ): Promise<ApiResult<CampaignTemplateDesignDraft>> {
    return decodeDraftResult(
      await apiRequest<unknown>(
        `/api/v1/campaign-template-designs/${encodeURIComponent(id)}/retry`,
        { method: "POST", body: "{}", ...mutationHeaders(options) },
        { requireOnline: true, maxAttempts: 1, signal: options.signal },
      ),
    );
  },

  save<T>(
    id: string,
    input: CampaignTemplateDesignCommit & {
      slug: string;
      name?: string;
      subject?: string;
      preview_text?: string;
    },
    options: DesignMutationOptions = {},
  ): Promise<ApiResult<T>> {
    return apiRequest<T>(
      `/api/v1/campaign-template-designs/${encodeURIComponent(id)}/save`,
      {
        method: "POST",
        body: JSON.stringify(input),
        ...mutationHeaders(options),
      },
      { requireOnline: true, maxAttempts: 1, signal: options.signal },
    );
  },

  createCampaign<T>(
    id: string,
    input: CampaignTemplateDesignCommit & {
      name?: string;
      subject?: string;
      preview_text?: string;
      variables?: Record<string, unknown>;
    },
    options: DesignMutationOptions = {},
  ): Promise<ApiResult<T>> {
    return apiRequest<T>(
      `/api/v1/campaign-template-designs/${encodeURIComponent(id)}/create-campaign`,
      {
        method: "POST",
        body: JSON.stringify(input),
        ...mutationHeaders(options),
      },
      { requireOnline: true, maxAttempts: 1, signal: options.signal },
    );
  },

  async archive(
    id: string,
    options: DesignMutationOptions = {},
  ): Promise<ApiResult<CampaignTemplateDesignDraft>> {
    return decodeDraftResult(
      await apiRequest<unknown>(
        `/api/v1/campaign-template-designs/${encodeURIComponent(id)}/archive`,
        { method: "POST", body: "{}", ...mutationHeaders(options) },
        { requireOnline: true, maxAttempts: 1, signal: options.signal },
      ),
    );
  },
};

export interface CampaignTemplateDesignResumeRecord {
  designId: string;
  mode: CampaignTemplateDesignMode;
  sourceTemplateId?: string;
  expiresAt: string;
  updatedAt: string;
}

export interface CampaignTemplateDesignCreateAttemptRecord {
  input: CreateCampaignTemplateDesignInput;
  serializedInput: string;
  idempotencyKey: string;
  createdAt: string;
}

type CampaignTemplateDesignResumeStorage = Pick<
  Storage,
  "getItem" | "removeItem" | "setItem"
>;

const DESIGN_CREATE_ATTEMPT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const DESIGN_CREATE_ATTEMPT_MAX_INPUT_BYTES = 128 * 1_024;
const DESIGN_IDENTITY_SCOPE_RE = /^[a-f0-9]{16}$/u;
const DESIGN_RESUME_PREFIX = "postwave:campaign-template-design:active:";
const DESIGN_CREATE_ATTEMPT_PREFIX =
  "postwave:campaign-template-design:pending-create:";

function browserResumeStorage(): CampaignTemplateDesignResumeStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function validDesignIdentityScope(value: string): boolean {
  return DESIGN_IDENTITY_SCOPE_RE.test(value);
}

export function campaignTemplateDesignResumeKey(
  workspaceScope: string,
): string {
  if (!validDesignIdentityScope(workspaceScope)) {
    throw new TypeError("A verified workspace and user scope is required.");
  }
  return `${DESIGN_RESUME_PREFIX}${workspaceScope}`;
}

export function campaignTemplateDesignCreateAttemptKey(
  workspaceScope: string,
): string {
  if (!validDesignIdentityScope(workspaceScope)) {
    throw new TypeError("A verified workspace and user scope is required.");
  }
  return `${DESIGN_CREATE_ATTEMPT_PREFIX}${workspaceScope}`;
}

function campaignTemplateDesignCreateAttemptInvalidKey(key: string): string {
  return `${key}:invalid`;
}

function createAttemptInvalidMarkerState(
  key: string,
): "clear" | "invalid" | "unavailable" {
  const storage = browserResumeStorage();
  if (!storage) return "unavailable";
  try {
    return storage.getItem(
      campaignTemplateDesignCreateAttemptInvalidKey(key),
    ) === null
      ? "clear"
      : "invalid";
  } catch {
    return "unavailable";
  }
}

function persistCreateAttemptInvalidMarker(key: string): boolean {
  const storage = browserResumeStorage();
  if (!storage) return false;
  try {
    const markerKey = campaignTemplateDesignCreateAttemptInvalidKey(key);
    storage.setItem(markerKey, "1");
    return storage.getItem(markerKey) === "1";
  } catch {
    return false;
  }
}

function validDesignIdempotencyKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

type DecodedCreateAttempt =
  | { state: "invalid" }
  | { state: "stale" }
  | {
      state: "ready";
      attempt: CampaignTemplateDesignCreateAttemptRecord;
    };

function decodeCampaignTemplateDesignCreateAttempt(
  value: Record<string, unknown> | null,
  now: number,
): DecodedCreateAttempt {
  const serializedInput = value?.serializedInput;
  const idempotencyKey = value?.idempotencyKey;
  const createdAt = value?.createdAt;
  if (
    typeof serializedInput !== "string" ||
    serializedInput.length === 0 ||
    new TextEncoder().encode(serializedInput).byteLength >
      DESIGN_CREATE_ATTEMPT_MAX_INPUT_BYTES ||
    !validDesignIdempotencyKey(idempotencyKey) ||
    !validTimestamp(createdAt)
  ) {
    return { state: "invalid" };
  }
  const age = now - Date.parse(createdAt);
  if (age < 0) return { state: "invalid" };
  if (age > DESIGN_CREATE_ATTEMPT_MAX_AGE_MS) return { state: "stale" };
  try {
    const input = record(JSON.parse(serializedInput));
    if (
      !input ||
      typeof input.mode !== "string" ||
      !DESIGN_MODES.has(input.mode as CampaignTemplateDesignMode) ||
      JSON.stringify(input) !== serializedInput
    ) {
      return { state: "invalid" };
    }
    return {
      state: "ready",
      attempt: {
        input: input as unknown as CreateCampaignTemplateDesignInput,
        serializedInput,
        idempotencyKey,
        createdAt,
      },
    };
  } catch {
    return { state: "invalid" };
  }
}

export async function readCampaignTemplateDesignCreateAttempt(
  workspaceScope: string,
  storage?: Pick<Storage, "getItem" | "removeItem">,
  now = Date.now(),
): Promise<CampaignTemplateDesignCreateAttemptRecord | null> {
  if (!validDesignIdentityScope(workspaceScope)) return null;
  const key = campaignTemplateDesignCreateAttemptKey(workspaceScope);
  let value: Record<string, unknown> | null = null;
  let legacyPlaintext = false;
  if (!storage) {
    const marker = createAttemptInvalidMarkerState(key);
    if (marker !== "clear") return null;
  }
  try {
    if (storage) {
      value = record(JSON.parse(storage.getItem(key) ?? "null"));
    } else {
      const read = await vaultReadJSON<unknown>(key);
      if (read.status === "unavailable") return null;
      if (read.status === "corrupt") {
        persistCreateAttemptInvalidMarker(key);
        return null;
      }
      if (read.status === "ready") {
        value = record(read.value);
        const legacyStorage = browserResumeStorage();
        if (legacyStorage && legacyStorage.getItem(key) !== null) {
          legacyStorage.removeItem(key);
          if (legacyStorage.getItem(key) !== null) return null;
        }
      } else {
        const legacyRaw = browserResumeStorage()?.getItem(key) ?? null;
        if (legacyRaw === null) return null;
        legacyPlaintext = legacyRaw !== null;
        value = record(JSON.parse(legacyRaw));
      }
    }
    const decoded = decodeCampaignTemplateDesignCreateAttempt(value, now);
    if (decoded.state === "stale") {
      try {
        if (storage) {
          storage.removeItem(key);
        } else if (legacyPlaintext) {
          const legacyStorage = browserResumeStorage();
          legacyStorage?.removeItem(key);
        } else {
          vaultDelete(key);
        }
      } catch {
        // A transient storage failure must not convert an expired attempt into
        // a permanent corruption marker.
      }
      return null;
    }
    if (decoded.state === "invalid") {
      throw new Error("invalid pending design attempt");
    }
    if (legacyPlaintext) {
      try {
        await vaultSetJSON(key, {
          serializedInput: decoded.attempt.serializedInput,
          idempotencyKey: decoded.attempt.idempotencyKey,
          createdAt: decoded.attempt.createdAt,
        });
        const legacyStorage = browserResumeStorage();
        legacyStorage?.removeItem(key);
        if (legacyStorage?.getItem(key) !== null) return null;
      } catch {
        // Preserve the valid legacy checkpoint for a later migration attempt.
        return null;
      }
    }
    return decoded.attempt;
  } catch {
    if (storage) {
      try {
        storage.removeItem(key);
      } catch {
        // Corrupt or inaccessible injected recovery state is safe to ignore.
      }
    } else if (legacyPlaintext) {
      try {
        browserResumeStorage()?.removeItem(key);
      } catch {
        // An unreadable legacy plaintext record is never adopted.
      }
    }
    if (!storage) persistCreateAttemptInvalidMarker(key);
    return null;
  }
}

export async function writeCampaignTemplateDesignCreateAttempt(
  workspaceScope: string,
  input: CreateCampaignTemplateDesignInput,
  idempotencyKey: string,
  storage?: Pick<Storage, "getItem" | "removeItem" | "setItem">,
  now = Date.now(),
): Promise<CampaignTemplateDesignCreateAttemptRecord | null> {
  if (!validDesignIdentityScope(workspaceScope)) return null;
  if (!validDesignIdempotencyKey(idempotencyKey)) return null;
  let serializedInput: string;
  try {
    serializedInput = JSON.stringify(input);
  } catch {
    return null;
  }
  if (
    new TextEncoder().encode(serializedInput).byteLength >
    DESIGN_CREATE_ATTEMPT_MAX_INPUT_BYTES
  ) {
    return null;
  }
  const value: CampaignTemplateDesignCreateAttemptRecord = {
    input,
    serializedInput,
    idempotencyKey,
    createdAt: new Date(now).toISOString(),
  };
  const serializedRecord = JSON.stringify({
    serializedInput,
    idempotencyKey,
    createdAt: value.createdAt,
  });
  try {
    const key = campaignTemplateDesignCreateAttemptKey(workspaceScope);
    if (storage) {
      const existing = await readCampaignTemplateDesignCreateAttempt(
        workspaceScope,
        storage,
        now,
      );
      if (existing) {
        return existing.serializedInput === serializedInput &&
          existing.idempotencyKey === idempotencyKey
          ? existing
          : null;
      }
      storage.setItem(key, serializedRecord);
      if (storage.getItem(key) !== serializedRecord) return null;
    } else {
      if (createAttemptInvalidMarkerState(key) !== "clear") return null;
      const existing = await readCampaignTemplateDesignCreateAttempt(
        workspaceScope,
        undefined,
        now,
      );
      if (createAttemptInvalidMarkerState(key) !== "clear") return null;
      const currentVaultState = await vaultReadJSON(key);
      if (currentVaultState.status === "unavailable") return null;
      if (currentVaultState.status === "corrupt") {
        persistCreateAttemptInvalidMarker(key);
        return null;
      }
      if (existing) {
        return existing.serializedInput === serializedInput &&
          existing.idempotencyKey === idempotencyKey
          ? existing
          : null;
      }
      if (currentVaultState.status === "ready") return null;
      await vaultSetJSON(key, {
        serializedInput,
        idempotencyKey,
        createdAt: value.createdAt,
      });
      const verified = await readCampaignTemplateDesignCreateAttempt(
        workspaceScope,
        undefined,
        now,
      );
      if (
        verified?.serializedInput !== serializedInput ||
        verified.idempotencyKey !== idempotencyKey
      ) {
        return null;
      }
    }
  } catch {
    return null;
  }
  return value;
}

export async function clearCampaignTemplateDesignCreateAttempt(
  workspaceScope: string,
  expectedIdempotencyKey?: string,
  storage?: Pick<Storage, "getItem" | "removeItem">,
): Promise<boolean> {
  if (!validDesignIdentityScope(workspaceScope)) return false;
  const key = campaignTemplateDesignCreateAttemptKey(workspaceScope);
  if (storage) {
    if (expectedIdempotencyKey) {
      try {
        const value = record(JSON.parse(storage.getItem(key) ?? "null"));
        if (value?.idempotencyKey !== expectedIdempotencyKey) return false;
      } catch {
        // Corrupt state is safe to remove.
      }
    }
    try {
      storage.removeItem(key);
      return storage.getItem(key) === null;
    } catch {
      return false;
    }
  }
  try {
    const marker = createAttemptInvalidMarkerState(key);
    if (marker !== "clear") return false;
    const existing =
      await readCampaignTemplateDesignCreateAttempt(workspaceScope);
    if (createAttemptInvalidMarkerState(key) !== "clear") return false;
    const currentVaultState = await vaultReadJSON(key);
    if (currentVaultState.status === "unavailable") return false;
    if (currentVaultState.status === "corrupt") {
      persistCreateAttemptInvalidMarker(key);
      return false;
    }
    if (currentVaultState.status === "ready" && !existing) return false;
    if (
      expectedIdempotencyKey &&
      existing?.idempotencyKey !== expectedIdempotencyKey
    ) {
      return false;
    }
    vaultDelete(key);
    return (
      (await vaultReadJSON(key)).status === "missing" &&
      createAttemptInvalidMarkerState(key) === "clear"
    );
  } catch {
    // A storage failure must not turn a confirmed server response into error.
    return false;
  }
}

export function readCampaignTemplateDesignResume(
  workspaceScope: string,
  storage?: Pick<Storage, "getItem" | "removeItem">,
  now = Date.now(),
): CampaignTemplateDesignResumeRecord | null {
  if (!validDesignIdentityScope(workspaceScope)) return null;
  const activeStorage = storage ?? browserResumeStorage();
  if (!activeStorage) return null;
  const key = campaignTemplateDesignResumeKey(workspaceScope);
  let value: unknown;
  try {
    const raw = activeStorage.getItem(key);
    if (!raw) return null;
    value = JSON.parse(raw);
  } catch {
    try {
      activeStorage.removeItem(key);
    } catch {
      // Storage can be unavailable in hardened webviews; resume is optional.
    }
    return null;
  }
  const resume = record(value);
  if (
    !resume ||
    typeof resume.designId !== "string" ||
    resume.designId.trim() === "" ||
    typeof resume.mode !== "string" ||
    !DESIGN_MODES.has(resume.mode as CampaignTemplateDesignMode) ||
    (resume.sourceTemplateId !== undefined &&
      typeof resume.sourceTemplateId !== "string") ||
    !validTimestamp(resume.expiresAt) ||
    !validTimestamp(resume.updatedAt) ||
    Date.parse(resume.expiresAt) <= now
  ) {
    try {
      activeStorage.removeItem(key);
    } catch {
      // Treat an inaccessible/corrupt pointer as absent.
    }
    return null;
  }
  return {
    designId: resume.designId,
    mode: resume.mode as CampaignTemplateDesignMode,
    ...(typeof resume.sourceTemplateId === "string"
      ? { sourceTemplateId: resume.sourceTemplateId }
      : {}),
    expiresAt: resume.expiresAt,
    updatedAt: resume.updatedAt,
  };
}

export function writeCampaignTemplateDesignResume(
  workspaceScope: string,
  draft: CampaignTemplateDesignDraft,
  storage?: Pick<Storage, "getItem" | "setItem">,
): boolean {
  if (!validDesignIdentityScope(workspaceScope)) return false;
  const activeStorage = storage ?? browserResumeStorage();
  if (!activeStorage) return false;
  const value: CampaignTemplateDesignResumeRecord = {
    designId: draft.id,
    mode: draft.mode,
    ...(draft.source_template_id
      ? { sourceTemplateId: draft.source_template_id }
      : {}),
    expiresAt: draft.expires_at,
    updatedAt: draft.updated_at,
  };
  const serialized = JSON.stringify(value);
  try {
    const key = campaignTemplateDesignResumeKey(workspaceScope);
    activeStorage.setItem(key, serialized);
    return activeStorage.getItem(key) === serialized;
  } catch {
    return false;
  }
}

export function clearCampaignTemplateDesignResume(
  workspaceScope: string,
  expectedDesignId?: string,
  storage?: Pick<Storage, "getItem" | "removeItem">,
): void {
  if (!validDesignIdentityScope(workspaceScope)) return;
  const activeStorage = storage ?? browserResumeStorage();
  if (!activeStorage) return;
  const key = campaignTemplateDesignResumeKey(workspaceScope);
  if (expectedDesignId) {
    try {
      const value = record(JSON.parse(activeStorage.getItem(key) ?? "null"));
      if (value?.designId !== expectedDesignId) return;
    } catch {
      // Corrupt state is safe to remove.
    }
  }
  try {
    activeStorage.removeItem(key);
  } catch {
    // A storage failure must not turn a confirmed archive/commit into an error.
  }
}

function purgeCampaignTemplateDesignResumeRecords(): void {
  if (typeof window === "undefined") return;
  vaultDeletePrefix(DESIGN_CREATE_ATTEMPT_PREFIX);
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (
        key?.startsWith(DESIGN_RESUME_PREFIX) ||
        key?.startsWith(DESIGN_CREATE_ATTEMPT_PREFIX)
      ) {
        keys.push(key);
      }
    }
    for (const key of keys) window.localStorage.removeItem(key);
  } catch {
    // Hardened webviews can reject enumeration; validated identity-scoped
    // reads still prevent another workspace from adopting these pointers.
  }
}

registerPrivateSessionReset(
  "campaign-template-design-resume",
  purgeCampaignTemplateDesignResumeRecords,
);

export function isCampaignTemplateDesignActive(
  status: CampaignTemplateDesignStatus,
): boolean {
  return status === "queued" || status === "generating";
}

type PollOptions = {
  signal?: AbortSignal;
  initial?: CampaignTemplateDesignDraft;
  onUpdate?: (draft: CampaignTemplateDesignDraft) => void;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  load?: (
    id: string,
    options?: DesignMutationOptions,
  ) => Promise<ApiResult<CampaignTemplateDesignDraft>>;
};

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("Aborted", "AbortError"),
      );
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException("Aborted", "AbortError"),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function pollCampaignTemplateDesign(
  id: string,
  options: PollOptions = {},
): Promise<ApiResult<CampaignTemplateDesignDraft>> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? wait;
  const load =
    options.load ??
    ((designId: string, loadOptions?: DesignMutationOptions) =>
      campaignTemplateDesignsApi.get(designId, loadOptions));
  let draft = options.initial;
  let delay = 750;
  while (true) {
    if (!draft) {
      const result = await load(id, { signal: options.signal });
      if (result.error) return result;
      draft = result.data;
      options.onUpdate?.(draft);
    }
    if (!isCampaignTemplateDesignActive(draft.status)) return { data: draft };
    if (Date.parse(draft.expires_at) <= now()) {
      return {
        error: {
          message:
            "This design job expired before it finished. Start a new design with the same direction.",
          status: 410,
          code: "design_expired",
          kind: "http",
        },
        retryability: "manual",
      };
    }
    const requestedDelay = Math.max(
      delay,
      (draft.retry_after_seconds ?? 0) * 1_000,
    );
    await sleep(Math.min(requestedDelay, 8_000), options.signal);
    delay = Math.min(Math.round(delay * 1.6), 8_000);
    draft = undefined;
  }
}
