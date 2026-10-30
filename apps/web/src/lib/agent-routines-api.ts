// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "@/lib/api";
import {
  effectiveAuthRole,
  whoamiFresh,
  type AuthRole,
  type MeResponse,
} from "@/lib/auth-api";

export const AGENT_ROUTINE_KINDS = [
  "draft_campaign",
  "draft_sequence",
] as const;
export const AGENT_ROUTINE_SCHEDULES = [
  "manual",
  "daily",
  "weekly",
  "monthly",
] as const;

export type AgentRoutineKind = (typeof AGENT_ROUTINE_KINDS)[number];
export type AgentRoutineSchedule = (typeof AGENT_ROUTINE_SCHEDULES)[number];
export type AgentRoutineRunStatus = "running" | "succeeded" | "failed";

export interface AgentRoutine {
  id: string;
  name: string;
  prompt: string;
  kind: AgentRoutineKind;
  schedule: AgentRoutineSchedule;
  scheduleDetail: Record<string, unknown>;
  /** Deprecated, inert backend value. It is never used as a runtime target. */
  legacyTargetListId: string | null;
  targetSegmentId: string | null;
  requireApproval: boolean;
  enabled: boolean;
  hasActiveRun: boolean;
  lastRunAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  version: string | null;
}

export interface AgentRoutineDraftStep {
  position: number;
  delayHours: number;
  subject: string;
  body: string;
}

export type AgentRoutineDraftPreview =
  | {
      kind: "campaign";
      name: string;
      subject: string;
      previewText: string;
      body: string;
    }
  | {
      kind: "sequence";
      name: string;
      steps: AgentRoutineDraftStep[];
    };

export interface AgentRoutineRun {
  id: string;
  routineId: string;
  status: AgentRoutineRunStatus;
  outputKind: "campaign" | "sequence" | null;
  outputRef: string | null;
  approvalId: string | null;
  /** Bounded operator-safe text. The UI does not interpolate it as markup. */
  error: string | null;
  promptUsed: string | null;
  contextUsed: string | null;
  reasoning: string | null;
  draftPreview: AgentRoutineDraftPreview | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface AgentRoutineDraft {
  name: string;
  prompt: string;
  kind: AgentRoutineKind;
  schedule: AgentRoutineSchedule;
  targetSegmentId: string;
  requireApproval: boolean;
  enabled: boolean;
  clearLegacyTargetList?: boolean;
}

type JsonRecord = Record<string, unknown>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MAX_COLLECTION_ROWS = 1_000;
const MAX_REQUEST_BYTES = 60 * 1024;
const encoder = new TextEncoder();

export class AgentRoutinesContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRoutinesContractError";
  }
}

function recordValue(
  value: unknown,
  context: string,
  allowedKeys: readonly string[],
): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentRoutinesContractError(`${context} must be an object.`);
  }
  const record = value as JsonRecord;
  const allowed = new Set(allowedKeys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new AgentRoutinesContractError(
      `${context} contains an unexpected field.`,
    );
  }
  return record;
}

function required(record: JsonRecord, key: string, context: string): unknown {
  if (!Object.hasOwn(record, key)) {
    throw new AgentRoutinesContractError(`${context}.${key} is required.`);
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
    throw new AgentRoutinesContractError(`${context} is invalid.`);
  }
  return value;
}

function optionalText(
  record: JsonRecord,
  key: string,
  context: string,
  maxCodePoints: number,
): string | null {
  if (!Object.hasOwn(record, key) || record[key] === null) return null;
  return textValue(record[key], `${context}.${key}`, maxCodePoints, true);
}

function uuidValue(value: unknown, context: string): string {
  const valueString = textValue(value, context, 36);
  if (!UUID_PATTERN.test(valueString)) {
    throw new AgentRoutinesContractError(
      `${context} must be a lowercase UUID.`,
    );
  }
  return valueString;
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
  const valueString = textValue(value, context, 64);
  if (!Number.isFinite(Date.parse(valueString))) {
    throw new AgentRoutinesContractError(`${context} must be a date-time.`);
  }
  return valueString;
}

function optionalDate(
  record: JsonRecord,
  key: string,
  context: string,
): string | null {
  if (!Object.hasOwn(record, key) || record[key] === null) return null;
  return dateValue(record[key], `${context}.${key}`);
}

