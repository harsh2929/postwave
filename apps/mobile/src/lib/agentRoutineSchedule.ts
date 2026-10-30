/**
 * lib/agentRoutineSchedule.ts — when a routine runs next, whether the platform
 * has missed it, and exactly what the phone promises before it spends money.
 *
 * Split from lib/agentRoutines.ts so neither file grows past the source budget,
 * and because the seam is real: that file parses and labels what the server
 * SENT, this one derives what the server WILL DO. Both are import-free so they
 * run in the node vitest environment.
 *
 * THERE IS NO `next_run_at` ON THE WIRE. The Go model has `last_run_at` and a
 * schedule name and nothing else (routines.go:66-81); the next run is derived,
 * and it is derived in TWO places server-side that do not agree by a hair:
 *
 *   - `IsDue` (routines.go, the pure rule) fires at `last_run_at + interval`
 *     inclusive of the boundary instant;
 *   - `Repo.FindDue` (repo.go:495), the SQL the scheduler actually runs, uses
 *     a strict `last_run_at < now() - interval '…'`.
 *
 * This module mirrors the SQL, because the SQL is the code path that runs. The
 * difference is one instant wide and matters only to a test that lands exactly
 * on the boundary — which is precisely why it is written down rather than
 * discovered later.
 *
 * MONTHLY IS 30 DAYS, NOT A CALENDAR MONTH. `scheduleInterval` returns
 * `30 * 24 * time.Hour` and the SQL says `interval '30 days'`. Rendering a
 * "next run" that drifts a day or two off the calendar month is the truth;
 * pretending it is the 1st of the month would not be.
 */

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Mirrors `scheduleInterval` (routines.go). Zero for manual and for anything
 * unrecognised — a routine on a schedule this client does not know about is
 * never claimed to be due, because the claim would be a guess.
 */
export function scheduleIntervalMs(schedule: string): number {
  switch (schedule.trim().toLowerCase()) {
    case "daily":
      return DAY_MS;
    case "weekly":
      return 7 * DAY_MS;
    case "monthly":
      return 30 * DAY_MS;
    default:
      return 0;
  }
}

/**
 * How late the platform may be before the phone calls a routine overdue.
 *
 * The scheduler ticks once a minute and executes at most ten routines per tick
 * (`schedulerTick` / `schedulerMaxPerTick`, scheduler.go:28-32), so a routine
 * being a few minutes past its nominal time is NORMAL operation, not a fault.
 * Below this grace the phone says "due now"; above it, something is wrong and
 * saying so is the whole value of the screen.
 */
export const SCHEDULE_GRACE_MS = 15 * 60_000;

export type NextRunReason =
  /** Paused: `FindDue` filters on `WHERE enabled`, so this never auto-runs. */
  | "paused"
  /** `schedule = 'manual'`: excluded by `schedule <> 'manual'`. */
  | "manual"
  /** Enabled + scheduled + never run: `last_run_at IS NULL` matches at once. */
  | "never_run"
  /** A future instant we can name. */
  | "scheduled"
  /** Past its instant, inside the scheduler's normal working grace. */
  | "due"
  /** Past its instant by more than the grace — the platform has missed it. */
  | "overdue"
  /** Enabled, non-manual, but on a schedule this client cannot interpret. */
  | "unknown";

export interface RoutineScheduleState {
  /**
   * Epoch ms of the next expected automatic run, or NULL when there is no such
   * instant to name. Null is the honest answer for paused, manual, never-run
   * and unknown-schedule routines: an absent measurement renders as an
   * em-dash, never as a date and never as "now".
   */
  at: number | null;
  reason: NextRunReason;
  /** True only for `overdue` — pulled out because rows sort and badge on it. */
  overdue: boolean;
}

export interface ScheduleInputs {
  enabled: boolean;
  schedule: string;
  lastRunAt: string | null;
}

export function routineScheduleState(
  routine: ScheduleInputs,
  now: number,
): RoutineScheduleState {
  if (!routine.enabled) return { at: null, reason: "paused", overdue: false };
  if (routine.schedule.trim().toLowerCase() === "manual") {
    return { at: null, reason: "manual", overdue: false };
  }
  const interval = scheduleIntervalMs(routine.schedule);
  if (interval <= 0) return { at: null, reason: "unknown", overdue: false };

  const last = routine.lastRunAt ? Date.parse(routine.lastRunAt) : Number.NaN;
  if (!Number.isFinite(last)) {
    // `last_run_at IS NULL` is the first branch of the due-scan: the next tick
    // picks it up. There is no instant to name, so `at` stays null.
    return { at: null, reason: "never_run", overdue: false };
  }

  const at = last + interval;
  // Strict `>`, mirroring the SQL's `last_run_at < now() - interval`.
  if (now > at + SCHEDULE_GRACE_MS) {
    return { at, reason: "overdue", overdue: true };
  }
  if (now > at) return { at, reason: "due", overdue: false };
  return { at, reason: "scheduled", overdue: false };
}

