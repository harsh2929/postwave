/**
 * lib/agentRoutines.ts — the wire shapes and the presentation decisions for
 * standing agent routines, expressed WITHOUT a single react-native import so
 * every decision below is unit-testable in the node vitest environment (the
 * rule documented in lib/approvalPolicy and lib/reviewQueue).
 *
 * Everything here was read off the Go source, not off openapi.json:
 * `apps/api/internal/agent_routines/routines.go` declares `Routine` and `Run`
 * and the four status/kind/schedule constant blocks; `repo.go` decides what
 * actually comes back; `handlers.go` decides the envelopes. Five of those
 * facts shape this module and every one of them is easy to get wrong:
 *
 *  1. THE ROUTINE LIST CARRIES NO RUN STATUS. `routineColumns` (repo.go:40)
 *     selects `last_run_at` and nothing about the OUTCOME of that run. Only
 *     `GET /{id}/runs` knows whether the last run failed. So a list row can
 *     honestly say WHEN a routine last ran and never WHETHER it worked —
 *     exactly the reviews-replies situation, and modelled the same way:
 *     `lastRunStatus` is absent from `AgentRoutine` by construction rather
 *     than being a nullable field a screen might render as "fine".
 *  2. `last_run_at` IS STAMPED AT RUN *START*, BY MANUAL RUNS TOO.
 *     `Repo.InsertRun` (repo.go:398) inserts the ledger row and immediately
 *     `UPDATE agent_routines SET last_run_at = now()` in the same tx. A manual
 *     "Run now" therefore pushes the next AUTOMATIC run back by a whole
 *     interval. The confirm copy in lib/agentRoutineSchedule says so.
 *  3. A RUN LEFT AT "running" IS NOT NECESSARILY IN PROGRESS. `RunNow` executes
 *     detached under `ExecuteTimeout` (runner.go:33 — three minutes) and only
 *     `FinishRun` writes a terminal status. If the API process dies mid-run, or
 *     the context expires before the terminal write lands, the row stays
 *     `running` forever; nothing sweeps it. Past that bound the honest label is
 *     "outcome unknown", never a spinner that will never stop.
 *  4. THE RUN CARRIES ITS OWN `approval_id`. The Approvals surface resolves the
 *     other direction through `GET /agent-routines/runs/by-approval/{id}` (see
 *     hooks/useApprovals.useApprovalAgentRun), but run → approval needs no
 *     second request at all: `runColumns` (repo.go:344) selects it directly.
 *  5. `/{id}/runs` IS CAPPED AT 50 WITH NO CURSOR. `ListRuns` is called with a
 *     literal 50 from `handlers.go:ListRuns`, and the repo clamps anything
 *     outside 1..200 back to 50. There is no pagination to offer.
 */

/** `KindDraftCampaign` / `KindDraftSequence` (routines.go:31-34). */
export const ROUTINE_KINDS = ["draft_campaign", "draft_sequence"] as const;
export type RoutineKind = (typeof ROUTINE_KINDS)[number];

/** `ScheduleManual` … `ScheduleMonthly` (routines.go:38-43). */
export const ROUTINE_SCHEDULES = [
  "manual",
  "daily",
  "weekly",
  "monthly",
] as const;
export type RoutineSchedule = (typeof ROUTINE_SCHEDULES)[number];

