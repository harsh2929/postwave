// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "@/lib/api";
import { newUUIDv7 } from "@/lib/http-fetch";

export const AI_REGRESSION_SURFACES = [
  "campaign_draft",
  "subject_line",
  "sequence_draft",
  "campaign_summary",
  "reply_intent",
] as const;
export const AI_REGRESSION_RUN_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
] as const;

export type AiRegressionSurface = (typeof AI_REGRESSION_SURFACES)[number];
export type AiRegressionRunStatus = (typeof AI_REGRESSION_RUN_STATUSES)[number];
export type AiRegressionGateResult = "pass" | "fail" | "advisory";
export type AiRegressionResultSeverity = "ok" | "warn" | "critical" | "error";

export interface AiRegressionSettings {
  warnThreshold: number;
  hardGateEnabled: boolean;
  hardGateThreshold: number;
  minExamplesForGate: number;
}

export interface AiRegressionSurfaceResult {
  total: number;
  scored: number;
  errors: number;
  passed: number;
  meanScore: number | null;
  gateResult: AiRegressionGateResult;
}

export interface AiRegressionRun {
  id: string;
  runtimeProvider: string;
  modelId: string;
  modelVersionTag: string;
  promptVersionTag: string;
  status: AiRegressionRunStatus;
  totalExamples: number;
  passedExamples: number;
  scoredExamples: number;
  errorExamples: number;
  fidelityScoreMean: number | null;
  fidelityScoreP25: number | null;
  gateResult: AiRegressionGateResult | null;
  warnThreshold: number;
  hardGateEnabled: boolean;
  hardGateThreshold: number | null;
  minExamplesForGate: number;
  maxAttempts: number;
  errorMessage: string | null;
  errorCode: string | null;
  bySurface: Partial<Record<AiRegressionSurface, AiRegressionSurfaceResult>>;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  snapshotFrozenAt: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  attemptCount: number;
  retryNotBefore: string | null;
  staleAt: string | null;
  updatedAt: string;
}

export interface GoldenExample {
  id: string;
  surfaceKind: AiRegressionSurface;
  brief: string;
  modelId: string;
  requestId: string | null;
  approvalId: string | null;
  agentRunId: string | null;
  createdAt: string;
}

export interface AiRegressionFidelityBreakdown {
  embeddingSimilarity: number;
  stylisticDistance: number;
  vocabularyOverlap: number;
  structuralMatch: number;
  combined: number;
}

export interface AiRegressionResult {
  id: string;
  exampleId: string | null;
  attemptCount: number;
  surfaceKind: AiRegressionSurface;
  snapshotOrdinal: number | null;
  brief: string | null;
  approvedOutput: string | null;
  sourceModelId: string | null;
  voiceProfileVersion: string | null;
  approvalId: string | null;
  agentRunId: string | null;
  sourceCreatedAt: string | null;
  snapshottedAt: string | null;
  replayedOutput: string | null;
  fidelityScore: number | null;
  breakdown: AiRegressionFidelityBreakdown | null;
  severity: AiRegressionResultSeverity;
  errorCode: string | null;
  errorMessage: string | null;
  scoredAt: string;
}

export interface CaptureGoldenExampleInput {
  requestId: string;
  surfaceKind: AiRegressionSurface;
  brief: string;
  approvedOutput: string;
}

export interface TriggerAiRegressionRunReceipt {
  runId: string;
  status: "pending";
  runtime: {
    provider: string;
    modelId: string;
    promptPolicyVersion: string;
  };
}

type JsonRecord = Record<string, unknown>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const PUBLIC_ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
const MAX_REQUEST_BYTES = 60 * 1024;
const encoder = new TextEncoder();

export class AiRegressionContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiRegressionContractError";
  }
}

function recordValue(
  value: unknown,
  context: string,
  allowedKeys: readonly string[],
): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AiRegressionContractError(`${context} must be an object.`);
  }
  const record = value as JsonRecord;
  const allowed = new Set(allowedKeys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new AiRegressionContractError(
      `${context} contains an unexpected field.`,
    );
  }
  return record;
}

function required(record: JsonRecord, key: string, context: string): unknown {
  if (!Object.hasOwn(record, key)) {
    throw new AiRegressionContractError(`${context}.${key} is required.`);
  }
  return record[key];
}