function booleanValue(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") {
    throw new AgentRoutinesContractError(`${context} must be a boolean.`);
  }
  return value;
}

function enumValue<T extends string>(
  value: unknown,
  context: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new AgentRoutinesContractError(`${context} has an invalid value.`);
  }
  return value as T;
}

function boundedRecord(value: unknown, context: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentRoutinesContractError(`${context} must be an object.`);
  }
  let encoded = "";
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new AgentRoutinesContractError(`${context} is not valid JSON.`);
  }
  if (encoder.encode(encoded).length > 8_192) {
    throw new AgentRoutinesContractError(`${context} is too large.`);
  }
  return value as JsonRecord;
}

const ROUTINE_KEYS = [
  "id",
  "name",
  "prompt",
  "kind",
  "schedule",
  "schedule_detail",
  "target_list_id",
  "target_segment_id",
  "require_approval",
  "enabled",
  "has_active_run",
  "last_run_at",
  "created_by",
  "created_at",
  "updated_at",
  "version",
] as const;

function decodeRoutine(
  value: unknown,
  context = "agent routine",
): AgentRoutine {
  const record = recordValue(value, context, ROUTINE_KEYS);
  const scheduleDetail = Object.hasOwn(record, "schedule_detail")
    ? boundedRecord(record.schedule_detail, `${context}.schedule_detail`)
    : {};
  return {
    id: uuidValue(required(record, "id", context), `${context}.id`),
    name: textValue(required(record, "name", context), `${context}.name`, 200),
    prompt: textValue(
      required(record, "prompt", context),
      `${context}.prompt`,
      8_000,
    ),
    kind: enumValue(
      required(record, "kind", context),
      `${context}.kind`,
      AGENT_ROUTINE_KINDS,
    ),
    schedule: enumValue(
      required(record, "schedule", context),
      `${context}.schedule`,
      AGENT_ROUTINE_SCHEDULES,
    ),
    scheduleDetail,
    legacyTargetListId: optionalUUID(record, "target_list_id", context),
    targetSegmentId: optionalUUID(record, "target_segment_id", context),
    requireApproval: booleanValue(
      required(record, "require_approval", context),
      `${context}.require_approval`,
    ),
    enabled: booleanValue(
      required(record, "enabled", context),
      `${context}.enabled`,
    ),
    hasActiveRun: booleanValue(
      required(record, "has_active_run", context),
      `${context}.has_active_run`,
    ),
    lastRunAt: optionalDate(record, "last_run_at", context),
    createdBy: optionalText(record, "created_by", context, 320),
    createdAt: dateValue(
      required(record, "created_at", context),
      `${context}.created_at`,
    ),
    updatedAt: dateValue(
      required(record, "updated_at", context),
      `${context}.updated_at`,
    ),
    version: optionalText(record, "version", context, 256),
  };
}

const PREVIEW_CAMPAIGN_KEYS = [
  "kind",
  "name",
  "subject",
  "preview_text",
  "body",
] as const;
const PREVIEW_SEQUENCE_KEYS = ["kind", "name", "steps"] as const;
const PREVIEW_STEP_KEYS = [
  "position",
  "delay_hours",
  "subject",
  "body",
] as const;

function integerValue(
  value: unknown,
  context: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new AgentRoutinesContractError(`${context} is out of range.`);
  }
  return value;
}