/** The CHECK constraint in migration 0387 (routines.go:46-50). */
export const RUN_STATUSES = ["running", "succeeded", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** `handlers.go:ListRuns` passes a literal 50; the repo clamps to it anyway. */
export const RUN_LIST_CAP = 50;

/**
 * `ExecuteTimeout` (runner.go:33) plus a minute of slack for the terminal
 * write. A `running` row older than this did not finish normally — see fact 3.
 */
export const RUN_STALL_MS = 4 * 60_000;

export interface AgentRoutine {
  id: string;
  name: string;
  /** The standing brief. Capped at 8000 runes server-side. */
  prompt: string;
  kind: RoutineKind | string;
  schedule: RoutineSchedule | string;
  /** Scheduler skips `enabled = false` entirely (`FindDue`, repo.go:495). */
  enabled: boolean;
  /** Each run opens a pending approval gating promotion of the draft. */
  requireApproval: boolean;
  /** Stamped at run START, by manual runs too. Null = never run. */
  lastRunAt: string | null;
  createdBy: string;
  createdAt: string | null;
}

export interface AgentRoutineRun {
  id: string;
  routineId: string;
  status: RunStatus | string;
  /** "campaign" | "sequence" — empty until a draft exists. */
  outputKind: string;
  /** Id of the drafted campaign/sequence. Empty when the run made nothing. */
  outputRef: string;
  /** Non-empty when this run opened an approval; links straight to it. */
  approvalId: string;
  /** Operator-visible failure text, written by `FinishRun`. */
  error: string;
  /** The model's own rationale — the trust record an approver reads. */
  reasoning: string;
  startedAt: string | null;
  /** Null while running AND on any run that never reached `FinishRun`. */
  finishedAt: string | null;
}

/** 202 body from `POST /{id}/run` (handlers.go:200). */
export interface RunNowAck {
  runId: string;
  status: RunStatus | string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * An ISO timestamp, or null. Go's zero `time.Time` serialises as
 * `0001-01-01T00:00:00Z`, which is a present-but-meaningless value — rendering
 * it would put "1 January year 1" on screen instead of an em-dash.
 */
export function timestamp(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  if (raw.startsWith("0001-01-01")) return null;
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

export function parseRoutine(value: unknown): AgentRoutine | null {
  const row = record(value);
  const id = str(row["id"]);
  if (!id) return null;
  return {
    id,
    name: str(row["name"]),
    prompt: str(row["prompt"]),
    kind: str(row["kind"]),
    schedule: str(row["schedule"]) || "manual",
    // `enabled` and `require_approval` are non-pointer bools server-side and
    // are always present. An ABSENT value must not read as "on": treating a
    // missing `require_approval` as true would claim a gate that may not
    // exist, and treating a missing `enabled` as true would claim the
    // scheduler is running something it is not.
    enabled: row["enabled"] === true,
    requireApproval: row["require_approval"] === true,
    lastRunAt: timestamp(row["last_run_at"]),
    createdBy: str(row["created_by"]),
    createdAt: timestamp(row["created_at"]),
  };
}

/**
 * `GET /api/v1/agent-routines` answers `{"items":[…]}`. A bare array is
 * accepted too, for one line, because envelope drift silently emptying a
 * mobile screen is the single most common failure class in this codebase
 * (see the SDK/envelope cluster in docs/logic-audit-2026-07/mobile.md).
 */
export function parseRoutineList(payload: unknown): AgentRoutine[] {
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(record(payload)["items"])
      ? (record(payload)["items"] as unknown[])
      : [];
  return source
    .map(parseRoutine)
    .filter((row): row is AgentRoutine => row !== null);
}

export function parseRun(value: unknown): AgentRoutineRun | null {
  const row = record(value);
  const id = str(row["id"]);
  if (!id) return null;
  return {
    id,
    routineId: str(row["routine_id"]),
    // A run row without a status is not a success. Leaving it verbatim (and
    // empty) makes `runStatusPresentation` fall through to its unknown branch
    // rather than into any of the three known ones.
    status: str(row["status"]),
    outputKind: str(row["output_kind"]),
    outputRef: str(row["output_ref"]),
    approvalId: str(row["approval_id"]),
    error: str(row["error"]),
    reasoning: str(row["reasoning"]),
    startedAt: timestamp(row["started_at"]),
    finishedAt: timestamp(row["finished_at"]),
  };
}

/** `GET /{id}/runs` answers `{"items":[…]}`, newest-first (repo.go:320). */
export function parseRunList(payload: unknown): AgentRoutineRun[] {
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(record(payload)["items"])
      ? (record(payload)["items"] as unknown[])
      : [];
  return source
    .map(parseRun)
    .filter((row): row is AgentRoutineRun => row !== null);
}

/**
 * The 202 acknowledgement. Null when the body carried no run id — the screen
 * must then say "started, outcome unknown" rather than invent one, because a
 * run WAS opened server-side before the response was written.
 */
export function parseRunNowAck(payload: unknown): RunNowAck | null {
  const row = record(payload);
  const runId = str(row["run_id"]);
  if (!runId) return null;
  return { runId, status: str(row["status"]) || "running" };
}

export function routineKindLabel(kind: string): string {
  switch (kind.trim().toLowerCase()) {
    case "draft_campaign":
      return "Drafts a campaign";
    case "draft_sequence":
      return "Drafts a sequence";
    default:
      // Never guess. An unrecognised kind is shown verbatim so an operator can
      // report exactly what their workspace returned.
      return kind.trim() || "Unknown output";
  }
}

export function scheduleLabel(schedule: string): string {
  switch (schedule.trim().toLowerCase()) {
    case "daily":
      return "Daily";
    case "weekly":
      return "Weekly";
    case "monthly":
      return "Monthly";
    case "manual":
      return "Manual only";
    default:
      return schedule.trim() || "Unknown schedule";
  }
}

export interface RunPresentation {
  label: string;
  tone: "neutral" | "success" | "warning" | "danger";
  /**
   * The full sentence a screen reader hears in place of the compacted pill.
   * State is never colour-alone and never a three-word label alone.
   */
  spoken: string;
}

/**
 * How a single run reads. `now` is required rather than defaulted so the
 * stall rule is deterministic under test and cannot silently depend on the
 * wall clock of whoever runs the suite.
 */
export function runStatusPresentation(
  run: Pick<AgentRoutineRun, "status" | "startedAt" | "finishedAt">,
  now: number,
): RunPresentation {
  const status = run.status.trim().toLowerCase();
  if (status === "succeeded") {
    return {
      label: "Succeeded",
      tone: "success",
      spoken: "This run succeeded and produced a draft.",
    };
  }
  if (status === "failed") {
    return {
      label: "Failed",
      tone: "danger",
      spoken: "This run failed and produced nothing.",
    };
  }
  if (status === "running") {
    const started = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
    const stalled =
      Number.isFinite(started) && now - started > RUN_STALL_MS;
    if (stalled) {
      return {
        label: "Outcome unknown",
        tone: "warning",
        spoken:
          "This run never recorded an outcome. Agent runs are bounded at three minutes, so it did not finish normally.",
      };
    }
    return {
      label: "Running",
      tone: "neutral",
      spoken: "This run is still in progress.",
    };
  }
  return {
    label: status ? run.status.trim() : "Unknown",
    tone: "neutral",
    spoken: `This run reported an unrecognised status: ${
      status ? run.status.trim() : "none at all"
    }.`,
  };
}

/** True while any run in the list is worth polling for a terminal status. */
export function hasLiveRun(
  runs: readonly Pick<AgentRoutineRun, "status" | "startedAt" | "finishedAt">[],
  now: number,
): boolean {
  return runs.some(
    (run) => runStatusPresentation(run, now).label === "Running",
  );
}

/**
 * The most recent run. The server already returns `started_at DESC`, but a
 * screen that trusts array order is one repo change away from showing the
 * wrong run beside the word "last", so the max is taken explicitly. Rows with
 * an unparsable `started_at` lose rather than sorting to the epoch.
 */
export function latestRun(
  runs: readonly AgentRoutineRun[],
): AgentRoutineRun | null {
  let best: AgentRoutineRun | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const run of runs) {
    const at = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
    if (!Number.isFinite(at)) continue;
    if (at > bestAt) {
      bestAt = at;
      best = run;
    }
  }
  return best;
}

/**
 * How long a run took, in ms — or null when that is not knowable. A run still
 * in progress is measured against `now`; a run with no terminal timestamp at
 * all yields null, and the caller renders an em-dash. Never zero: "0ms" is a
 * measurement, and this is the absence of one.
 */
export function runDurationMs(
  run: Pick<AgentRoutineRun, "startedAt" | "finishedAt">,
  now: number,
): number | null {
  const started = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
  if (!Number.isFinite(started)) return null;
  const finished = run.finishedAt ? Date.parse(run.finishedAt) : Number.NaN;
  const end = Number.isFinite(finished) ? finished : now;
  const delta = end - started;
  return delta >= 0 ? delta : null;
}

/** The four disjoint buckets the list filter offers. */
export const ROUTINE_FILTERS = [
  "all",
  "scheduled",
  "manual",
  "paused",
] as const;
export type RoutineFilter = (typeof ROUTINE_FILTERS)[number];

/**
 * The buckets partition the set exactly, and the partition is the SERVER's:
 * `FindDue` selects `WHERE enabled AND schedule <> 'manual'`, so "scheduled"
 * is precisely the set the platform will run on its own, "manual" is the set
 * that only ever runs when a human says so, and "paused" is the set the
 * scheduler cannot see at all. Every routine lands in exactly one.
 */
export function matchesRoutineFilter(
  routine: AgentRoutine,
  filter: RoutineFilter,
): boolean {
  if (filter === "all") return true;
  if (!routine.enabled) return filter === "paused";
  const manual = routine.schedule.trim().toLowerCase() === "manual";
  return filter === (manual ? "manual" : "scheduled");
}

export function routineFilterCounts(
  routines: readonly AgentRoutine[],
): Record<RoutineFilter, number> {
  const counts: Record<RoutineFilter, number> = {
    all: routines.length,
    scheduled: 0,
    manual: 0,
    paused: 0,
  };
  for (const routine of routines) {
    if (matchesRoutineFilter(routine, "paused")) counts.paused += 1;
    else if (matchesRoutineFilter(routine, "manual")) counts.manual += 1;
    else counts.scheduled += 1;
  }
  return counts;
}

/**
 * Search over the fields a person can actually recall: the routine's name and
 * the brief they wrote. Case- and whitespace-insensitive.
 */
export function matchesRoutineQuery(
  routine: AgentRoutine,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    routine.name.toLowerCase().includes(needle) ||
    routine.prompt.toLowerCase().includes(needle)
  );
}