function textValue(
  value: unknown,
  context: string,
  maxCodePoints: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.trim().length === 0) ||
    Array.from(value).length > maxCodePoints
  ) {
    throw new AiRegressionContractError(`${context} is invalid.`);
  }
  return value;
}

function optionalText(
  record: JsonRecord,
  key: string,
  context: string,
  maximum: number,
): string | null {
  if (!Object.hasOwn(record, key) || record[key] === null) return null;
  return textValue(record[key], `${context}.${key}`, maximum, true);
}

function uuidValue(value: unknown, context: string): string {
  const id = textValue(value, context, 36);
  if (!UUID_PATTERN.test(id)) {
    throw new AiRegressionContractError(`${context} must be a lowercase UUID.`);
  }
  return id;
}

function optionalUUID(
  record: JsonRecord,
  key: string,
  context: string,
): string | null {
  if (!Object.hasOwn(record, key) || record[key] === null) return null;
  return uuidValue(record[key], `${context}.${key}`);
}

function dateValue(value: unknown, context: string): string {
  const date = textValue(value, context, 64);
  if (!Number.isFinite(Date.parse(date))) {
    throw new AiRegressionContractError(`${context} must be a date-time.`);
  }
  return date;
}

function optionalDate(
  record: JsonRecord,
  key: string,
  context: string,
): string | null {
  if (!Object.hasOwn(record, key) || record[key] === null) return null;
  return dateValue(record[key], `${context}.${key}`);
}

function numberValue(
  value: unknown,
  context: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new AiRegressionContractError(`${context} is out of range.`);
  }
  return value;
}

function integerValue(
  value: unknown,
  context: string,
  minimum: number,
  maximum: number,
): number {
  const result = numberValue(value, context, minimum, maximum);
  if (!Number.isInteger(result)) {
    throw new AiRegressionContractError(`${context} must be an integer.`);
  }
  return result;
}

function optionalNumber(
  record: JsonRecord,
  key: string,
  context: string,
  minimum: number,
  maximum: number,
): number | null {
  if (!Object.hasOwn(record, key) || record[key] === null) return null;
  return numberValue(record[key], `${context}.${key}`, minimum, maximum);
}

function booleanValue(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") {
    throw new AiRegressionContractError(`${context} must be a boolean.`);
  }
  return value;
}

function enumValue<T extends string>(
  value: unknown,
  context: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new AiRegressionContractError(`${context} has an invalid value.`);
  }
  return value as T;
}

const SETTINGS_KEYS = [
  "warn_threshold",
  "hard_gate_enabled",
  "hard_gate_threshold",
  "min_examples_for_gate",
] as const;

function decodeSettings(value: unknown): AiRegressionSettings {
  const record = recordValue(value, "AI regression settings", SETTINGS_KEYS);
  return {
    warnThreshold: numberValue(
      required(record, "warn_threshold", "AI regression settings"),
      "AI regression settings.warn_threshold",
      0,
      100,
    ),
    hardGateEnabled: booleanValue(
      required(record, "hard_gate_enabled", "AI regression settings"),
      "AI regression settings.hard_gate_enabled",
    ),
    hardGateThreshold: numberValue(
      required(record, "hard_gate_threshold", "AI regression settings"),
      "AI regression settings.hard_gate_threshold",
      0,
      100,
    ),
    minExamplesForGate: integerValue(
      required(record, "min_examples_for_gate", "AI regression settings"),
      "AI regression settings.min_examples_for_gate",
      1,
      2_147_483_647,
    ),
  };
}

const GOLDEN_KEYS = [
  "id",
  "surface_kind",
  "brief",
  "model_id",
  "request_id",
  "approval_id",
  "agent_run_id",
  "created_at",
] as const;

function decodeGolden(
  value: unknown,
  context = "golden example",
): GoldenExample {
  const record = recordValue(value, context, GOLDEN_KEYS);
  return {
    id: uuidValue(required(record, "id", context), `${context}.id`),
    surfaceKind: enumValue(
      required(record, "surface_kind", context),
      `${context}.surface_kind`,
      AI_REGRESSION_SURFACES,
    ),
    brief: textValue(
      required(record, "brief", context),
      `${context}.brief`,
      8_000,
    ),
    modelId: textValue(
      required(record, "model_id", context),
      `${context}.model_id`,
      200,
    ),
    requestId: optionalUUID(record, "request_id", context),
    approvalId: optionalUUID(record, "approval_id", context),
    agentRunId: optionalUUID(record, "agent_run_id", context),
    createdAt: dateValue(
      required(record, "created_at", context),
      `${context}.created_at`,
    ),
  };
}

