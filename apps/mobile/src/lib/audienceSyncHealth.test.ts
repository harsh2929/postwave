import { describe, expect, it } from "vitest";

import {
  healthPresentation,
  isFailingRunStatus,
  matchesSyncFilter,
  matchesSyncQuery,
  nextRunPrefix,
  orderSyncs,
  scheduleGraceMs,
  scheduleIntervalMs,
  SCHEDULE_MIN_GRACE_MS,
  syncFilterCounts,
  syncHealthState,
  syncScheduleState,
  SYNC_HEALTH_STATES,
  type HealthInputs,
} from "./audienceSyncHealth";

const NOW = Date.parse("2026-07-25T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function sync(overrides: Partial<HealthInputs> = {}): HealthInputs {
  return {
    enabled: true,
    schedule: "daily",
    lastRunAt: new Date(NOW - 2 * HOUR).toISOString(),
    lastRunStatus: "succeeded",
    createdAt: new Date(NOW - 30 * DAY).toISOString(),
    ...overrides,
  };
}

describe("the schedule intervals mirror claimDue", () => {
  it("uses the two interval literals the SQL actually contains", () => {
    // sync_scheduler.go:122-123 — interval '1 hour' / interval '24 hours'.
    expect(scheduleIntervalMs("hourly")).toBe(HOUR);
    expect(scheduleIntervalMs("daily")).toBe(DAY);
  });

  it("refuses to guess an interval for manual or an unknown schedule", () => {
    // A guess here would badge a sync overdue on arithmetic the server never
    // performs.
    expect(scheduleIntervalMs("manual")).toBe(0);
    expect(scheduleIntervalMs("weekly")).toBe(0);
  });

  it("scales the grace with the interval, on a floor of one drain cycle", () => {
    // Fifteen minutes is a quarter of an hourly period and a rounding error
    // for a daily one, so the grace is proportional with a floor.
    expect(scheduleGraceMs("hourly")).toBe(SCHEDULE_MIN_GRACE_MS);
    expect(scheduleGraceMs("daily")).toBe(72 * MINUTE);
  });
});

describe("when the next run is", () => {
  it("names a future instant for a healthy scheduled sync", () => {
    const state = syncScheduleState(sync({ schedule: "hourly", lastRunAt: new Date(NOW - 10 * MINUTE).toISOString() }), NOW);
    expect(state.reason).toBe("scheduled");
    expect(state.at).toBe(NOW - 10 * MINUTE + HOUR);
    expect(state.overdue).toBe(false);
    expect(nextRunPrefix(state.reason)).toBe("Next run");
  });

  it("says 'due now' inside the scheduler's working grace, not 'overdue'", () => {
    // The scheduler ticks once a minute and drains twenty per tick, so being a
    // few minutes past the nominal instant is NORMAL operation.
    const state = syncScheduleState(
      sync({ schedule: "hourly", lastRunAt: new Date(NOW - HOUR - 2 * MINUTE).toISOString() }),
      NOW,
    );
    expect(state.reason).toBe("due");
    expect(state.overdue).toBe(false);
  });

  it("calls it overdue past the grace", () => {
    const state = syncScheduleState(
      sync({ schedule: "hourly", lastRunAt: new Date(NOW - HOUR - 10 * MINUTE).toISOString() }),
      NOW,
    );
    expect(state.reason).toBe("overdue");
    expect(state.overdue).toBe(true);
    expect(nextRunPrefix("overdue")).toBe("Overdue since");
  });

  it("never calls a DISABLED sync overdue, because `WHERE enabled` hides it", () => {
    const state = syncScheduleState(
      sync({ enabled: false, schedule: "hourly", lastRunAt: new Date(NOW - 40 * DAY).toISOString() }),
      NOW,
    );
    expect(state.reason).toBe("paused");
    expect(state.overdue).toBe(false);
    expect(state.at).toBeNull();
  });

  it("never calls a MANUAL sync overdue, because `schedule <> 'manual'` hides it", () => {
    const state = syncScheduleState(
      sync({ schedule: "manual", lastRunAt: new Date(NOW - 40 * DAY).toISOString() }),
      NOW,
    );
    expect(state.reason).toBe("manual");
    expect(state.overdue).toBe(false);
  });

  it("has no instant to name for a scheduled sync that never ran", () => {
    // `last_run_at IS NULL` matches the due-scan immediately, so there is no
    // future instant — and an em-dash is the honest render, not a date.
    const state = syncScheduleState(sync({ lastRunAt: null }), NOW);
    expect(state.reason).toBe("never_run");
    expect(state.at).toBeNull();
  });

  it("does not badge a JUST-CREATED sync overdue for never having run", () => {
    // The due-scan matches `last_run_at IS NULL` at once, but a sync created a
    // minute ago has not been MISSED — badging it would be a false alarm that
    // teaches people to ignore the badge.
    const state = syncScheduleState(
      sync({ lastRunAt: null, createdAt: new Date(NOW - MINUTE).toISOString() }),
      NOW,
    );
    expect(state.reason).toBe("never_run");
    expect(state.overdue).toBe(false);
  });

  it("does badge a sync that has sat there unrun since it was created", () => {
    const state = syncScheduleState(
      sync({ lastRunAt: null, createdAt: new Date(NOW - 9 * DAY).toISOString() }),
      NOW,
    );
    expect(state.overdue).toBe(true);
  });

  it("declines to claim lateness when it cannot tell when the sync appeared", () => {
    const state = syncScheduleState(sync({ lastRunAt: null, createdAt: null }), NOW);
    expect(state.overdue).toBe(false);
  });

  it("refuses to derive anything from a schedule it does not recognise", () => {
    const state = syncScheduleState(sync({ schedule: "fortnightly" }), NOW);
    expect(state.reason).toBe("unknown");
    expect(state.at).toBeNull();
    expect(state.overdue).toBe(false);
  });
});

