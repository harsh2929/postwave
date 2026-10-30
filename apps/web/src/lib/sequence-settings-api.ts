// SPDX-License-Identifier: AGPL-3.0-only
//
// Sequence-level settings (goal / exit criteria / stuck threshold) and the
// whole-sequence AI draft endpoint. Kept beside voice-api.ts rather than inside
// it: the settings PATCH and the non-persisting draft POST each carry their own
// contract notes, and neither touches the email/step authoring path.
//
// Server contracts mirrored here:
//   - goal: services/voice/internal/generation/types.go — kind ∈
//     open|click|conversion plus exit_on_goal. Conversion goals are STORED but
//     never evaluated in this build (no conversion event source feeds
//     sequences), and exit_on_goal cannot stop engine-side sends — the caveat
//     copy below states both limits verbatim-honest.
//   - stuck_after_days: services/voice/internal/handlers/sequences.go —
//     integer, 0 (off) .. 365. The PATCH is partial: absent fields are left
//     unchanged, `goal: null` clears the goal.
//   - draft: services/voice/internal/handlers/sequence_draft.go —
//     POST {brief, step_count?, tone?} → {name, steps[{subject, body,
//     delay_hours, position}]}. Nothing is persisted; the operator accepts the
//     draft through the ordinary POST /voice/sequences create path. 429 is the
//     tenant AI quota, 503 means the LLM is not configured on this server.

import { ApiError, api } from "./api";
import { isMockModeEnabled } from "./mock-mode";
import { base, type RoleKey } from "./query-keys";

const USE_MOCKS = isMockModeEnabled();

// ----- Goal / exit / stuck --------------------------------------------------

export type SequenceGoalKind = "open" | "click" | "conversion";

export interface SequenceGoal {
  kind: SequenceGoalKind;
  exit_on_goal: boolean;
}

export interface SequenceSettings {
  /** Positive server revision echoed through If-Match on the next mutation. */
  version?: number;
  status?: string;
  goal: SequenceGoal | null;
  /** 0 = off, 1..365 = enabled. */
  stuckAfterDays: number;
}

/** Wire body of the settings PATCH. Both fields are always sent explicitly. */
export interface SequenceSettingsPatch {
  goal: SequenceGoal | null;
  stuck_after_days: number;
}

/** Dropdown options for the goal-kind select, in render order. */
export const GOAL_KIND_OPTIONS: ReadonlyArray<{
  value: SequenceGoalKind;
  label: string;
}> = [
  { value: "open", label: "Opened an email in this sequence" },
  { value: "click", label: "Clicked a link in this sequence" },
  { value: "conversion", label: "Converted (purchase / signup)" },
];

const GOAL_KINDS: ReadonlySet<string> = new Set(
  GOAL_KIND_OPTIONS.map((option) => option.value),
);

export function isSequenceGoalKind(value: unknown): value is SequenceGoalKind {
  return typeof value === "string" && GOAL_KINDS.has(value);
}

/** Honest caveat rendered under the goal-kind select, per kind. */
export function goalKindCaveat(kind: SequenceGoalKind): string {
  switch (kind) {
    case "conversion":
      return (
        "Conversion goals are stored but not yet evaluated — there's no " +
        "conversion event source feeding sequences in this build, so no " +
        "participant will show this goal as met."
      );
    case "open":
      return (
        "Stored open-goal preference only. This build does not evaluate " +
        "participants or mark goals as met."
      );
    case "click":
      return (
        "Stored click-goal preference only. This build does not evaluate " +
        "participants or mark goals as met."
      );
  }
}

/** Honest caveat rendered next to the exit_on_goal toggle. */
export const EXIT_ON_GOAL_CAVEAT =
  "Stored exit preference only. Live sequence delivery and participant " +
  "evaluation are unavailable in this build, so this setting does not " +
  "currently stop or complete a participant's journey.";

/** Server-side bound on stuck_after_days (sequences.go). */
export const STUCK_AFTER_DAYS_MAX = 365;

/**
 * Parse the stuck-threshold input. Empty string and "0" both mean "off" (the
 * server treats 0 as disabled); anything else must be a whole number of days
 * within 1..365.
 */
export function parseStuckAfterDays(
  raw: string,
): { ok: true; value: number } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: 0 };
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > STUCK_AFTER_DAYS_MAX) {
    return {
      ok: false,
      message: `Stuck threshold must be a whole number of days between 0 (off) and ${STUCK_AFTER_DAYS_MAX}.`,
    };
  }
  return { ok: true, value: n };
}

/**
 * Tenant/role-scoped key for one sequence's settings, composed on the shared
 * `base` so it carries the same `[resource, tenantId, role, …]` shape as every
 * other dashboard key.
 */