const SURFACE_RESULT_KEYS = [
  "total",
  "scored",
  "errors",
  "passed",
  "mean_score",
  "gate_result",
] as const;

function decodeSurfaceResult(
  value: unknown,
  context: string,
): AiRegressionSurfaceResult {
  const record = recordValue(value, context, SURFACE_RESULT_KEYS);
  return {
    total: integerValue(
      required(record, "total", context),
      `${context}.total`,
      0,
      1_000_000,
    ),
    scored: integerValue(
      required(record, "scored", context),
      `${context}.scored`,
      0,
      1_000_000,
    ),
    errors: integerValue(
      required(record, "errors", context),
      `${context}.errors`,
      0,
      1_000_000,
    ),
    passed: integerValue(
      required(record, "passed", context),
      `${context}.passed`,
      0,
      1_000_000,
    ),
    meanScore: optionalNumber(record, "mean_score", context, 0, 100),
    gateResult: enumValue(
      required(record, "gate_result", context),
      `${context}.gate_result`,
      ["pass", "fail", "advisory"] as const,
    ),
  };
}

function decodeBySurface(
  value: unknown,
): Partial<Record<AiRegressionSurface, AiRegressionSurfaceResult>> {
  const record = recordValue(value, "run.by_surface", AI_REGRESSION_SURFACES);
  const result: Partial<
    Record<AiRegressionSurface, AiRegressionSurfaceResult>
  > = {};
  for (const surface of AI_REGRESSION_SURFACES) {
    if (Object.hasOwn(record, surface)) {
      result[surface] = decodeSurfaceResult(
        record[surface],
        `run.by_surface.${surface}`,
      );
    }
  }
  return result;
}

const RUN_KEYS = [
  "id",
  "runtime_provider",
  "model_id",
  "model_version_tag",
  "prompt_version_tag",
  "status",
  "total_examples",
  "passed_examples",
  "scored_examples",
  "error_examples",
  "fidelity_score_mean",
  "fidelity_score_p25",
  "gate_result",
  "warn_threshold",
  "hard_gate_enabled",
  "hard_gate_threshold",
  "min_examples_for_gate",
  "max_attempts",
  "error_message",
  "error_code",
  "by_surface",
  "created_at",
  "started_at",
  "completed_at",
  "snapshot_frozen_at",
  "lease_expires_at",
  "heartbeat_at",
  "attempt_count",
  "retry_not_before",
  "stale_at",
  "updated_at",
] as const;

function publicErrorCode(
  record: JsonRecord,
  key: string,
  context: string,
): string | null {
  const value = optionalText(record, key, context, 64);
  if (value !== null && !PUBLIC_ERROR_CODE_PATTERN.test(value)) {
    throw new AiRegressionContractError(`${context}.${key} is invalid.`);
  }
  return value;
}