/**
 * The words beside the time. Kept here rather than in the row so the copy is
 * asserted by a test instead of by a screenshot.
 */
export function nextRunPrefix(reason: NextRunReason): string {
  switch (reason) {
    case "paused":
      return "Paused — no automatic runs";
    case "manual":
      return "Runs only when you say so";
    case "never_run":
      return "Never run — due on the next check";
    case "due":
      return "Due now";
    case "overdue":
      return "Overdue since";
    case "unknown":
      return "Unrecognised schedule";
    default:
      return "Next run";
  }
}

/**
 * Attention order. A routine the platform has MISSED is the reason this screen
 * exists on a phone, so overdue rises to the top; paused rows sink, because a
 * paused routine not running is the state the operator chose. Within a band the
 * soonest next run leads, and rows with no nameable next run (manual, paused,
 * never-run) fall to the end of their band rather than sorting as "epoch".
 *
 * Ties break on name so the list is stable across refetches — an unstable order
 * makes a row move under a thumb that is already travelling toward it.
 */
export function orderRoutines<
  T extends ScheduleInputs & { name: string; id: string },
>(routines: readonly T[], now: number): T[] {
  const band = (row: T): number => {
    const state = routineScheduleState(row, now);
    if (state.overdue) return 0;
    if (state.reason === "due" || state.reason === "never_run") return 1;
    if (state.reason === "scheduled") return 2;
    if (state.reason === "manual" || state.reason === "unknown") return 3;
    return 4; // paused
  };
  return [...routines].sort((a, b) => {
    const bandDelta = band(a) - band(b);
    if (bandDelta !== 0) return bandDelta;
    const aAt = routineScheduleState(a, now).at;
    const bAt = routineScheduleState(b, now).at;
    if (aAt !== null && bAt !== null && aAt !== bAt) return aAt - bAt;
    if (aAt !== null && bAt === null) return -1;
    if (aAt === null && bAt !== null) return 1;
    const byName = a.name.localeCompare(b.name);
    return byName !== 0 ? byName : a.id.localeCompare(b.id);
  });
}

export interface RunNowCopy {
  title: string;
  message: string;
  consequence: string;
  confirmLabel: string;
  destructive: boolean;
}

export interface RunNowSubject {
  name: string;
  kind: string;
  enabled: boolean;
  schedule: string;
  requireApproval: boolean;
}

/**
 * What the confirm sheet says. Every clause below is a fact from the handler,
 * not reassurance:
 *
 *  - "never sends" — the package-level SAFETY INVARIANT in routines.go: a run
 *    only ever produces `campaigns.status = 'draft'` / a draft sequence, and
 *    there is no code path in the package that queues, schedules or sends.
 *  - "even though it is paused" — `RunNow` deliberately allows manual runs on
 *    disabled routines; disabling only stops the SCHEDULER (handlers.go:157).
 *  - "resets the schedule clock" — `InsertRun` stamps `last_run_at = now()`,
 *    so the next automatic run is measured from this manual one.
 *  - "opens an approval" — the runner requests one when `require_approval`.
 *
 * There is deliberately no undo: nothing in the API cancels an in-flight run,
 * so an "Undo" on the toast afterwards would be a lie about what it can do.
 */
export function runNowCopy(routine: RunNowSubject): RunNowCopy {
  const output =
    routine.kind.trim().toLowerCase() === "draft_sequence"
      ? "a draft sequence"
      : "a draft campaign";
  const clauses = [
    `The agent will write ${output} from this routine's brief. It is only ever a draft — nothing is scheduled and nothing is sent.`,
  ];
  if (!routine.enabled) {
    clauses.push(
      "This routine is paused. Pausing only stops the automatic schedule; running it by hand still works.",
    );
  }
  if (routine.schedule.trim().toLowerCase() !== "manual" && routine.enabled) {
    clauses.push(
      "Running now also restarts the schedule clock, so the next automatic run is measured from this one.",
    );
  }
  return {
    title: `Run ${routine.name || "this routine"} now?`,
    message: clauses.join(" "),
    consequence: routine.requireApproval
      ? "The draft lands in Approvals for a human to review. It cannot be cancelled once started."
      : "This routine has no approval gate, so the draft is created directly. It cannot be cancelled once started.",
    confirmLabel: "Run now",
    // Not destructive: it creates a draft and destroys nothing. Painting it
    // red would train operators to ignore the colour where it does matter.
    destructive: false,
  };
}