export function sequenceSettingsKey(
  tenantId: string,
  role: RoleKey,
  sequenceId: string,
  userId = "unverified",
  viewerMode = false,
) {
  return [
    ...base("sequence-settings", tenantId, role),
    userId,
    viewerMode ? "viewer-mode" : "member-mode",
    sequenceId,
  ] as const;
}

export interface SequenceSettingsRequestOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
}

type WireSequenceSettings = {
  id?: string;
  version?: number;
  status?: string;
  goal?: unknown;
  stuck_after_days?: unknown;
};

function toGoal(raw: unknown): SequenceGoal | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as { kind?: unknown; exit_on_goal?: unknown };
  if (!isSequenceGoalKind(candidate.kind)) return null;
  return {
    kind: candidate.kind,
    exit_on_goal: candidate.exit_on_goal === true,
  };
}

function toStuckAfterDays(raw: unknown): number {
  return typeof raw === "number" &&
    Number.isInteger(raw) &&
    raw > 0 &&
    raw <= STUCK_AFTER_DAYS_MAX
    ? raw
    : 0;
}

function toSettings(row: WireSequenceSettings): SequenceSettings {
  return {
    ...(Number.isSafeInteger(row.version) && (row.version ?? 0) > 0
      ? { version: row.version }
      : {}),
    ...(typeof row.status === "string" ? { status: row.status } : {}),
    goal: toGoal(row.goal),
    stuckAfterDays: toStuckAfterDays(row.stuck_after_days),
  };
}

const mockSettings = new Map<string, SequenceSettings>();

export async function getSequenceSettings(
  id: string,
  options: Pick<SequenceSettingsRequestOptions, "signal"> = {},
): Promise<SequenceSettings> {
  if (USE_MOCKS) {
    return (
      mockSettings.get(id) ?? {
        version: 1,
        status: "draft",
        goal: null,
        stuckAfterDays: 0,
      }
    );
  }
  return toSettings(
    await api.get<WireSequenceSettings>(
      `/api/v1/voice/sequences/${encodeURIComponent(id)}`,
      {
        cache: "no-store",
        requireOnline: true,
        maxAttempts: 1,
        signal: options.signal,
      },
    ),
  );
}

function sameGoal(
  actual: SequenceGoal | null,
  expected: SequenceGoal | null,
): boolean {
  return (
    actual === expected ||
    (actual !== null &&
      expected !== null &&
      actual.kind === expected.kind &&
      actual.exit_on_goal === expected.exit_on_goal)
  );
}

/**
 * Persist goal + stuck threshold under the exact sequence version the caller
 * holds. The server bumps the version on success; the next email save must
 * carry the bumped one, so callers thread `version` back into their draft.
 */
export async function updateSequenceSettings(
  id: string,
  version: number,
  patch: SequenceSettingsPatch,
  options: SequenceSettingsRequestOptions = {},
): Promise<SequenceSettings> {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error(
      "A fresh sequence version is required before saving settings. Reload the sequence and try again.",
    );
  }
  if (
    !Number.isInteger(patch.stuck_after_days) ||
    patch.stuck_after_days < 0 ||
    patch.stuck_after_days > STUCK_AFTER_DAYS_MAX
  ) {
    throw new Error(
      `Stuck threshold must be a whole number of days between 0 (off) and ${STUCK_AFTER_DAYS_MAX}.`,
    );
  }
  if (USE_MOCKS) {
    const next: SequenceSettings = {
      version: version + 1,
      status: "draft",
      goal: patch.goal,
      stuckAfterDays: patch.stuck_after_days,
    };
    mockSettings.set(id, next);
    return next;
  }
  const row = await api.patch<WireSequenceSettings>(
    `/api/v1/voice/sequences/${encodeURIComponent(id)}`,
    { goal: patch.goal, stuck_after_days: patch.stuck_after_days },
    {
      headers: { "If-Match": `"${version}"` },
      // A settings save is a small explicit action: fail fast offline rather
      // than queue a version-pinned PATCH that will 412 on replay.
      requireOnline: true,
      cache: "no-store",
      maxAttempts: 1,
      signal: options.signal,
      idempotencyKey: options.idempotencyKey,
    },
  );
  const saved = toSettings(row);
  if (
    row.id !== id ||
    saved.version !== version + 1 ||
    row.goal === undefined ||
    row.stuck_after_days === undefined ||
    !sameGoal(saved.goal, patch.goal) ||
    saved.stuckAfterDays !== patch.stuck_after_days
  ) {
    throw new Error(
      "The server did not confirm the sequence identity, next version, and saved settings. Reload the latest version before making another change.",
    );
  }
  return saved;
}