function decodeRun(
  value: unknown,
  context = "AI regression run",
): AiRegressionRun {
  const record = recordValue(value, context, RUN_KEYS);
  const gateResult =
    !Object.hasOwn(record, "gate_result") || record.gate_result === null
      ? null
      : enumValue(record.gate_result, `${context}.gate_result`, [
          "pass",
          "fail",
          "advisory",
        ] as const);
  return {
    id: uuidValue(required(record, "id", context), `${context}.id`),
    runtimeProvider: textValue(
      required(record, "runtime_provider", context),
      `${context}.runtime_provider`,
      100,
    ),
    modelId: textValue(
      required(record, "model_id", context),
      `${context}.model_id`,
      200,
    ),
    modelVersionTag: textValue(
      required(record, "model_version_tag", context),
      `${context}.model_version_tag`,
      160,
    ),
    promptVersionTag: textValue(
      required(record, "prompt_version_tag", context),
      `${context}.prompt_version_tag`,
      160,
    ),
    status: enumValue(
      required(record, "status", context),
      `${context}.status`,
      AI_REGRESSION_RUN_STATUSES,
    ),
    totalExamples: integerValue(
      required(record, "total_examples", context),
      `${context}.total_examples`,
      1,
      1_000_000,
    ),
    passedExamples: integerValue(
      required(record, "passed_examples", context),
      `${context}.passed_examples`,
      0,
      1_000_000,
    ),
    scoredExamples: integerValue(
      required(record, "scored_examples", context),
      `${context}.scored_examples`,
      0,
      1_000_000,
    ),
    errorExamples: integerValue(
      required(record, "error_examples", context),
      `${context}.error_examples`,
      0,
      1_000_000,
    ),
    fidelityScoreMean: optionalNumber(
      record,
      "fidelity_score_mean",
      context,
      0,
      100,
    ),
    fidelityScoreP25: optionalNumber(
      record,
      "fidelity_score_p25",
      context,
      0,
      100,
    ),
    gateResult,
    warnThreshold: numberValue(
      required(record, "warn_threshold", context),
      `${context}.warn_threshold`,
      0,
      100,
    ),
    hardGateEnabled: booleanValue(
      required(record, "hard_gate_enabled", context),
      `${context}.hard_gate_enabled`,
    ),
    hardGateThreshold: optionalNumber(
      record,
      "hard_gate_threshold",
      context,
      0,
      100,
    ),
    minExamplesForGate: integerValue(
      required(record, "min_examples_for_gate", context),
      `${context}.min_examples_for_gate`,
      1,
      2_147_483_647,
    ),
    maxAttempts: integerValue(
      required(record, "max_attempts", context),
      `${context}.max_attempts`,
      1,
      20,
    ),
    errorMessage: optionalText(record, "error_message", context, 1_000),
    errorCode: publicErrorCode(record, "error_code", context),
    bySurface: Object.hasOwn(record, "by_surface")
      ? decodeBySurface(record.by_surface)
      : {},
    createdAt: dateValue(
      required(record, "created_at", context),
      `${context}.created_at`,
    ),
    startedAt: optionalDate(record, "started_at", context),
    completedAt: optionalDate(record, "completed_at", context),
    snapshotFrozenAt: optionalDate(record, "snapshot_frozen_at", context),
    leaseExpiresAt: optionalDate(record, "lease_expires_at", context),
    heartbeatAt: optionalDate(record, "heartbeat_at", context),
    attemptCount: integerValue(
      required(record, "attempt_count", context),
      `${context}.attempt_count`,
      0,
      20,
    ),
    retryNotBefore: optionalDate(record, "retry_not_before", context),
    staleAt: optionalDate(record, "stale_at", context),
    updatedAt: dateValue(
      required(record, "updated_at", context),
      `${context}.updated_at`,
    ),
  };
}

const BREAKDOWN_KEYS = [
  "embedding_similarity",
  "stylistic_distance",
  "vocabulary_overlap",
  "structural_match",
  "combined",
] as const;

function decodeBreakdown(value: unknown): AiRegressionFidelityBreakdown {
  const record = recordValue(value, "result.breakdown", BREAKDOWN_KEYS);
  return {
    embeddingSimilarity: numberValue(
      required(record, "embedding_similarity", "result.breakdown"),
      "result.breakdown.embedding_similarity",
      0,
      1,
    ),
    stylisticDistance: numberValue(
      required(record, "stylistic_distance", "result.breakdown"),
      "result.breakdown.stylistic_distance",
      0,
      1,
    ),
    vocabularyOverlap: numberValue(
      required(record, "vocabulary_overlap", "result.breakdown"),
      "result.breakdown.vocabulary_overlap",
      0,
      1,
    ),
    structuralMatch: numberValue(
      required(record, "structural_match", "result.breakdown"),
      "result.breakdown.structural_match",
      0,
      1,
    ),
    combined: numberValue(
      required(record, "combined", "result.breakdown"),
      "result.breakdown.combined",
      0,
      100,
    ),
  };
}

const RESULT_KEYS = [
  "id",
  "example_id",
  "attempt_count",
  "surface_kind",
  "snapshot_ordinal",
  "brief",
  "approved_output",
  "source_model_id",
  "voice_profile_version",
  "approval_id",
  "agent_run_id",
  "source_created_at",
  "snapshotted_at",
  "replayed_output",
  "fidelity_score",
  "breakdown",
  "severity",
  "error_code",
  "error_message",
  "scored_at",
] as const;

