import { describe, expect, it } from "vitest";

import {
  nextRunPrefix,
  orderRoutines,
  routineScheduleState,
  runNowCopy,
  runNowErrorMessage,
  runNowSuccessMessage,
  SCHEDULE_GRACE_MS,
  scheduleIntervalMs,
  routineEnableCopy,
  routineEnableErrorMessage,
} from "./agentRoutineSchedule";

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-07-25T12:00:00Z");

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

describe("agentRoutineSchedule — intervals mirror the Go source", () => {
  it("matches scheduleInterval() exactly, including the 30-day month", () => {
    expect(scheduleIntervalMs("daily")).toBe(DAY);
    expect(scheduleIntervalMs("weekly")).toBe(7 * DAY);
    // routines.go: "Monthly is a fixed 30 days in v1" — and the SQL agrees
    // (`interval '30 days'`). A calendar month here would be a nicer lie.
    expect(scheduleIntervalMs("monthly")).toBe(30 * DAY);
  });

  it("returns zero for manual and for anything it does not recognise", () => {
    expect(scheduleIntervalMs("manual")).toBe(0);
    expect(scheduleIntervalMs("hourly")).toBe(0);
    expect(scheduleIntervalMs("")).toBe(0);
  });
});

describe("agentRoutineSchedule — the next run is DERIVED, and absence stays absent", () => {
  it("names no instant for a paused routine, because the scheduler skips it", () => {
    const state = routineScheduleState(
      { enabled: false, schedule: "daily", lastRunAt: at(-DAY) },
      NOW,
    );
    expect(state).toEqual({ at: null, reason: "paused", overdue: false });
  });

  it("names no instant for a manual routine", () => {
    expect(
      routineScheduleState(
        { enabled: true, schedule: "manual", lastRunAt: at(-DAY) },
        NOW,
      ),
    ).toEqual({ at: null, reason: "manual", overdue: false });
  });

  it("names no instant for a never-run routine, which the next tick picks up", () => {
    expect(
      routineScheduleState(
        { enabled: true, schedule: "weekly", lastRunAt: null },
        NOW,
      ),
    ).toEqual({ at: null, reason: "never_run", overdue: false });
  });

  it("refuses to guess for a schedule it does not recognise", () => {
    expect(
      routineScheduleState(
        { enabled: true, schedule: "hourly", lastRunAt: at(-DAY) },
        NOW,
      ),
    ).toEqual({ at: null, reason: "unknown", overdue: false });
  });

  it("computes last_run_at + interval for a scheduled routine", () => {
    const state = routineScheduleState(
      { enabled: true, schedule: "daily", lastRunAt: at(-6 * 60 * 60_000) },
      NOW,
    );
    expect(state.reason).toBe("scheduled");
    expect(state.at).toBe(NOW + 18 * 60 * 60_000);
    expect(state.overdue).toBe(false);
  });

  it("treats the boundary instant as not yet due, mirroring the SQL's strict <", () => {
    // `Repo.FindDue` uses `last_run_at < now() - interval`, so the scheduler
    // does NOT fire at exactly last + interval. (Go's pure `IsDue` does, by
    // one instant; the SQL is the code path that runs.)
    const exactly = routineScheduleState(
      { enabled: true, schedule: "daily", lastRunAt: at(-DAY) },
      NOW,
    );
    expect(exactly.reason).toBe("scheduled");
    const oneMsLater = routineScheduleState(
      { enabled: true, schedule: "daily", lastRunAt: at(-DAY - 1) },
      NOW,
    );
    expect(oneMsLater.reason).toBe("due");
  });

  it("stays 'due' inside the scheduler's normal working grace", () => {
    // One tick is a minute and one tick drains at most ten routines, so being
    // a few minutes late is normal operation, not a fault worth alarming on.
    const state = routineScheduleState(
      { enabled: true, schedule: "daily", lastRunAt: at(-DAY - SCHEDULE_GRACE_MS) },
      NOW,
    );
    expect(state.reason).toBe("due");
    expect(state.overdue).toBe(false);
  });

  it("calls it overdue once the platform is later than that", () => {
    const state = routineScheduleState(
      {
        enabled: true,
        schedule: "daily",
        lastRunAt: at(-DAY - SCHEDULE_GRACE_MS - 1),
      },
      NOW,
    );
    expect(state.reason).toBe("overdue");
    expect(state.overdue).toBe(true);
    expect(state.at).toBe(NOW - SCHEDULE_GRACE_MS - 1);
  });

  it("gives every reason its own words, and none of them says 'now' for an absent time", () => {
    expect(nextRunPrefix("paused")).toBe("Paused — no automatic runs");
    expect(nextRunPrefix("manual")).toBe("Runs only when you say so");
    expect(nextRunPrefix("never_run")).toContain("Never run");
    expect(nextRunPrefix("due")).toBe("Due now");
    expect(nextRunPrefix("overdue")).toBe("Overdue since");
    expect(nextRunPrefix("unknown")).toBe("Unrecognised schedule");
    expect(nextRunPrefix("scheduled")).toBe("Next run");
  });
});

