/**
 * lib/audienceSyncHealth.ts — whether the platform is LATE, whether the last
 * run BROKE, and the order those two facts should reach a thumb.
 *
 * Split from lib/audienceSyncs.ts so neither file grows past the source budget,
 * and because the seam is real: that file parses and labels what the server
 * SENT, this one derives what the server WILL DO and how alarmed to be. Both
 * are import-free so they run in the node vitest environment.
 *
 * THERE IS NO `next_run_at` ON THE WIRE. The Go model has `last_run_at`, a
 * schedule name and `enabled` (syncs.go:123-136) and nothing else. The next run
 * is derived, and it is derived from exactly one place server-side —
 * `SyncScheduler.claimDue` (sync_scheduler.go:113-125):
 *
 *     WHERE enabled
 *       AND schedule <> 'manual'
 *       AND (last_run_at IS NULL
 *            OR (schedule = 'hourly' AND last_run_at < now() - interval '1 hour')
 *            OR (schedule = 'daily'  AND last_run_at < now() - interval '24 hours'))
 *
 * Every predicate below mirrors a clause of that query, including the ones that
 * are easy to skip:
 *
 *  - A DISABLED SYNC IS NEVER OVERDUE. `WHERE enabled` means the scheduler
 *    cannot see it at all, so "late" is not a claim that can be made about it.
 *    Paused therefore RANKS ABOVE overdue in the health partition rather than
 *    being some separate axis.
 *  - A MANUAL SYNC IS NEVER OVERDUE either — `schedule <> 'manual'` excludes
 *    it. Its `last_run_at` says when someone last pressed the button, and
 *    nothing is expected of it in between.
 *  - `last_run_at IS NULL` IS DUE IMMEDIATELY. A scheduled sync that has never
 *    completed a run matches the first branch, so the next tick picks it up;
 *    there is no future instant to name and `at` stays null.
 *  - `last_run_at` IS STAMPED AT RUN *END* (operation_safety.go:211, :340), so
 *    the interval is measured from a completed run, not from a start.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Mirrors the two interval literals in `claimDue`. Zero for manual and for
 * anything unrecognised — a sync on a schedule this client does not know about
 * is never claimed to be due, because the claim would be a guess.
 */
export function scheduleIntervalMs(schedule: string): number {
  switch (schedule.trim().toLowerCase()) {
    case "hourly":
      return HOUR_MS;
    case "daily":
      return DAY_MS;
    default:
      return 0;
  }
}

/** The floor on the grace below. One scheduler tick is a minute. */
export const SCHEDULE_MIN_GRACE_MS = 5 * MINUTE_MS;

/**
 * How late the platform may be before the phone calls a sync overdue.
 *
 * A FIXED grace is wrong in both directions here, because the two intervals are
 * a factor of twenty-four apart: fifteen minutes is a quarter of an hourly
 * sync's whole period, and a rounding error for a daily one. So the grace is
 * proportional with a floor — five minutes, or 5% of the interval, whichever is
 * larger. That is five minutes for hourly and seventy-two for daily.
 *
 * The floor is the scheduler's own working slack: it ticks once a minute and
 * executes at most twenty syncs per tick (`schedulerTick` /
 * `schedulerMaxPerTick`, sync_scheduler.go:27-31), so a backlog of a hundred
 * syncs takes five minutes to drain and NONE of them is faulty. Below the grace
 * the phone says "due now"; above it, something is wrong, and saying so is the
 * whole value of this screen.
 */
export function scheduleGraceMs(schedule: string): number {
  const interval = scheduleIntervalMs(schedule);
  if (interval <= 0) return SCHEDULE_MIN_GRACE_MS;
  return Math.max(SCHEDULE_MIN_GRACE_MS, Math.round(interval * 0.05));
}

export type NextRunReason =
  /** `WHERE enabled` excludes it: the scheduler cannot see this sync. */
  | "paused"
  /** `schedule <> 'manual'` excludes it: it runs only when someone says so. */
  | "manual"
  /** Enabled + scheduled + `last_run_at IS NULL`: due on the next tick. */
  | "never_run"
  /** A future instant we can name. */
  | "scheduled"
  /** Past its instant, inside the scheduler's normal working grace. */
  | "due"
  /** Past its instant by more than the grace — the platform has missed it. */
  | "overdue"
  /** Enabled, non-manual, but on a schedule this client cannot interpret. */
  | "unknown";