function optionalInteger(
  record: JsonRecord,
  key: string,
  context: string,
  minimum: number,
  maximum: number,
): number | null {
  if (!Object.hasOwn(record, key) || record[key] === null) return null;
  return integerValue(record[key], `${context}.${key}`, minimum, maximum);
}

function decodeResult(
  value: unknown,
  context = "AI regression result",
): AiRegressionResult {
  const record = recordValue(value, context, RESULT_KEYS);
  return {
    id: uuidValue(required(record, "id", context), `${context}.id`),
    exampleId: optionalUUID(record, "example_id", context),
    attemptCount: integerValue(
      required(record, "attempt_count", context),
      `${context}.attempt_count`,
      1,
      20,
    ),
    surfaceKind: enumValue(
      required(record, "surface_kind", context),
      `${context}.surface_kind`,
      AI_REGRESSION_SURFACES,
    ),
    snapshotOrdinal: optionalInteger(
      record,
      "snapshot_ordinal",
      context,
      1,
      1_000_000,
    ),
    brief: optionalText(record, "brief", context, 8_000),
    approvedOutput: optionalText(record, "approved_output", context, 32_000),
    sourceModelId: optionalText(record, "source_model_id", context, 200),
    voiceProfileVersion: optionalText(
      record,
      "voice_profile_version",
      context,
      200,
    ),
    approvalId: optionalUUID(record, "approval_id", context),
    agentRunId: optionalUUID(record, "agent_run_id", context),
    sourceCreatedAt: optionalDate(record, "source_created_at", context),
    snapshottedAt: optionalDate(record, "snapshotted_at", context),
    replayedOutput: optionalText(record, "replayed_output", context, 32_000),
    fidelityScore: optionalNumber(record, "fidelity_score", context, 0, 100),
    breakdown:
      !Object.hasOwn(record, "breakdown") || record.breakdown === null
        ? null
        : decodeBreakdown(record.breakdown),
    severity: enumValue(
      required(record, "severity", context),
      `${context}.severity`,
      ["ok", "warn", "critical", "error"] as const,
    ),
    errorCode: publicErrorCode(record, "error_code", context),
    errorMessage: optionalText(record, "error_message", context, 1_000),
    scoredAt: dateValue(
      required(record, "scored_at", context),
      `${context}.scored_at`,
    ),
  };
}

function decodeCollection<T>(
  value: unknown,
  context: string,
  maximum: number,
  decode: (candidate: unknown, candidateContext: string) => T,
): T[] {
  const record = recordValue(value, context, ["items"]);
  const items = required(record, "items", context);
  if (!Array.isArray(items) || items.length > maximum) {
    throw new AiRegressionContractError(`${context}.items is invalid.`);
  }
  return items.map((candidate, index) =>
    decode(candidate, `${context}.items[${index}]`),
  );
}

function freshReadOptions(
  fresh: boolean | undefined,
  signal: AbortSignal | undefined,
) {
  return fresh ? { requireOnline: true, maxAttempts: 1, signal } : { signal };
}

export async function getAiRegressionSettings(
  options: { signal?: AbortSignal; fresh?: boolean } = {},
): Promise<AiRegressionSettings> {
  const response = await api.get<unknown>(
    "/api/v1/ai-regression/settings",
    freshReadOptions(options.fresh, options.signal),
  );
  return decodeSettings(response);
}

export async function updateAiRegressionSettings(
  settings: AiRegressionSettings,
  signal?: AbortSignal,
): Promise<AiRegressionSettings> {
  const error = aiRegressionSettingsError(settings);
  if (error) throw new Error(error);
  const response = await api.put<unknown>(
    "/api/v1/ai-regression/settings",
    {
      warn_threshold: settings.warnThreshold,
      hard_gate_enabled: settings.hardGateEnabled,
      hard_gate_threshold: settings.hardGateThreshold,
      min_examples_for_gate: settings.minExamplesForGate,
    },
    { requireOnline: true, maxAttempts: 1, signal },
  );
  return decodeSettings(response);
}

