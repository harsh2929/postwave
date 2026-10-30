import type { ApiResult } from "./result";

export interface AiRegressionRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

export type AiRegressionRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: AiRegressionRequestOptions,
) => Promise<ApiResult<T>>;

export interface AiRegressionOperationsDependencies {
  request: AiRegressionRequester;
}

const ONLINE_SINGLE_ATTEMPT: AiRegressionRequestOptions = {
  maxAttempts: 1,
  requireOnline: true,
};

// Poll owners already provide their own cadence and in-flight lock. Keep a
// polling read alive across the five-second cadence, and never let the shared
// transport add an overlapping retry behind that owner's back.
const POLLING_READ_OPTIONS: AiRegressionRequestOptions = {
  timeoutMs: 15_000,
  maxAttempts: 1,
};

export interface GoldenExample {
  id: string;
  request_id?: string | null;
  surface_kind: string;
  brief: string;
  model_id: string;
  approval_id?: string;
  agent_run_id?: string;
  created_at: string;
}

export interface SurfaceResult {
  total: number;
  scored: number;
  errors: number;
  passed: number;
  mean_score: number | null;
  gate_result: "pass" | "fail" | "advisory";
}

export type RegressionRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export interface RegressionRun {
  id: string;
  runtime_provider: string;
  model_id: string;
  model_version_tag: string;
  prompt_version_tag: string;
  status: RegressionRunStatus;
  total_examples: number;
  passed_examples: number;
  scored_examples: number;
  error_examples: number;
  fidelity_score_mean?: number;
  fidelity_score_p25?: number;
  gate_result?: "pass" | "fail" | "advisory";
  warn_threshold: number;
  hard_gate_enabled: boolean;
  hard_gate_threshold?: number;
  min_examples_for_gate: number;
  max_attempts: number;
  error_message?: string;
  error_code?: string;
  by_surface?: Record<string, SurfaceResult>;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  snapshot_frozen_at?: string;
  lease_expires_at?: string;
  heartbeat_at?: string;
  attempt_count: number;
  retry_not_before?: string;
  stale_at?: string;
  updated_at: string;
}

export type RegressionResultSeverity = "ok" | "warn" | "critical" | "error";

export interface RegressionResult {
  id: string;
  example_id?: string;
  attempt_count: number;
  surface_kind: string;
  brief?: string;
  approved_output?: string;
  source_model_id?: string;
  voice_profile_version?: string;
  approval_id?: string | null;
  agent_run_id?: string | null;
  source_created_at?: string | null;
  snapshotted_at?: string | null;
  snapshot_ordinal?: number | null;
  replayed_output?: string;
  fidelity_score?: number;
  breakdown?: Record<string, unknown>;
  severity: RegressionResultSeverity;
  error_code?: string;
  error_message?: string;
  scored_at: string;
}

export interface RegressionSettings {
  warn_threshold: number;
  hard_gate_enabled: boolean;
  hard_gate_threshold: number;
  min_examples_for_gate: number;
}

export interface CaptureGoldenExampleInput {
  request_id: string;
  surface_kind: string;
  brief: string;
  approved_output: string;
}

export interface TriggerRegressionRunInput {
  model_version_tag: string;
}

export interface TriggerRegressionRunReceipt {
  run_id: string;
  status: "pending";
  runtime: {
    provider: string;
    model_id: string;
    prompt_policy_version: string;
  };
}

type JsonRecord = Record<string, unknown>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SURFACE_KINDS = new Set([
  "campaign_draft",
  "subject_line",
  "sequence_draft",
  "campaign_summary",
  "reply_intent",
]);
const RUN_STATUSES = new Set<RegressionRunStatus>([
  "pending",
  "running",
  "completed",
  "failed",
]);
const GATE_RESULTS = new Set(["pass", "fail", "advisory"]);
const RESULT_SEVERITIES = new Set<RegressionResultSeverity>([
  "ok",
  "warn",
  "critical",
  "error",
]);

class AiRegressionContractError extends Error {}

