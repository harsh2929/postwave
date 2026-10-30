/**
 * routines-helpers — pure logic for the Agent Routines UI (roadmap R5,
 * apps/api/internal/agent_routines).
 *
 * Server contract notes encoded here:
 *   - kind ∈ {draft_campaign, draft_sequence} and is IMMUTABLE after
 *     create (PATCH has no kind field) — the edit modal disables it;
 *   - schedule ∈ {manual, daily, weekly, monthly}; the three automatic
 *     values are elapsed intervals from last_run_at, not wall-clock slots;
 *   - run() answers 202 and continues server-side — poll listRuns;
 *   - runs carry output_kind ("campaign" | "sequence") + output_ref
 *     (the draft's id) + optional approval_id + an internal error that the
 *     renderer must replace with bounded operator-safe copy.
 */

import type {
  AgentRoutineKind,
  AgentRoutineRun,
  AgentRoutineSchedule,
} from "../../lib/api-client";

export const ROUTINE_KINDS: ReadonlyArray<{
  value: AgentRoutineKind;
  label: string;
}> = [
  { value: "draft_campaign", label: "Draft a campaign" },
  { value: "draft_sequence", label: "Draft a sequence" },
];

export const ROUTINE_SCHEDULES: ReadonlyArray<{
  value: AgentRoutineSchedule;
  label: string;
}> = [
  { value: "manual", label: "Manual (Run now only)" },
  { value: "daily", label: "Every 24 hours after a run starts" },
  { value: "weekly", label: "Every 7 days after a run starts" },
  { value: "monthly", label: "Every 30 days after a run starts" },
];

export const ROUTINE_NAME_MAX = 200;
export const ROUTINE_PROMPT_MAX = 8_000;

export function kindLabel(kind: string): string {
  const hit = ROUTINE_KINDS.find((k) => k.value === kind);
  return hit ? hit.label : "Unknown draft type";
}

export function scheduleLabel(schedule: string): string {
  switch (schedule) {
    case "manual":
      return "Manual only";
    case "daily":
      return "Every 24 hours after a run starts";
    case "weekly":
      return "Every 7 days after a run starts";
    case "monthly":
      return "Every 30 days after a run starts";
    default:
      return "Schedule unavailable";
  }
}

export function runStatusLabel(status: string): string {
  switch (status) {
    case "succeeded":
      return "Draft created";
    case "failed":
      return "Run failed";
    case "running":
      return "Drafting";
    default:
      return "Status unavailable";
  }
}

/** Badge tone class for a run status. Unknown statuses render plain. */
export function runStatusTone(status: string): string {
  switch (status) {
    case "succeeded":
      return "success";
    case "failed":
      return "danger";
    case "running":
      return "accent";
    default:
      return "";
  }
}

export interface RunOutputLink {
  /** Desktop section to navigate to. */
  section: "campaigns" | "sequences";
  /** Resource id handed to the deep-link slot. */
  id: string;
  label: string;
}

/**
 * Map a run's output to a navigable draft, when feasible. Returns null
 * for runs without output (failed/running) or unknown output kinds. Callers
 * must use bounded explanatory copy instead of exposing a raw reference or
 * guessing a route.
 */
export function runOutputLink(
  run: Pick<AgentRoutineRun, "output_kind" | "output_ref">,
): RunOutputLink | null {
  if (!run.output_ref) return null;
  if (run.output_kind === "campaign") {
    return {
      section: "campaigns",
      id: run.output_ref,
      label: "Open draft campaign",
    };
  }
  if (run.output_kind === "sequence") {
    return {
      section: "sequences",
      id: run.output_ref,
      label: "Open draft sequence",
    };
  }
  return null;
}

/**
 * Pre-flight validation for the create/edit modal. Server-side rules
 * (422 invalid_routine / 409 name_taken) still apply — this only
 * catches the obvious gaps before the round-trip.
 */
export function validateRoutineDraft(
  name: string,
  prompt: string,
): string | null {
  const normalizedName = name.trim();
  const normalizedPrompt = prompt.trim();
  if (!normalizedName) return "A routine name is required.";
  if (Array.from(normalizedName).length > ROUTINE_NAME_MAX) {
    return `Keep the routine name to ${ROUTINE_NAME_MAX.toLocaleString()} characters or fewer.`;
  }
  if (!normalizedPrompt) {
    return "A prompt/brief is required — it's what the agent drafts from.";
  }
  if (Array.from(normalizedPrompt).length > ROUTINE_PROMPT_MAX) {
    return `Keep the prompt to ${ROUTINE_PROMPT_MAX.toLocaleString()} characters or fewer.`;
  }
  return null;
}

export type RoutineFailureAction =
  | "load"
  | "run"
  | "update"
  | "delete"
  | "save"
  | "runs";

interface RoutineErrorLike {
  status?: unknown;
  code?: unknown;
  kind?: unknown;
}