function decodePreview(value: unknown): AgentRoutineDraftPreview {
  const discriminator = recordValue(value, "run.draft_preview", [
    ...new Set([...PREVIEW_CAMPAIGN_KEYS, ...PREVIEW_SEQUENCE_KEYS]),
  ]);
  if (discriminator.kind === "campaign") {
    const record = recordValue(
      value,
      "run.draft_preview",
      PREVIEW_CAMPAIGN_KEYS,
    );
    return {
      kind: "campaign",
      name: textValue(record.name, "run.draft_preview.name", 200, true),
      subject: textValue(
        record.subject,
        "run.draft_preview.subject",
        255,
        true,
      ),
      previewText: textValue(
        record.preview_text,
        "run.draft_preview.preview_text",
        500,
        true,
      ),
      body: textValue(record.body, "run.draft_preview.body", 8_001, true),
    };
  }
  if (discriminator.kind === "sequence") {
    const record = recordValue(
      value,
      "run.draft_preview",
      PREVIEW_SEQUENCE_KEYS,
    );
    if (!Array.isArray(record.steps) || record.steps.length > 10) {
      throw new AgentRoutinesContractError(
        "run.draft_preview.steps is invalid.",
      );
    }
    const steps = record.steps.map((candidate, index) => {
      const step = recordValue(
        candidate,
        `run.draft_preview.steps[${index}]`,
        PREVIEW_STEP_KEYS,
      );
      return {
        position: integerValue(
          step.position,
          `run.draft_preview.steps[${index}].position`,
          1,
          10,
        ),
        delayHours: integerValue(
          step.delay_hours,
          `run.draft_preview.steps[${index}].delay_hours`,
          0,
          8_760,
        ),
        subject: textValue(
          step.subject,
          `run.draft_preview.steps[${index}].subject`,
          255,
          true,
        ),
        body: textValue(
          step.body,
          `run.draft_preview.steps[${index}].body`,
          8_001,
          true,
        ),
      };
    });
    return {
      kind: "sequence",
      name: textValue(record.name, "run.draft_preview.name", 200, true),
      steps,
    };
  }
  throw new AgentRoutinesContractError(
    "run.draft_preview.kind has an invalid value.",
  );
}

const RUN_KEYS = [
  "id",
  "routine_id",
  "status",
  "output_kind",
  "output_ref",
  "approval_id",
  "error",
  "prompt_used",
  "context_used",
  "reasoning",
  "draft_preview",
  "started_at",
  "finished_at",
] as const;

function decodeRun(
  value: unknown,
  context = "agent routine run",
): AgentRoutineRun {
  const record = recordValue(value, context, RUN_KEYS);
  const outputKind = Object.hasOwn(record, "output_kind")
    ? record.output_kind === null
      ? null
      : enumValue(record.output_kind, `${context}.output_kind`, [
          "campaign",
          "sequence",
        ] as const)
    : null;
  return {
    id: uuidValue(required(record, "id", context), `${context}.id`),
    routineId: uuidValue(
      required(record, "routine_id", context),
      `${context}.routine_id`,
    ),
    status: enumValue(
      required(record, "status", context),
      `${context}.status`,
      ["running", "succeeded", "failed"] as const,
    ),
    outputKind,
    outputRef: optionalText(record, "output_ref", context, 256),
    approvalId: optionalText(record, "approval_id", context, 256),
    error: optionalText(record, "error", context, 4_000),
    promptUsed: optionalText(record, "prompt_used", context, 8_000),
    contextUsed: optionalText(record, "context_used", context, 2_000),
    reasoning: optionalText(record, "reasoning", context, 8_000),
    draftPreview:
      !Object.hasOwn(record, "draft_preview") || record.draft_preview === null
        ? null
        : decodePreview(record.draft_preview),
    startedAt: dateValue(
      required(record, "started_at", context),
      `${context}.started_at`,
    ),
    finishedAt: optionalDate(record, "finished_at", context),
  };
}