export function aiRegressionSettingsError(
  settings: AiRegressionSettings,
): string | null {
  if (
    !Number.isFinite(settings.warnThreshold) ||
    settings.warnThreshold < 0 ||
    settings.warnThreshold > 100
  ) {
    return "Warning threshold must be between 0 and 100.";
  }
  if (
    !Number.isFinite(settings.hardGateThreshold) ||
    settings.hardGateThreshold < 0 ||
    settings.hardGateThreshold > 100
  ) {
    return "Threshold outcome must be between 0 and 100.";
  }
  if (
    !Number.isInteger(settings.minExamplesForGate) ||
    settings.minExamplesForGate < 1 ||
    settings.minExamplesForGate > 2_147_483_647
  ) {
    return "Minimum scored examples must be between 1 and 2,147,483,647.";
  }
  return null;
}

export async function listAiRegressionRuns(
  options: { signal?: AbortSignal; fresh?: boolean; limit?: number } = {},
): Promise<AiRegressionRun[]> {
  const limit = options.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("Run limit must be between 1 and 200.");
  }
  const response = await api.get<unknown>(
    `/api/v1/ai-regression/runs?limit=${limit}`,
    freshReadOptions(options.fresh, options.signal),
  );
  return decodeCollection(response, "AI regression run list", limit, decodeRun);
}

export async function getAiRegressionRun(
  id: string,
  options: { signal?: AbortSignal; fresh?: boolean } = {},
): Promise<AiRegressionRun> {
  const runId = uuidValue(id, "run id");
  const response = await api.get<unknown>(
    `/api/v1/ai-regression/runs/${encodeURIComponent(runId)}`,
    freshReadOptions(options.fresh, options.signal),
  );
  const run = decodeRun(response);
  if (run.id !== runId) {
    throw new AiRegressionContractError(
      "The run response did not match the requested run.",
    );
  }
  return run;
}

export async function listAiRegressionRunResults(
  id: string,
  options: { signal?: AbortSignal; fresh?: boolean } = {},
): Promise<AiRegressionResult[]> {
  const runId = uuidValue(id, "run id");
  const response = await api.get<unknown>(
    `/api/v1/ai-regression/runs/${encodeURIComponent(runId)}/results`,
    freshReadOptions(options.fresh, options.signal),
  );
  return decodeCollection(
    response,
    "AI regression result list",
    10_000,
    decodeResult,
  );
}

export async function listGoldenExamples(
  options: {
    signal?: AbortSignal;
    fresh?: boolean;
    surfaceKind?: AiRegressionSurface;
    limit?: number;
  } = {},
): Promise<GoldenExample[]> {
  const limit = options.limit ?? 500;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Golden-example limit must be between 1 and 500.");
  }
  if (
    options.surfaceKind &&
    !AI_REGRESSION_SURFACES.includes(options.surfaceKind)
  ) {
    throw new Error("Golden-example surface is invalid.");
  }
  const search = new URLSearchParams({ limit: String(limit) });
  if (options.surfaceKind) search.set("surface_kind", options.surfaceKind);
  const response = await api.get<unknown>(
    `/api/v1/ai-regression/golden-examples?${search.toString()}`,
    freshReadOptions(options.fresh, options.signal),
  );
  const examples = decodeCollection(
    response,
    "golden-example list",
    limit,
    decodeGolden,
  );
  if (
    options.surfaceKind &&
    examples.some((example) => example.surfaceKind !== options.surfaceKind)
  ) {
    throw new AiRegressionContractError(
      "The golden-example list did not honor its surface filter.",
    );
  }
  return examples;
}

export function goldenCaptureDraftError(
  input: CaptureGoldenExampleInput,
): string | null {
  if (!UUID_PATTERN.test(input.requestId))
    return "A secure lowercase UUID request identifier is required.";
  if (!AI_REGRESSION_SURFACES.includes(input.surfaceKind))
    return "Surface is invalid.";
  const brief = input.brief.trim();
  const output = input.approvedOutput.trim();
  if (!brief) return "Brief is required.";
  if (Array.from(brief).length > 8_000)
    return "Brief must be 8,000 characters or fewer.";
  if (!output) return "Human-approved output is required.";
  if (Array.from(output).length > 32_000)
    return "Human-approved output must be 32,000 characters or fewer.";
  const wire = {
    request_id: input.requestId,
    surface_kind: input.surfaceKind,
    brief,
    approved_output: output,
  };
  if (encoder.encode(JSON.stringify(wire)).length > MAX_REQUEST_BYTES) {
    return "The golden-reference request exceeds the server's safe body limit.";
  }
  return null;
}

export function newGoldenCaptureRequestId(): string {
  return newUUIDv7();
}