describe("health is a partition, ordered by the server's own predicates", () => {
  it("treats all four non-success terminals as failing", () => {
    for (const status of ["failed", "rejected", "partial", "needs_reconciliation"]) {
      expect(isFailingRunStatus(status)).toBe(true);
      expect(syncHealthState(sync({ lastRunStatus: status }), NOW)).toBe("failing");
    }
    expect(isFailingRunStatus("succeeded")).toBe(false);
    expect(isFailingRunStatus("running")).toBe(false);
  });

  it("ranks paused above failing, because a disabled sync is not claimable", () => {
    // `WHERE enabled` means the scheduler never looked; calling it "failing" or
    // "overdue" would blame the platform for a state the operator chose.
    expect(
      syncHealthState(
        sync({ enabled: false, lastRunStatus: "failed", lastRunAt: new Date(NOW - 40 * DAY).toISOString() }),
        NOW,
      ),
    ).toBe("paused");
  });

  it("ranks failing above overdue, because a recorded failure is evidence", () => {
    expect(
      syncHealthState(
        sync({ lastRunStatus: "failed", lastRunAt: new Date(NOW - 5 * DAY).toISOString() }),
        NOW,
      ),
    ).toBe("failing");
  });

  it("calls a late scheduled sync overdue", () => {
    expect(
      syncHealthState(sync({ lastRunAt: new Date(NOW - 5 * DAY).toISOString() }), NOW),
    ).toBe("overdue");
  });

  it("calls a long-unrun SCHEDULED sync overdue, not merely 'never'", () => {
    // It has been matching the due-scan's first branch for thirty days.
    expect(syncHealthState(sync({ lastRunAt: null }), NOW)).toBe("overdue");
  });

  it("calls a freshly-created scheduled sync 'never', not 'overdue'", () => {
    expect(
      syncHealthState(
        sync({ lastRunAt: null, createdAt: new Date(NOW - MINUTE).toISOString() }),
        NOW,
      ),
    ).toBe("never");
  });

  it("calls a manual sync that never ran 'never', not 'overdue'", () => {
    expect(
      syncHealthState(sync({ schedule: "manual", lastRunAt: null }), NOW),
    ).toBe("never");
  });

  it("calls a fresh, successful, on-schedule sync healthy", () => {
    expect(syncHealthState(sync(), NOW)).toBe("ok");
  });

  it("gives every state a word and a spoken sentence, never colour alone", () => {
    for (const state of SYNC_HEALTH_STATES) {
      const presented = healthPresentation(state);
      expect(presented.label.length).toBeGreaterThan(0);
      expect(presented.spoken.length).toBeGreaterThan(presented.label.length);
    }
  });
});