function recordValue(
  value: unknown,
  context: string,
  allowedKeys: readonly string[],
): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AiRegressionContractError(`${context} must be an object`);
  }
  const record = value as JsonRecord;
  const allowed = new Set(allowedKeys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new AiRegressionContractError(`${context} has unknown fields`);
  }
  return record;
}

function requiredValue(
  record: JsonRecord,
  key: string,
  context: string,
): unknown {
  if (!Object.hasOwn(record, key)) {
    throw new AiRegressionContractError(`${context}.${key} is required`);
  }
  return record[key];
}

function stringValue(
  value: unknown,
  context: string,
  maxLength: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.trim().length === 0) ||
    value.length > maxLength
  ) {
    throw new AiRegressionContractError(`${context} must be a valid string`);
  }
  return value;
}

function uuidValue(value: unknown, context: string): string {
  const id = stringValue(value, context, 36);
  if (!UUID_PATTERN.test(id)) {
    throw new AiRegressionContractError(`${context} must be a lowercase UUID`);
  }
  return id;
}

function dateValue(value: unknown, context: string): string {
  const timestamp = stringValue(value, context, 64);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new AiRegressionContractError(`${context} must be a date-time`);
  }
  return timestamp;
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
    throw new AiRegressionContractError(`${context} is out of range`);
  }
  return value;
}

function integerValue(
  value: unknown,
  context: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const number = numberValue(value, context, minimum, maximum);
  if (!Number.isInteger(number)) {
    throw new AiRegressionContractError(`${context} must be an integer`);
  }
  return number;
}

function optionalValue(
  record: JsonRecord,
  key: string,
  context: string,
  validate: (value: unknown, context: string) => unknown,
  nullable = true,
): void {
  if (!Object.hasOwn(record, key)) return;
  const value = record[key];
  if (value === null && nullable) return;
  validate(value, `${context}.${key}`);
}

function enumValue<T extends string>(
  value: unknown,
  context: string,
  allowed: ReadonlySet<T>,
): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new AiRegressionContractError(`${context} has an invalid value`);
  }
  return value as T;
}

function surfaceKindValue(value: unknown, context: string): string {
  return enumValue(value, context, SURFACE_KINDS);
}

function scoreValue(value: unknown, context: string): number {
  return numberValue(value, context, 0, 100);
}

const GOLDEN_KEYS = [
  "id",
  "request_id",
  "surface_kind",
  "brief",
  "model_id",
  "approval_id",
  "agent_run_id",
  "created_at",
] as const;

function decodeGoldenExample(value: unknown): GoldenExample {
  const context = "golden example";
  const record = recordValue(value, context, GOLDEN_KEYS);
  uuidValue(requiredValue(record, "id", context), `${context}.id`);
  surfaceKindValue(
    requiredValue(record, "surface_kind", context),
    `${context}.surface_kind`,
  );
  stringValue(
    requiredValue(record, "brief", context),
    `${context}.brief`,
    8000,
  );
  stringValue(
    requiredValue(record, "model_id", context),
    `${context}.model_id`,
    200,
  );
  dateValue(
    requiredValue(record, "created_at", context),
    `${context}.created_at`,
  );
  optionalValue(record, "approval_id", context, uuidValue);
  optionalValue(record, "agent_run_id", context, uuidValue);
  optionalValue(record, "request_id", context, uuidValue);
  return record as unknown as GoldenExample;
}

const SURFACE_RECEIPT_KEYS = [
  "total",
  "scored",
  "errors",
  "passed",
  "mean_score",
  "gate_result",
] as const;