describe("agentRoutineSchedule — attention order", () => {
  const rows = [
    { id: "paused", name: "Paused", enabled: false, schedule: "daily", lastRunAt: at(-9 * DAY) },
    { id: "soon", name: "Soon", enabled: true, schedule: "daily", lastRunAt: at(-23 * 60 * 60_000) },
    { id: "later", name: "Later", enabled: true, schedule: "weekly", lastRunAt: at(-60 * 60_000) },
    { id: "overdue", name: "Overdue", enabled: true, schedule: "daily", lastRunAt: at(-5 * DAY) },
    { id: "manual", name: "Manual", enabled: true, schedule: "manual", lastRunAt: null },
    { id: "fresh", name: "Fresh", enabled: true, schedule: "weekly", lastRunAt: null },
  ];

  it("puts what the platform has MISSED first and what the operator paused last", () => {
    expect(orderRoutines(rows, NOW).map((r) => r.id)).toEqual([
      "overdue",
      "fresh",
      "soon",
      "later",
      "manual",
      "paused",
    ]);
  });

  it("is stable: the same input always yields the same order", () => {
    const once = orderRoutines(rows, NOW).map((r) => r.id);
    const twice = orderRoutines([...rows].reverse(), NOW).map((r) => r.id);
    expect(twice).toEqual(once);
  });

  it("breaks ties on name so a row cannot swap under a travelling thumb", () => {
    const tied = [
      { id: "b", name: "Beta", enabled: true, schedule: "manual", lastRunAt: null },
      { id: "a", name: "Alpha", enabled: true, schedule: "manual", lastRunAt: null },
    ];
    expect(orderRoutines(tied, NOW).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("does not mutate its input", () => {
    const input = [...rows];
    orderRoutines(input, NOW);
    expect(input.map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });
});

describe("agentRoutineSchedule — what the confirm sheet promises", () => {
  const base = {
    name: "Monday re-engagement",
    kind: "draft_campaign",
    enabled: true,
    schedule: "weekly",
    requireApproval: true,
  };

  it("states the safety invariant: a run only ever drafts", () => {
    const copy = runNowCopy(base);
    expect(copy.title).toContain("Monday re-engagement");
    expect(copy.message).toContain("draft campaign");
    expect(copy.message).toContain("nothing is sent");
    expect(copy.confirmLabel).toBe("Run now");
    // It creates a draft and destroys nothing; painting it red would devalue
    // the colour where it does mean destruction.
    expect(copy.destructive).toBe(false);
  });

  it("warns that a manual run restarts the schedule clock", () => {
    // `InsertRun` stamps `last_run_at = now()` in the same transaction, so a
    // manual run pushes the next AUTOMATIC run back by a whole interval.
    expect(runNowCopy(base).message).toContain("restarts the schedule clock");
    // …which is meaningless for a manual-only routine, so it is not claimed.
    expect(runNowCopy({ ...base, schedule: "manual" }).message).not.toContain(
      "restarts the schedule clock",
    );
  });

  it("says that running a PAUSED routine still works, because the handler allows it", () => {
    const copy = runNowCopy({ ...base, enabled: false });
    expect(copy.message).toContain("Pausing only stops the automatic schedule");
    // And the schedule-clock clause is dropped: it never auto-runs anyway.
    expect(copy.message).not.toContain("restarts the schedule clock");
  });

  it("tells the truth about where the draft lands, both ways round", () => {
    expect(runNowCopy(base).consequence).toContain("Approvals");
    expect(
      runNowCopy({ ...base, requireApproval: false }).consequence,
    ).toContain("no approval gate");
    // Neither is cancellable — no endpoint in the package stops a run.
    expect(runNowCopy(base).consequence).toContain("cannot be cancelled");
  });

  it("names the sequence kind when that is what the routine drafts", () => {
    expect(runNowCopy({ ...base, kind: "draft_sequence" }).message).toContain(
      "draft sequence",
    );
  });

  it("promises a START, not a result, because the work is detached", () => {
    const message = runNowSuccessMessage("Monday re-engagement");
    expect(message).toContain("Started Monday re-engagement");
    expect(message).toContain("background");
    expect(runNowSuccessMessage("")).toContain("the routine");
  });
});

describe("agentRoutineSchedule — failure copy", () => {
  it("does not tell an operator to retry a deployment-level 'off'", () => {
    // `RunNow` answers 503 routines_unavailable when Deps.Runner is nil.
    const message = runNowErrorMessage({
      status: 503,
      code: "routines_unavailable",
      message: "agent routine execution is not configured",
    });
    expect(message).toContain("switched off");
    expect(message).not.toMatch(/try again/i);
  });

  it("names the role floor rather than saying 'forbidden'", () => {
    expect(runNowErrorMessage({ status: 403 })).toContain("editor role");
  });

  it("distinguishes a deleted routine, an expired session and a dead network", () => {
    expect(runNowErrorMessage({ status: 404 })).toContain("no longer exists");
    expect(runNowErrorMessage({ status: 401 })).toContain("session expired");
    // `statusFromError` maps an untagged throw to 0 — a real transport failure.
    expect(runNowErrorMessage({ status: 0 })).toContain("never reached");
  });

  it("does not invent a network diagnosis for an error carrying no status", () => {
    // An absent status is not evidence of a dead network. Claiming one sends
    // the operator to debug a connection that is fine.
    expect(runNowErrorMessage({ message: "boom" })).toBe("boom");
    expect(runNowErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("falls back to the server's own message, then to a safe default", () => {
    expect(runNowErrorMessage({ status: 500, message: "boom" })).toBe("boom");
    expect(runNowErrorMessage({ status: 500 })).toBe("Please try again.");
    expect(runNowErrorMessage(null)).toBe("Please try again.");
  });
});

describe("routineEnableCopy names the schedule, not the flag", () => {
  it("tells a scheduled routine's owner what stops firing", () => {
    const copy = routineEnableCopy({
      name: "Daily digest",
      enabled: true,
      schedule: "daily",
    });
    expect(copy.title).toBe("Pause Daily digest?");
    expect(copy.message).toContain("daily schedule stops firing");
    expect(copy.confirmLabel).toBe("Pause");
  });

  it("does not claim a manual routine has a schedule to stop", () => {
    // Saying "this stops the daily run" to somebody pausing a manual routine
    // would simply be false — FindDue never selected it in the first place.
    const copy = routineEnableCopy({
      name: "Ad hoc",
      enabled: true,
      schedule: "manual",
    });
    expect(copy.message).toContain("no schedule");
    expect(copy.message).not.toContain("stops firing");
  });

  it("warns that resuming a scheduled routine can run without further input", () => {
    const copy = routineEnableCopy({
      name: "Daily digest",
      enabled: false,
      schedule: "daily",
    });
    expect(copy.title).toBe("Resume Daily digest?");
    expect(copy.message).toContain("without further input");
    expect(copy.confirmLabel).toBe("Resume");
  });

  it("treats an empty schedule like a manual one rather than naming it", () => {
    const copy = routineEnableCopy({ name: "X", enabled: true, schedule: "" });
    expect(copy.message).toContain("no schedule");
  });

  it("always says nothing in flight is cancelled when pausing", () => {
    for (const schedule of ["daily", "manual"]) {
      expect(
        routineEnableCopy({ name: "X", enabled: true, schedule }).message,
      ).toContain("Nothing already running is cancelled");
    }
  });
});

describe("routineEnableErrorMessage", () => {
  it("explains a 409 as an in-flight run, not a generic failure", () => {
    // ErrRoutineActive is shared by start/update/delete on purpose, so 409 is
    // an expected answer here rather than a bug.
    expect(routineEnableErrorMessage(409, "fallback")).toContain(
      "run in progress",
    );
  });

  it("explains a 403 as the editor floor", () => {
    expect(routineEnableErrorMessage(403, "fallback")).toContain("editor role");
  });

  it("passes anything else through untouched", () => {
    expect(routineEnableErrorMessage(500, "fallback")).toBe("fallback");
    expect(routineEnableErrorMessage(undefined, "fallback")).toBe("fallback");
  });
});