describe("filters and counts", () => {
  const rows = [
    sync({ lastRunStatus: "failed" }),
    sync({ lastRunAt: new Date(NOW - 5 * DAY).toISOString() }),
    sync({ enabled: false }),
    sync(),
  ];

  it("puts each sync in exactly one bucket", () => {
    expect(rows.filter((row) => matchesSyncFilter(row, "failing", NOW))).toHaveLength(1);
    expect(rows.filter((row) => matchesSyncFilter(row, "overdue", NOW))).toHaveLength(1);
    expect(rows.filter((row) => matchesSyncFilter(row, "paused", NOW))).toHaveLength(1);
    expect(rows.filter((row) => matchesSyncFilter(row, "all", NOW))).toHaveLength(4);
  });

  it("counts the three states worth opening a phone for", () => {
    expect(syncFilterCounts(rows, NOW)).toEqual({
      all: 4,
      failing: 1,
      overdue: 1,
      paused: 1,
    });
  });

  it("searches the destination as well as the name", () => {
    const row = {
      name: "Warehouse mirror",
      destination: { type: "webhook", url: "https://in.example.test/hook" },
    };
    expect(matchesSyncQuery(row, "warehouse")).toBe(true);
    expect(matchesSyncQuery(row, "example.test")).toBe(true);
    expect(matchesSyncQuery(row, "webhook")).toBe(true);
    expect(matchesSyncQuery(row, "")).toBe(true);
    expect(matchesSyncQuery(row, "meta")).toBe(false);
  });
});

describe("ordering", () => {
  function named(id: string, overrides: Partial<HealthInputs> = {}) {
    return { id, name: id, ...sync(overrides) };
  }

  it("leads with what broke, then what is late, and sinks what is paused", () => {
    const ordered = orderSyncs(
      [
        named("healthy"),
        named("paused", { enabled: false }),
        named("late", { lastRunAt: new Date(NOW - 5 * DAY).toISOString() }),
        named("broken", { lastRunStatus: "failed" }),
      ],
      NOW,
    );
    expect(ordered.map((row) => row.id)).toEqual([
      "broken",
      "late",
      "healthy",
      "paused",
    ]);
  });

  it("within a band, the destination wrong the LONGEST leads", () => {
    const ordered = orderSyncs(
      [
        named("recent", { lastRunStatus: "failed", lastRunAt: new Date(NOW - HOUR).toISOString() }),
        named("ancient", { lastRunStatus: "failed", lastRunAt: new Date(NOW - 9 * DAY).toISOString() }),
      ],
      NOW,
    );
    expect(ordered.map((row) => row.id)).toEqual(["ancient", "recent"]);
  });

  it("is stable across refetches so a row does not move under a thumb", () => {
    const rows = [named("b"), named("a"), named("c")];
    expect(orderSyncs(rows, NOW).map((row) => row.id)).toEqual(
      orderSyncs([...rows].reverse(), NOW).map((row) => row.id),
    );
  });

  it("does not sort a never-run sync as though it ran at the epoch", () => {
    // Same band (both paused), so only the staleness tiebreak decides. A null
    // `last_run_at` must sort LAST, not first: `Date.parse(null)` is NaN and a
    // careless `|| 0` would put it at 1970 and claim it is the most stale row
    // on the screen.
    const ordered = orderSyncs(
      [
        named("never", { enabled: false, lastRunAt: null }),
        named("old", { enabled: false, lastRunAt: new Date(NOW - 40 * DAY).toISOString() }),
      ],
      NOW,
    );
    expect(ordered.map((row) => row.id)).toEqual(["old", "never"]);
  });

  it("ranks a never-run sync ahead of a healthy one", () => {
    const ordered = orderSyncs(
      [named("healthy"), named("never", { schedule: "manual", lastRunAt: null })],
      NOW,
    );
    expect(ordered.map((row) => row.id)).toEqual(["never", "healthy"]);
  });
});