function decodeSurfaceResult(value: unknown, context: string): SurfaceResult {
  const record = recordValue(value, context, SURFACE_RECEIPT_KEYS);
  for (const key of ["total", "scored", "errors", "passed"] as const) {
    integerValue(requiredValue(record, key, context), `${context}.${key}`, 0);
  }
  const mean = requiredValue(record, "mean_score", context);
  if (mean !== null) scoreValue(mean, `${context}.mean_score`);
  enumValue(
    requiredValue(record, "gate_result", context),
    `${context}.gate_result`,
    GATE_RESULTS,
  );
  return record as unknown as SurfaceResult;
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

function decodeBySurface(value: unknown): Record<string, SurfaceResult> {
  const record = recordValue(value, "run.by_surface", [...SURFACE_KINDS]);
  for (const [surface, receipt] of Object.entries(record)) {
    decodeSurfaceResult(receipt, `run.by_surface.${surface}`);
  }
  return record as Record<string, SurfaceResult>;
}

function decodeRegressionRun(value: unknown): RegressionRun {
  const context = "run";
  const record = recordValue(value, context, RUN_KEYS);
  uuidValue(requiredValue(record, "id", context), `${context}.id`);
  for (const [key, maxLength] of [
    ["runtime_provider", 100],
    ["model_id", 200],
    ["model_version_tag", 160],
    ["prompt_version_tag", 160],
  ] as const) {
    stringValue(
      requiredValue(record, key, context),
      `${context}.${key}`,
      maxLength,
    );
  }
  enumValue(
    requiredValue(record, "status", context),
    `${context}.status`,
    RUN_STATUSES,
  );
  integerValue(
    requiredValue(record, "total_examples", context),
    `${context}.total_examples`,
    1,
  );
  for (const key of [
    "passed_examples",
    "scored_examples",
    "error_examples",
  ] as const) {
    integerValue(requiredValue(record, key, context), `${context}.${key}`, 0);
  }
  scoreValue(
    requiredValue(record, "warn_threshold", context),
    `${context}.warn_threshold`,
  );
  if (
    typeof requiredValue(record, "hard_gate_enabled", context) !== "boolean"
  ) {
    throw new AiRegressionContractError(
      `${context}.hard_gate_enabled must be boolean`,
    );
  }
  integerValue(
    requiredValue(record, "min_examples_for_gate", context),
    `${context}.min_examples_for_gate`,
    1,
    2_147_483_647,
  );
  integerValue(
    requiredValue(record, "max_attempts", context),
    `${context}.max_attempts`,
    1,
    20,
  );
  integerValue(
    requiredValue(record, "attempt_count", context),
    `${context}.attempt_count`,
    0,
    20,
  );
  dateValue(
    requiredValue(record, "created_at", context),
    `${context}.created_at`,
  );
  dateValue(
    requiredValue(record, "updated_at", context),
    `${context}.updated_at`,
  );
  for (const key of [
    "fidelity_score_mean",
    "fidelity_score_p25",
    "hard_gate_threshold",
  ] as const) {
    optionalValue(record, key, context, scoreValue);
  }
  optionalValue(record, "gate_result", context, (item, itemContext) =>
    enumValue(item, itemContext, GATE_RESULTS),
  );
  optionalValue(record, "error_message", context, (item, itemContext) =>
    stringValue(item, itemContext, 1000, true),
  );
  optionalValue(record, "error_code", context, (item, itemContext) =>
    stringValue(item, itemContext, 64),
  );
  for (const key of [
    "started_at",
    "completed_at",
    "snapshot_frozen_at",
    "lease_expires_at",
    "heartbeat_at",
    "retry_not_before",
    "stale_at",
  ] as const) {
    optionalValue(record, key, context, dateValue);
  }
  optionalValue(record, "by_surface", context, decodeBySurface, false);
  return record as unknown as RegressionRun;
}

const BREAKDOWN_KEYS = [
  "embedding_similarity",
  "stylistic_distance",
  "vocabulary_overlap",
  "structural_match",
  "combined",
] as const;

function decodeBreakdown(value: unknown): Record<string, unknown> {
  const context = "result.breakdown";
  const record = recordValue(value, context, BREAKDOWN_KEYS);
  for (const key of BREAKDOWN_KEYS.slice(0, 4)) {
    numberValue(requiredValue(record, key, context), `${context}.${key}`, 0, 1);
  }
  scoreValue(requiredValue(record, "combined", context), `${context}.combined`);
  return record;
}

const RESULT_KEYS = [
  "id",
  "example_id",
  "attempt_count",
  "surface_kind",
  "brief",
  "approved_output",
  "source_model_id",
  "voice_profile_version",
  "approval_id",
  "agent_run_id",
  "source_created_at",
  "snapshotted_at",
  "snapshot_ordinal",
  "replayed_output",
  "fidelity_score",
  "breakdown",
  "severity",
  "error_code",
  "error_message",
  "scored_at",
] as const;

function decodeRegressionResult(value: unknown): RegressionResult {
  const context = "result";
  const record = recordValue(value, context, RESULT_KEYS);
  uuidValue(requiredValue(record, "id", context), `${context}.id`);
  integerValue(
    requiredValue(record, "attempt_count", context),
    `${context}.attempt_count`,
    1,
    20,
  );
  surfaceKindValue(
    requiredValue(record, "surface_kind", context),
    `${context}.surface_kind`,
  );
  enumValue(
    requiredValue(record, "severity", context),
    `${context}.severity`,
    RESULT_SEVERITIES,
  );
  dateValue(
    requiredValue(record, "scored_at", context),
    `${context}.scored_at`,
  );
  for (const key of ["example_id", "approval_id", "agent_run_id"] as const) {
    optionalValue(record, key, context, uuidValue);
  }
  for (const key of ["source_created_at", "snapshotted_at"] as const) {
    optionalValue(record, key, context, dateValue);
  }
  for (const [key, maxLength, allowEmpty] of [
    ["brief", 8000, false],
    ["approved_output", 32_000, false],
    ["source_model_id", 200, false],
    ["voice_profile_version", 200, false],
    ["replayed_output", 32_000, false],
    ["error_code", 64, false],
    ["error_message", 1000, true],
  ] as const) {
    optionalValue(record, key, context, (item, itemContext) =>
      stringValue(item, itemContext, maxLength, allowEmpty),
    );
  }
  optionalValue(record, "snapshot_ordinal", context, (item, itemContext) =>
    integerValue(item, itemContext, 1),
  );
  optionalValue(record, "fidelity_score", context, scoreValue);
  optionalValue(record, "breakdown", context, decodeBreakdown);
  return record as unknown as RegressionResult;
}

function decodeSettings(value: unknown): RegressionSettings {
  const context = "settings";
  const record = recordValue(value, context, [
    "warn_threshold",
    "hard_gate_enabled",
    "hard_gate_threshold",
    "min_examples_for_gate",
  ]);
  scoreValue(
    requiredValue(record, "warn_threshold", context),
    `${context}.warn_threshold`,
  );
  if (
    typeof requiredValue(record, "hard_gate_enabled", context) !== "boolean"
  ) {
    throw new AiRegressionContractError(
      `${context}.hard_gate_enabled must be boolean`,
    );
  }
  scoreValue(
    requiredValue(record, "hard_gate_threshold", context),
    `${context}.hard_gate_threshold`,
  );
  integerValue(
    requiredValue(record, "min_examples_for_gate", context),
    `${context}.min_examples_for_gate`,
    1,
    2_147_483_647,
  );
  return record as unknown as RegressionSettings;
}

function decodeTriggerReceipt(value: unknown): TriggerRegressionRunReceipt {
  const context = "trigger receipt";
  const record = recordValue(value, context, ["run_id", "status", "runtime"]);
  uuidValue(requiredValue(record, "run_id", context), `${context}.run_id`);
  if (requiredValue(record, "status", context) !== "pending") {
    throw new AiRegressionContractError(`${context}.status must be pending`);
  }
  const runtimeContext = `${context}.runtime`;
  const runtime = recordValue(
    requiredValue(record, "runtime", context),
    runtimeContext,
    ["provider", "model_id", "prompt_policy_version"],
  );
  stringValue(
    requiredValue(runtime, "provider", runtimeContext),
    `${runtimeContext}.provider`,
    100,
  );
  stringValue(
    requiredValue(runtime, "model_id", runtimeContext),
    `${runtimeContext}.model_id`,
    200,
  );
  stringValue(
    requiredValue(runtime, "prompt_policy_version", runtimeContext),
    `${runtimeContext}.prompt_policy_version`,
    160,
  );
  return record as unknown as TriggerRegressionRunReceipt;
}

function decodeList<T>(
  value: unknown,
  context: string,
  decodeItem: (item: unknown) => T,
  maxItems?: number,
): { items: T[] } {
  const record = recordValue(value, context, ["items"]);
  const items = requiredValue(record, "items", context);
  if (
    !Array.isArray(items) ||
    (maxItems !== undefined && items.length > maxItems)
  ) {
    throw new AiRegressionContractError(
      `${context}.items must be a bounded array`,
    );
  }
  items.forEach(decodeItem);
  return record as { items: T[] };
}

function decodeResult<T>(
  result: ApiResult<unknown>,
  resource: string,
  decode: (value: unknown) => T,
): ApiResult<T> {
  if (result.error) return result;
  try {
    return {
      data: decode(result.data),
      ...(result.serverVersion ? { serverVersion: result.serverVersion } : {}),
    };
  } catch {
    return {
      error: {
        kind: "parse",
        code: "invalid_ai_regression_response_contract",
        message: `The server returned malformed ${resource}. No missing or malformed response was treated as empty or successfully saved.`,
      },
      retryability: "manual",
    };
  }
}

export function createListGoldenExamples({
  request,
}: AiRegressionOperationsDependencies) {
  return function listGoldenExamples(params?: {
    surface_kind?: string;
    limit?: number;
  }): Promise<ApiResult<{ items: GoldenExample[] }>> {
    const q = new URLSearchParams();
    if (params?.surface_kind) q.set("surface_kind", params.surface_kind);
    if (params?.limit) q.set("limit", String(params.limit));
    const qs = q.toString();
    return request<unknown>(
      `/api/v1/ai-regression/golden-examples${qs ? `?${qs}` : ""}`,
    ).then((result) =>
      decodeResult(result, "golden-reference list", (value) =>
        decodeList(value, "golden-reference list", decodeGoldenExample, 500),
      ),
    );
  };
}

export function createCaptureGoldenExample({
  request,
}: AiRegressionOperationsDependencies) {
  return function captureGoldenExample(
    input: CaptureGoldenExampleInput,
  ): Promise<ApiResult<GoldenExample>> {
    if (!UUID_PATTERN.test(input.request_id)) {
      return Promise.resolve({
        error: {
          kind: "invalid_config",
          code: "invalid_ai_regression_capture_request_id",
          message:
            "A lowercase UUID request identity is required before saving this golden reference.",
        },
        retryability: "not-retryable",
        preservedDraft: input,
      });
    }
    return request<unknown>(
      "/api/v1/ai-regression/golden-examples",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      ONLINE_SINGLE_ATTEMPT,
    ).then((result) =>
      decodeResult(result, "golden-reference receipt", decodeGoldenExample),
    );
  };
}

export function createArchiveGoldenExample({
  request,
}: AiRegressionOperationsDependencies) {
  return function archiveGoldenExample(id: string): Promise<ApiResult<void>> {
    return request<void>(
      `/api/v1/ai-regression/golden-examples/${encodeURIComponent(id)}`,
      { method: "DELETE" },
      ONLINE_SINGLE_ATTEMPT,
    );
  };
}

export function createTriggerRegressionRun({
  request,
}: AiRegressionOperationsDependencies) {
  return function triggerRegressionRun(
    input: TriggerRegressionRunInput,
  ): Promise<ApiResult<TriggerRegressionRunReceipt>> {
    return request<unknown>(
      "/api/v1/ai-regression/runs",
      { method: "POST", body: JSON.stringify(input) },
      ONLINE_SINGLE_ATTEMPT,
    ).then((result) =>
      decodeResult(
        result,
        "AI regression trigger receipt",
        decodeTriggerReceipt,
      ),
    );
  };
}

export function createListRegressionRuns({
  request,
}: AiRegressionOperationsDependencies) {
  return function listRegressionRuns(params?: {
    limit?: number;
  }): Promise<ApiResult<{ items: RegressionRun[] }>> {
    const q = new URLSearchParams();
    if (params?.limit) q.set("limit", String(params.limit));
    const qs = q.toString();
    return request<unknown>(
      `/api/v1/ai-regression/runs${qs ? `?${qs}` : ""}`,
      undefined,
      POLLING_READ_OPTIONS,
    ).then((result) =>
      decodeResult(result, "AI regression run list", (value) =>
        decodeList(value, "run list", decodeRegressionRun, 200),
      ),
    );
  };
}

export function createGetLatestRegressionRun({
  request,
}: AiRegressionOperationsDependencies) {
  return function getLatestRegressionRun(): Promise<
    ApiResult<{ run: RegressionRun | null }>
  > {
    // Server returns {run: RegressionRun|null}; callers read res.data?.run.
    return request<unknown>(
      "/api/v1/ai-regression/runs/latest",
      undefined,
      POLLING_READ_OPTIONS,
    ).then((result) =>
      decodeResult(result, "latest AI regression run receipt", (value) => {
        const context = "latest run receipt";
        const record = recordValue(value, context, ["run"]);
        const run = requiredValue(record, "run", context);
        if (run !== null) decodeRegressionRun(run);
        return record as { run: RegressionRun | null };
      }),
    );
  };
}

export function createGetRegressionRun({
  request,
}: AiRegressionOperationsDependencies) {
  return function getRegressionRun(
    runId: string,
  ): Promise<ApiResult<RegressionRun>> {
    return request<unknown>(
      `/api/v1/ai-regression/runs/${encodeURIComponent(runId)}`,
    ).then((result) =>
      decodeResult(result, "AI regression run receipt", decodeRegressionRun),
    );
  };
}

export function createGetRegressionRunResults({
  request,
}: AiRegressionOperationsDependencies) {
  return function getRegressionRunResults(
    runId: string,
  ): Promise<ApiResult<{ items: RegressionResult[] }>> {
    return request<unknown>(
      `/api/v1/ai-regression/runs/${encodeURIComponent(runId)}/results`,
    ).then((result) =>
      decodeResult(result, "AI regression result list", (value) =>
        decodeList(value, "result list", decodeRegressionResult),
      ),
    );
  };
}

export function createGetRegressionSettings({
  request,
}: AiRegressionOperationsDependencies) {
  return function getRegressionSettings(): Promise<
    ApiResult<RegressionSettings>
  > {
    return request<unknown>("/api/v1/ai-regression/settings").then((result) =>
      decodeResult(result, "AI regression settings receipt", decodeSettings),
    );
  };
}

export function createUpdateRegressionSettings({
  request,
}: AiRegressionOperationsDependencies) {
  return function updateRegressionSettings(
    settings: RegressionSettings,
  ): Promise<ApiResult<RegressionSettings>> {
    return request<unknown>(
      "/api/v1/ai-regression/settings",
      {
        method: "PUT",
        body: JSON.stringify(settings),
      },
      ONLINE_SINGLE_ATTEMPT,
    ).then((result) =>
      decodeResult(
        result,
        "saved AI regression settings receipt",
        decodeSettings,
      ),
    );
  };
}

export function createAiRegressionOperationsMethods(
  dependencies: AiRegressionOperationsDependencies,
) {
  return {
    listGoldenExamples: createListGoldenExamples(dependencies),
    captureGoldenExample: createCaptureGoldenExample(dependencies),
    archiveGoldenExample: createArchiveGoldenExample(dependencies),
    triggerRegressionRun: createTriggerRegressionRun(dependencies),
    listRegressionRuns: createListRegressionRuns(dependencies),
    getLatestRegressionRun: createGetLatestRegressionRun(dependencies),
    getRegressionRun: createGetRegressionRun(dependencies),
    getRegressionRunResults: createGetRegressionRunResults(dependencies),
    getRegressionSettings: createGetRegressionSettings(dependencies),
    updateRegressionSettings: createUpdateRegressionSettings(dependencies),
  };
}