// ----- Whole-sequence AI draft ---------------------------------------------

/** Mirror of generation.DraftStepCountMax — the server 400s above this. */
export const DRAFT_STEP_COUNT_MAX = 10;

/** Mirror of the server's brief cap (draftBriefMaxRunes). */
export const DRAFT_BRIEF_MAX_LENGTH = 8000;

/** Mirror of the server's tone cap (draftToneMaxRunes). */
export const DRAFT_TONE_MAX_LENGTH = 200;

/** One structured LLM call; the desktop gives it the same minute. */
export const DRAFT_REQUEST_TIMEOUT_MS = 60_000;

/** One generated step in a voice-drafted sequence. */
export interface SequenceDraftStep {
  subject: string;
  body: string;
  /** Wait relative to the previous email. */
  delay_hours: number;
  /** 1-based position within the draft. */
  position: number;
}

/** Response of POST /api/v1/voice/sequences/draft. */
export interface SequenceDraftResponse {
  name: string;
  steps: SequenceDraftStep[];
}

export interface SequenceDraftRequest {
  brief: string;
  step_count?: number;
  tone?: string;
}

export type SequenceDraftFailure = "quota" | "unconfigured" | "other";

/**
 * 429 is the tenant's AI quota, 503 means no LLM is configured on this
 * server. Both have a no-AI fallback (Quick match) the UI can offer; anything
 * else is rendered as the server's own sentence.
 */
export function classifyDraftError(err: unknown): SequenceDraftFailure {
  if (err instanceof ApiError) {
    if (err.status === 429) return "quota";
    if (err.status === 503) return "unconfigured";
  }
  return "other";
}

export const EMPTY_DRAFT_MESSAGE =
  "The AI returned an empty draft — try rephrasing the brief.";

function toDraftStep(raw: unknown, index: number): SequenceDraftStep | null {
  if (!raw || typeof raw !== "object") return null;
  const step = raw as Partial<Record<keyof SequenceDraftStep, unknown>>;
  if (typeof step.subject !== "string" || typeof step.body !== "string") {
    return null;
  }
  const delayHours =
    typeof step.delay_hours === "number" && Number.isFinite(step.delay_hours)
      ? step.delay_hours
      : 0;
  const position =
    Number.isSafeInteger(step.position) && (step.position as number) > 0
      ? (step.position as number)
      : index + 1;
  return {
    subject: step.subject,
    body: step.body,
    delay_hours: delayHours,
    position,
  };
}

function toDraftResponse(raw: unknown): SequenceDraftResponse {
  const candidate = (raw ?? {}) as { name?: unknown; steps?: unknown };
  const steps = Array.isArray(candidate.steps)
    ? candidate.steps
        .map(toDraftStep)
        .filter((step): step is SequenceDraftStep => step !== null)
    : [];
  if (steps.length === 0) throw new Error(EMPTY_DRAFT_MESSAGE);
  return {
    name: typeof candidate.name === "string" ? candidate.name.trim() : "",
    steps,
  };
}

/**
 * Draft a whole sequence from a free-form brief. Non-persisting: the result is
 * a preview the operator must accept through `createSequence`.
 */
export async function draftSequence(
  input: SequenceDraftRequest,
  options: { signal?: AbortSignal } = {},
): Promise<SequenceDraftResponse> {
  const brief = input.brief.trim();
  if (!brief) throw new Error("Describe the sequence you want to generate.");
  const body: Record<string, unknown> = { brief };
  if (input.step_count !== undefined) body.step_count = input.step_count;
  const tone = input.tone?.trim();
  if (tone) body.tone = tone;
  if (USE_MOCKS) {
    const count = input.step_count ?? 3;
    return {
      name:
        brief
          .split(/[.!?\n]/)[0]
          ?.trim()
          .slice(0, 60) || "AI draft",
      steps: Array.from({ length: count }, (_, i) => ({
        subject: `Email ${i + 1} — ${brief.slice(0, 40)}`,
        body: `Hi {{first_name}},\n\nDraft copy for email ${i + 1}.\n\n— {{sender_name}}`,
        delay_hours: i === 0 ? 0 : 48,
        position: i + 1,
      })),
    };
  }
  const res = await api.post<unknown>("/api/v1/voice/sequences/draft", body, {
    // LLM-priced and non-persisting: never queue it offline and never
    // auto-retry an expensive generation; give the model a full minute.
    requireOnline: true,
    maxAttempts: 1,
    timeoutMs: DRAFT_REQUEST_TIMEOUT_MS,
    signal: options.signal,
  });
  return toDraftResponse(res);
}