function decodeCollection<T>(
  value: unknown,
  context: string,
  decode: (candidate: unknown, candidateContext: string) => T,
  maximum = MAX_COLLECTION_ROWS,
): T[] {
  const record = recordValue(value, context, ["items"]);
  const items = required(record, "items", context);
  if (!Array.isArray(items) || items.length > maximum) {
    throw new AgentRoutinesContractError(`${context}.items is invalid.`);
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

export async function listAgentRoutines(
  options: { signal?: AbortSignal; fresh?: boolean } = {},
): Promise<AgentRoutine[]> {
  const response = await api.get<unknown>(
    "/api/v1/agent-routines",
    freshReadOptions(options.fresh, options.signal),
  );
  return decodeCollection(response, "agent routine list", decodeRoutine);
}

export async function getAgentRoutine(
  id: string,
  options: { signal?: AbortSignal; fresh?: boolean } = {},
): Promise<AgentRoutine> {
  const routineId = uuidValue(id, "routine id");
  const response = await api.get<unknown>(
    `/api/v1/agent-routines/${encodeURIComponent(routineId)}`,
    freshReadOptions(options.fresh, options.signal),
  );
  return decodeRoutine(response);
}

export function routineDraftError(draft: AgentRoutineDraft): string | null {
  const name = draft.name.trim();
  const prompt = draft.prompt.trim();
  if (!name) return "Name is required.";
  if (Array.from(name).length > 200)
    return "Name must be 200 characters or fewer.";
  if (!prompt) return "Brief is required.";
  if (Array.from(prompt).length > 8_000)
    return "Brief must be 8,000 characters or fewer.";
  if (!AGENT_ROUTINE_KINDS.includes(draft.kind))
    return "Draft kind is invalid.";
  if (!AGENT_ROUTINE_SCHEDULES.includes(draft.schedule))
    return "Schedule is invalid.";
  const segment = draft.targetSegmentId.trim();
  if (segment && !UUID_PATTERN.test(segment))
    return "Target segment must be a canonical segment from this workspace.";
  const wire = {
    name,
    prompt,
    kind: draft.kind,
    schedule: draft.schedule,
    ...(segment ? { target_segment_id: segment } : {}),
    require_approval: draft.requireApproval,
    enabled: draft.enabled,
  };
  if (encoder.encode(JSON.stringify(wire)).length > MAX_REQUEST_BYTES) {
    return "The routine request is too large.";
  }
  return null;
}

function normalizedDraft(draft: AgentRoutineDraft) {
  const error = routineDraftError(draft);
  if (error) throw new Error(error);
  return {
    name: draft.name.trim(),
    prompt: draft.prompt.trim(),
    kind: draft.kind,
    schedule: draft.schedule,
    targetSegmentId: draft.targetSegmentId.trim(),
    requireApproval: draft.requireApproval,
    enabled: draft.enabled,
  };
}

export async function createAgentRoutine(
  draft: AgentRoutineDraft,
  signal?: AbortSignal,
): Promise<AgentRoutine> {
  const normalized = normalizedDraft(draft);
  const response = await api.post<unknown>(
    "/api/v1/agent-routines",
    {
      name: normalized.name,
      prompt: normalized.prompt,
      kind: normalized.kind,
      schedule: normalized.schedule,
      ...(normalized.targetSegmentId
        ? { target_segment_id: normalized.targetSegmentId }
        : {}),
      require_approval: normalized.requireApproval,
      enabled: normalized.enabled,
    },
    { requireOnline: true, maxAttempts: 1, signal },
  );
  return decodeRoutine(response);
}

export async function updateAgentRoutine(
  baseline: AgentRoutine,
  draft: AgentRoutineDraft,
  signal?: AbortSignal,
): Promise<AgentRoutine> {
  const normalized = normalizedDraft(draft);
  if (normalized.kind !== baseline.kind) {
    throw new Error("A routine's draft kind cannot be changed after creation.");
  }
  const patch: JsonRecord = {};
  if (normalized.name !== baseline.name) patch.name = normalized.name;
  if (normalized.prompt !== baseline.prompt) patch.prompt = normalized.prompt;
  if (normalized.schedule !== baseline.schedule)
    patch.schedule = normalized.schedule;
  if (normalized.targetSegmentId !== (baseline.targetSegmentId ?? "")) {
    // The backend distinguishes an omitted/null patch (leave unchanged) from
    // the empty-string patch that actually clears the canonical segment.
    patch.target_segment_id = normalized.targetSegmentId;
  }
  if (normalized.requireApproval !== baseline.requireApproval)
    patch.require_approval = normalized.requireApproval;
  if (normalized.enabled !== baseline.enabled)
    patch.enabled = normalized.enabled;
  if (baseline.legacyTargetListId && draft.clearLegacyTargetList)
    patch.target_list_id = "";
  if (Object.keys(patch).length === 0) return baseline;
  if (encoder.encode(JSON.stringify(patch)).length > MAX_REQUEST_BYTES) {
    throw new Error("The routine request is too large.");
  }
  const response = await api.patch<unknown>(
    `/api/v1/agent-routines/${encodeURIComponent(baseline.id)}`,
    patch,
    { requireOnline: true, maxAttempts: 1, signal },
  );
  return decodeRoutine(response);
}

export async function deleteAgentRoutine(
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  const routineId = uuidValue(id, "routine id");
  await api.delete(`/api/v1/agent-routines/${encodeURIComponent(routineId)}`, {
    requireOnline: true,
    maxAttempts: 1,
    signal,
  });
}

export async function runAgentRoutine(
  id: string,
  signal?: AbortSignal,
): Promise<{ runId: string; status: "running" }> {
  const routineId = uuidValue(id, "routine id");
  const response = await api.post<unknown>(
    `/api/v1/agent-routines/${encodeURIComponent(routineId)}/run`,
    {},
    { requireOnline: true, maxAttempts: 1, signal },
  );
  const record = recordValue(response, "run receipt", ["run_id", "status"]);
  if (record.status !== "running") {
    throw new AgentRoutinesContractError(
      "The run receipt did not report the accepted running state.",
    );
  }
  return {
    runId: uuidValue(
      required(record, "run_id", "run receipt"),
      "run receipt.run_id",
    ),
    status: "running",
  };
}

export async function listAgentRoutineRuns(
  id: string,
  options: { signal?: AbortSignal; fresh?: boolean } = {},
): Promise<AgentRoutineRun[]> {
  const routineId = uuidValue(id, "routine id");
  const response = await api.get<unknown>(
    `/api/v1/agent-routines/${encodeURIComponent(routineId)}/runs`,
    freshReadOptions(options.fresh, options.signal),
  );
  const runs = decodeCollection(
    response,
    "agent routine run list",
    decodeRun,
    50,
  );
  if (runs.some((run) => run.routineId !== routineId)) {
    throw new AgentRoutinesContractError(
      "The run list contained a receipt for another routine.",
    );
  }
  return runs;
}

export function sameAgentRoutineRevision(
  left: AgentRoutine,
  right: AgentRoutine,
): boolean {
  return (
    left.id === right.id &&
    left.updatedAt === right.updatedAt &&
    left.name === right.name &&
    left.prompt === right.prompt &&
    left.kind === right.kind &&
    left.schedule === right.schedule &&
    left.targetSegmentId === right.targetSegmentId &&
    left.legacyTargetListId === right.legacyTargetListId &&
    left.requireApproval === right.requireApproval &&
    left.enabled === right.enabled &&
    left.hasActiveRun === right.hasActiveRun &&
    JSON.stringify(left.scheduleDetail) === JSON.stringify(right.scheduleDetail)
  );
}

export function sameAgentRoutineConfiguration(
  routine: AgentRoutine,
  draft: AgentRoutineDraft,
): boolean {
  return (
    routine.name === draft.name.trim() &&
    routine.prompt === draft.prompt.trim() &&
    routine.kind === draft.kind &&
    routine.schedule === draft.schedule &&
    (routine.targetSegmentId ?? "") === draft.targetSegmentId.trim() &&
    routine.requireApproval === draft.requireApproval &&
    routine.enabled === draft.enabled &&
    !(routine.legacyTargetListId && draft.clearLegacyTargetList)
  );
}

export function routineNextEligibility(routine: AgentRoutine): string | null {
  if (!routine.enabled || routine.schedule === "manual") return null;
  if (!routine.lastRunAt) return "eligible_now";
  const milliseconds = {
    daily: 24 * 60 * 60 * 1_000,
    weekly: 7 * 24 * 60 * 60 * 1_000,
    monthly: 30 * 24 * 60 * 60 * 1_000,
  }[routine.schedule];
  const last = Date.parse(routine.lastRunAt);
  if (!Number.isFinite(last)) return null;
  return new Date(last + milliseconds).toISOString();
}

const ROUTINE_WRITE_ROLES: readonly AuthRole[] = ["owner", "admin", "editor"];

/**
 * Re-check identity, workspace, effective role and viewer-mode immediately
 * before a routine write. Routine authoring is campaigns-domain editor work,
 * not admin-only governance.
 */
export async function verifyFreshRoutineAuthority(
  opened: MeResponse,
  signal?: AbortSignal,
): Promise<MeResponse> {
  const fresh = await whoamiFresh(signal);
  const openedRole = effectiveAuthRole(opened);
  const freshRole = effectiveAuthRole(fresh);
  if (
    fresh.user_id !== opened.user_id ||
    fresh.tenant_id !== opened.tenant_id ||
    freshRole !== openedRole ||
    Boolean(fresh.viewer_mode) !== Boolean(opened.viewer_mode)
  ) {
    throw new Error(
      "Workspace identity or authority changed. Nothing was written; reload and retry.",
    );
  }
  if (fresh.viewer_mode || !ROUTINE_WRITE_ROLES.includes(freshRole)) {
    throw new Error("Owner, admin, or editor access is required.");
  }
  return fresh;
}