function errorShape(error: unknown): RoutineErrorLike {
  return error && typeof error === "object" ? (error as RoutineErrorLike) : {};
}

function normalizedToken(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

const ACTION_FAILURE: Record<RoutineFailureAction, string> = {
  load: "Routines couldn't be loaded. Retry when ready.",
  run: "The background draft couldn't be started. Retry when ready.",
  update: "The routine couldn't be updated. Refresh and retry.",
  delete: "The routine couldn't be deleted. Refresh and retry.",
  save: "The routine couldn't be saved. Review the form and retry.",
  runs: "Run history couldn't be loaded. Retry when ready.",
};

/**
 * Convert transport/server failures into a small stable copy vocabulary.
 * Upstream messages are deliberately ignored: they can contain tenant input,
 * dependency responses, SQL detail, request paths, or other internals.
 */
export function routineFailureMessage(
  error: unknown,
  action: RoutineFailureAction,
): string {
  const shape = errorShape(error);
  const status = typeof shape.status === "number" ? shape.status : undefined;
  const code = normalizedToken(shape.code);
  const kind = normalizedToken(shape.kind);

  if (status === 401 || code === "unauthorized") {
    return "Your session is no longer authorized. Sign in again and retry.";
  }
  if (
    status === 403 ||
    ["forbidden", "permission_denied", "insufficient_scope"].includes(code)
  ) {
    return action === "load" || action === "runs"
      ? "Your current role can't view this routine data."
      : "Your current role can't change or run routines.";
  }
  if (kind === "network" || kind === "offline") {
    return "The routines service couldn't be reached. Check the connection and retry.";
  }
  if (kind === "timeout") {
    return "The routines service didn't respond in time. Retry when ready.";
  }
  if (kind === "parse") {
    return "The server returned routine data this app couldn't verify. Refresh and retry.";
  }
  if (kind === "invalid_config" || code === "routines_unavailable") {
    return "Routine drafting isn't configured for this environment.";
  }
  if (code === "name_taken") {
    return "A routine with this name already exists. Choose a different name.";
  }
  if (code === "routine_active" || (action === "run" && status === 409)) {
    if (action === "delete") {
      return "This routine has a draft in progress and can't be deleted until that run finishes.";
    }
    if (action === "update" || action === "save") {
      return "This routine has a draft in progress. Wait for that run to finish before changing it.";
    }
    return "A draft is already running for this routine. Open run history to monitor it.";
  }
  if (code === "invalid_target_segment") {
    return "The selected segment isn't available in this workspace. Refresh segments or clear the target.";
  }
  if (code === "unsupported_target_list") {
    return "This routine has an unsupported legacy target. Remove that reference before saving.";
  }
  if (code === "invalid_routine" || (action === "save" && status === 422)) {
    return "One or more routine fields are invalid. Review the form and retry.";
  }
  if (code === "routine_not_found" || status === 404) {
    return "This routine is no longer available. Refresh the list.";
  }
  if (status !== undefined && status >= 500) {
    return "The routines service couldn't complete the request. Retry when ready.";
  }
  return ACTION_FAILURE[action];
}

/** Stored run errors are internal execution diagnostics, never UI copy. */
export function routineRunFailureMessage(
  run: Pick<AgentRoutineRun, "error" | "output_ref">,
): string | null {
  if (!run.error?.trim()) return null;
  return run.output_ref?.trim()
    ? "A draft was created, but the configured follow-up didn't complete. Review the draft before retrying."
    : "The draft couldn't be completed. Retry the routine when ready.";
}

export interface RoutineDraftFingerprintInput {
  name: string;
  prompt: string;
  kind: AgentRoutineKind;
  schedule: AgentRoutineSchedule;
  targetSegmentId: string;
  clearLegacyTargetList: boolean;
  requireApproval: boolean;
  enabled: boolean;
}

/** Stable comparison token for the editor's unsaved-change guard. */
export function routineDraftFingerprint(
  draft: RoutineDraftFingerprintInput,
): string {
  return JSON.stringify([
    draft.name,
    draft.prompt,
    draft.kind,
    draft.schedule,
    draft.targetSegmentId,
    draft.clearLegacyTargetList,
    draft.requireApproval,
    draft.enabled,
  ]);
}

/**
 * Normalise a target picker value ("" = none) to the id the API expects.
 *
 * [GAP-2#4] Clearing a target sends an empty string, NOT JSON null. The
 * backend PATCH decodes an explicit `null` into a nil `*string`, which
 * `UpdateRoutine` treats as "leave unchanged" (agent_routines/repo.go),
 * so a null would silently keep the old target. An empty string arrives
 * as a non-nil pointer to "" and hits the `NULLIF($7,'')::uuid` path,
 * which is what actually clears the column (and, on create, the
 * `deref`+NULLIF path treats "" the same as absent).
 */
export function targetIdOrNull(value: string): string {
  return value.trim();
}