/** Post-start toast copy. The run is detached, so this is a start, not a result. */
export function runNowSuccessMessage(name: string): string {
  return `Started ${name || "the routine"}. The agent drafts in the background — its outcome appears in the run history.`;
}

/**
 * Failure copy for `POST /{id}/run`, branched on what the server can actually
 * answer with.
 *
 * `routines_unavailable` is the one worth spelling out: `RunNow` returns 503
 * with that code when `Deps.Runner` is nil, which is a DEPLOYMENT fact about
 * this workspace's server, not a transient fault. Telling the operator to try
 * again would send them into a loop that cannot succeed.
 */
export function runNowErrorMessage(error: unknown): string {
  const bag =
    error && typeof error === "object"
      ? (error as { status?: unknown; code?: unknown; message?: unknown })
      : {};
  const code = typeof bag.code === "string" ? bag.code : "";
  const status = typeof bag.status === "number" ? bag.status : 0;
  if (code === "routines_unavailable" || status === 503) {
    return "Agent execution is switched off on this workspace's server, so the routine cannot be run from here.";
  }
  if (status === 403) return "Running a routine needs an editor role on this workspace.";
  if (status === 404) return "That routine no longer exists.";
  if (status === 401) return "Your session expired. Sign in and try again.";
  // `statusFromError` yields 0 for a thrown value the SDK did not tag — which
  // is exactly the "the request never got an HTTP answer" case. It is only
  // claimed when a status was actually PRESENT and zero: an error object with
  // no status at all carries no evidence about the network, and inventing
  // "check your connection" for it would send someone to debug a working one.
  if ("status" in bag && status === 0) {
    return "The request never reached the server. Check your connection and try again.";
  }
  const message = typeof bag.message === "string" ? bag.message.trim() : "";
  return message || "Please try again.";
}

/**
 * Pause / resume copy for a standing routine.
 *
 * ── WHY THIS ONE PATCH FIELD IS SAFE WHEN THE FORM IS NOT ──────────────────
 * `api/agentRoutines.ts` refuses PATCH wholesale, on the grounds that the body
 * is "a nine-field partial with pointer semantics that a phone form would have
 * to reproduce exactly". That is right about AUTHORING — and the pointer
 * semantics are precisely what make a ONE-field disable safe: `UpdateRoutine`
 * declares `Enabled *bool` with nil meaning "leave unchanged"
 * (`agent_routines/routines.go`), so a body of exactly `{"enabled": false}`
 * clears nothing else.
 *
 * The screen already sorts routines into "scheduled" and "paused"
 * (`matchesRoutineFilter`) and offered no way to move one between them.
 *
 * ── NAME THE SCHEDULE, NOT THE FLAG ────────────────────────────────────────
 * `FindDue` selects `WHERE enabled AND schedule <> 'manual'`, so pausing a
 * SCHEDULED routine stops future automatic runs, while pausing a MANUAL one
 * changes nothing about a schedule that never fired — it only blocks run-now.
 * Saying "this stops the daily run" to somebody pausing a manual routine would
 * be false, so the copy branches on the schedule.
 */
export function routineEnableCopy(routine: {
  name: string;
  enabled: boolean;
  schedule: string;
}): { title: string; message: string; confirmLabel: string } {
  const scheduled = routine.schedule !== "manual" && routine.schedule !== "";
  if (routine.enabled) {
    return {
      title: `Pause ${routine.name}?`,
      message: scheduled
        ? `Its ${routine.schedule} schedule stops firing. Nothing already running is cancelled, and resuming puts it back on the same schedule.`
        : "This routine has no schedule, so pausing only blocks running it by hand. Nothing already running is cancelled.",
      confirmLabel: "Pause",
    };
  }
  return {
    title: `Resume ${routine.name}?`,
    message: scheduled
      ? `It goes back on its ${routine.schedule} schedule and may run without further input.`
      : "It becomes runnable by hand again. It has no schedule, so it will not start on its own.",
    confirmLabel: "Resume",
  };
}

/**
 * The server refuses an update while a run is in flight (`ErrRoutineActive`,
 * shared by start/update/delete so no caller learns another run's provider
 * state). 409 is therefore an expected answer, not a bug, and deserves a
 * sentence that says what to do rather than a generic failure.
 */
export function routineEnableErrorMessage(
  status: number | undefined,
  fallback: string,
): string {
  if (status === 409) {
    return "This routine has a run in progress. Wait for it to finish, then try again.";
  }
  if (status === 403) {
    return "Pausing a routine needs an editor role on this workspace.";
  }
  return fallback;
}