export interface SyncScheduleState {
  /**
   * Epoch ms of the next expected automatic run, or NULL when there is no such
   * instant to name. Null is the honest answer for paused, manual, never-run
   * and unknown-schedule syncs: an absent measurement renders as an em-dash,
   * never as a date and never as "now".
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
  /**
   * When the sync was created. Needed ONLY for the never-run case, and it is
   * genuinely needed — see `syncScheduleState`.
   */
  createdAt: string | null;
}

export function syncScheduleState(
  sync: ScheduleInputs,
  now: number,
): SyncScheduleState {
  if (!sync.enabled) return { at: null, reason: "paused", overdue: false };
  if (sync.schedule.trim().toLowerCase() === "manual") {
    return { at: null, reason: "manual", overdue: false };
  }
  const interval = scheduleIntervalMs(sync.schedule);
  if (interval <= 0) return { at: null, reason: "unknown", overdue: false };

  const last = sync.lastRunAt ? Date.parse(sync.lastRunAt) : Number.NaN;
  if (!Number.isFinite(last)) {
    // `last_run_at IS NULL` is the FIRST branch of the due-scan, so the very
    // next tick should pick this sync up and there is no future instant to
    // name. But "the SQL matches it" is not the same as "the platform is
    // late": a sync created twenty seconds ago has not been missed, and
    // badging it Overdue would be a false alarm that teaches people to ignore
    // the badge. `created_at` is on the wire (syncSelectColumns), so the
    // reference point is the moment it BECAME due — its creation — and the
    // same grace applies. With no parsable `created_at` we decline to claim
    // lateness at all rather than guess.
    const created = sync.createdAt ? Date.parse(sync.createdAt) : Number.NaN;
    const overdue =
      Number.isFinite(created) && now > created + scheduleGraceMs(sync.schedule);
    return { at: null, reason: "never_run", overdue };
  }

  const at = last + interval;
  // Strict `>`, mirroring the SQL's `last_run_at < now() - interval`.
  if (now > at + scheduleGraceMs(sync.schedule)) {
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
 * The statuses `last_run_status` can hold that are NOT a clean success. All
 * four are terminal (`runTerminalStatus`, sync_runner.go:173-187) and all four
 * mean an operator has something to do — which is why they collapse into one
 * "failing" band rather than four filter chips nobody would use.
 */
export const FAILING_RUN_STATUSES: readonly string[] = [
  "failed",
  "rejected",
  "partial",
  "needs_reconciliation",
];

export function isFailingRunStatus(status: string): boolean {
  return FAILING_RUN_STATUSES.includes(status.trim().toLowerCase());
}

/**
 * One sync's health, as a PARTITION: every sync lands in exactly one state, and
 * the order below is the order of the server's own predicates rather than an
 * opinion. `paused` outranks `failing` and `overdue` because `WHERE enabled`
 * makes both of those unclaimable for a disabled sync; `failing` outranks
 * `overdue` because a recorded failure is evidence, and lateness is inference.
 */
export const SYNC_HEALTH_STATES = [
  "paused",
  "failing",
  "overdue",
  "never",
  "ok",
] as const;
export type SyncHealthState = (typeof SYNC_HEALTH_STATES)[number];

export interface HealthInputs extends ScheduleInputs {
  lastRunStatus: string;
}

export function syncHealthState(
  sync: HealthInputs,
  now: number,
): SyncHealthState {
  if (!sync.enabled) return "paused";
  if (isFailingRunStatus(sync.lastRunStatus)) return "failing";
  // `overdue` here covers BOTH shapes the due-scan matches: a completed run
  // older than the interval, and a scheduled sync that has never run at all
  // and has been sitting there past the grace since it was created.
  if (syncScheduleState(sync, now).overdue) return "overdue";
  if (!sync.lastRunAt) return "never";
  return "ok";
}

export interface HealthPresentation {
  label: string;
  tone: "neutral" | "success" | "warning" | "danger";
  spoken: string;
}

const HEALTH_PRESENTATION: Readonly<
  Record<SyncHealthState, HealthPresentation>
> = {
  paused: {
    label: "Paused",
    tone: "neutral",
    spoken:
      "Paused: the scheduler skips this sync entirely, so nothing reaches the destination on its own.",
  },
  failing: {
    label: "Failing",
    tone: "danger",
    spoken:
      "Failing: its last run did not fully succeed, so the destination is out of date.",
  },
  overdue: {
    label: "Overdue",
    tone: "warning",
    spoken:
      "Overdue: the platform has not run this when it was supposed to, so the destination is drifting.",
  },
  never: {
    label: "Never run",
    tone: "neutral",
    spoken: "This sync has never completed a run, so nothing has been delivered yet.",
  },
  ok: {
    label: "Healthy",
    tone: "success",
    spoken: "Its last run succeeded and it is on schedule.",
  },
};

export function healthPresentation(state: SyncHealthState): HealthPresentation {
  return HEALTH_PRESENTATION[state];
}

/**
 * The filter chips. `all` plus the three states worth opening a phone for —
 * `never` and `ok` deliberately have no chip, because "show me the syncs that
 * are fine" is not a question anyone asks at 9pm.
 */
export const SYNC_FILTERS = ["all", "failing", "overdue", "paused"] as const;
export type SyncFilter = (typeof SYNC_FILTERS)[number];

export function matchesSyncFilter(
  sync: HealthInputs,
  filter: SyncFilter,
  now: number,
): boolean {
  if (filter === "all") return true;
  return syncHealthState(sync, now) === filter;
}

export function syncFilterCounts(
  syncs: readonly HealthInputs[],
  now: number,
): Record<SyncFilter, number> {
  const counts: Record<SyncFilter, number> = {
    all: syncs.length,
    failing: 0,
    overdue: 0,
    paused: 0,
  };
  for (const sync of syncs) {
    const state = syncHealthState(sync, now);
    if (state === "failing" || state === "overdue" || state === "paused") {
      counts[state] += 1;
    }
  }
  return counts;
}

/**
 * Attention order. A sync whose last run BROKE is the reason this screen exists
 * on a phone, so it leads; a sync the platform has MISSED follows; paused rows
 * sink, because a paused sync not running is the state the operator chose.
 * Within a band the LONGEST-STALE leads — the destination that has been wrong
 * the longest is the one to look at first — and rows with no nameable last run
 * fall to the end of their band rather than sorting as "epoch".
 *
 * Ties break on name then id so the list is stable across refetches: an
 * unstable order moves a row under a thumb already travelling toward it.
 */
export function orderSyncs<
  T extends HealthInputs & { name: string; id: string },
>(syncs: readonly T[], now: number): T[] {
  const rank: Record<SyncHealthState, number> = {
    failing: 0,
    overdue: 1,
    never: 2,
    ok: 3,
    paused: 4,
  };
  // Null rather than a ±Infinity sentinel: `Infinity - finite` is Infinity,
  // which is not finite, so any `Number.isFinite(delta)` guard silently throws
  // the comparison away and the tiebreak falls through to the name. An
  // explicit null makes "no measurement" a branch instead of an arithmetic
  // accident.
  const staleness = (row: T): number | null => {
    const at = row.lastRunAt ? Date.parse(row.lastRunAt) : Number.NaN;
    return Number.isFinite(at) ? at : null;
  };
  return [...syncs].sort((a, b) => {
    const bandDelta = rank[syncHealthState(a, now)] - rank[syncHealthState(b, now)];
    if (bandDelta !== 0) return bandDelta;
    const aAt = staleness(a);
    const bAt = staleness(b);
    if (aAt !== null && bAt !== null && aAt !== bAt) return aAt - bAt;
    if (aAt !== null && bAt === null) return -1;
    if (aAt === null && bAt !== null) return 1;
    const byName = a.name.localeCompare(b.name);
    return byName !== 0 ? byName : a.id.localeCompare(b.id);
  });
}

/**
 * Search over the fields a person can actually recall: the sync's name and the
 * destination it points at. The destination URL is included because "which one
 * posts to the warehouse?" is a real question and the name rarely answers it.
 */
export function matchesSyncQuery(
  sync: { name: string; destination: { type: string; url: string } },
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    sync.name.toLowerCase().includes(needle) ||
    sync.destination.type.toLowerCase().includes(needle) ||
    sync.destination.url.toLowerCase().includes(needle)
  );
}