export async function captureGoldenExample(
  input: CaptureGoldenExampleInput,
  signal?: AbortSignal,
): Promise<GoldenExample> {
  const error = goldenCaptureDraftError(input);
  if (error) throw new Error(error);
  const response = await api.post<unknown>(
    "/api/v1/ai-regression/golden-examples",
    {
      request_id: input.requestId,
      surface_kind: input.surfaceKind,
      brief: input.brief.trim(),
      approved_output: input.approvedOutput.trim(),
    },
    { requireOnline: true, maxAttempts: 1, signal },
  );
  const example = decodeGolden(response);
  if (example.requestId !== input.requestId) {
    throw new AiRegressionContractError(
      "The golden-reference receipt did not match this capture attempt.",
    );
  }
  return example;
}

export async function archiveGoldenExample(
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  const exampleId = uuidValue(id, "golden example id");
  await api.delete(
    `/api/v1/ai-regression/golden-examples/${encodeURIComponent(exampleId)}`,
    { requireOnline: true, maxAttempts: 1, signal },
  );
}

export async function triggerAiRegressionRun(
  modelVersionTag: string,
  signal?: AbortSignal,
): Promise<TriggerAiRegressionRunReceipt> {
  const label = modelVersionTag.trim();
  if (!label || Array.from(label).length > 160) {
    throw new Error("Release correlation label must be 1 to 160 characters.");
  }
  if (
    Array.from(label).some((character) =>
      /[\u0000-\u001f\u007f]/u.test(character),
    )
  ) {
    throw new Error(
      "Release correlation label cannot contain control characters.",
    );
  }
  const response = await api.post<unknown>(
    "/api/v1/ai-regression/runs",
    { model_version_tag: label },
    { requireOnline: true, maxAttempts: 1, signal },
  );
  const record = recordValue(response, "run trigger receipt", [
    "run_id",
    "status",
    "runtime",
  ]);
  if (record.status !== "pending") {
    throw new AiRegressionContractError(
      "The run trigger did not return a pending durable receipt.",
    );
  }
  const runtime = recordValue(
    required(record, "runtime", "run trigger receipt"),
    "run trigger receipt.runtime",
    ["provider", "model_id", "prompt_policy_version"],
  );
  return {
    runId: uuidValue(
      required(record, "run_id", "run trigger receipt"),
      "run trigger receipt.run_id",
    ),
    status: "pending",
    runtime: {
      provider: textValue(
        required(runtime, "provider", "run trigger receipt.runtime"),
        "run trigger receipt.runtime.provider",
        100,
      ),
      modelId: textValue(
        required(runtime, "model_id", "run trigger receipt.runtime"),
        "run trigger receipt.runtime.model_id",
        200,
      ),
      promptPolicyVersion: textValue(
        required(
          runtime,
          "prompt_policy_version",
          "run trigger receipt.runtime",
        ),
        "run trigger receipt.runtime.prompt_policy_version",
        160,
      ),
    },
  };
}

export function sameAiRegressionSettings(
  left: AiRegressionSettings,
  right: AiRegressionSettings,
): boolean {
  return (
    left.warnThreshold === right.warnThreshold &&
    left.hardGateEnabled === right.hardGateEnabled &&
    left.hardGateThreshold === right.hardGateThreshold &&
    left.minExamplesForGate === right.minExamplesForGate
  );
}

export function sameGoldenExampleRevision(
  left: GoldenExample,
  right: GoldenExample,
): boolean {
  return (
    left.id === right.id &&
    left.surfaceKind === right.surfaceKind &&
    left.brief === right.brief &&
    left.modelId === right.modelId &&
    left.requestId === right.requestId &&
    left.approvalId === right.approvalId &&
    left.agentRunId === right.agentRunId &&
    left.createdAt === right.createdAt
  );
}

export function gateIsInert(
  settings: AiRegressionSettings,
  exampleCount: number,
): boolean {
  return exampleCount < settings.minExamplesForGate;
}

/** Null means a 500-row collection cap prevents an honest conclusion. */
export function currentGateCorpusEligibility(
  settings: AiRegressionSettings,
  loadedExampleCount: number,
): "eligible" | "inert" | null {
  if (loadedExampleCount >= settings.minExamplesForGate) return "eligible";
  if (loadedExampleCount >= 500) return null;
  return "inert";
}
