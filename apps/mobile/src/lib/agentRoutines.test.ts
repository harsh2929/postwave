import { describe, expect, it } from "vitest";

import {
  hasLiveRun,
  latestRun,
  matchesRoutineFilter,
  matchesRoutineQuery,
  parseRoutine,
  parseRoutineList,
  parseRun,
  parseRunList,
  parseRunNowAck,
  routineFilterCounts,
  routineKindLabel,
  runDurationMs,
  runStatusPresentation,
  RUN_STALL_MS,
  scheduleLabel,
  timestamp,
  type AgentRoutine,
  type AgentRoutineRun,
} from "./agentRoutines";

/** A routine exactly as `Repo.ListRoutines` serialises one. */
function wireRoutine(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Monday re-engagement",
    prompt: "Every Monday draft a re-engagement campaign for lapsed subscribers",
    kind: "draft_campaign",
    schedule: "weekly",
    schedule_detail: {},
    target_list_id: null,
    target_segment_id: null,
    require_approval: true,
    enabled: true,
    last_run_at: "2026-07-20T09:00:00Z",
    created_by: "ops@example.com",
    created_at: "2026-06-01T09:00:00Z",
    updated_at: "2026-07-20T09:00:00Z",
    ...overrides,
  };
}

function wireRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    routine_id: "11111111-1111-4111-8111-111111111111",
    status: "succeeded",
    output_kind: "campaign",
    output_ref: "cmp-9",
    approval_id: "apr-4",
    error: "",
    prompt_used: "…",
    context_used: "…",
    reasoning: "Lapsed cohort is 4,120 people; a win-back offer fits.",
    started_at: "2026-07-20T09:00:00Z",
    finished_at: "2026-07-20T09:00:42Z",
    ...overrides,
  };
}

describe("agentRoutines — parsing the routine wire shape", () => {
  it("reads every field a list row renders", () => {
    const routine = parseRoutine(wireRoutine());
    expect(routine).toEqual<AgentRoutine>({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Monday re-engagement",
      prompt:
        "Every Monday draft a re-engagement campaign for lapsed subscribers",
      kind: "draft_campaign",
      schedule: "weekly",
      enabled: true,
      requireApproval: true,
      lastRunAt: "2026-07-20T09:00:00Z",
      createdBy: "ops@example.com",
      createdAt: "2026-06-01T09:00:00Z",
    });
  });

  it("rejects a row with no id rather than rendering a headless routine", () => {
    expect(parseRoutine(wireRoutine({ id: "" }))).toBeNull();
    expect(parseRoutine(null)).toBeNull();
    expect(parseRoutine([])).toBeNull();
  });

  it("never lets an ABSENT boolean read as an enabled or gated routine", () => {
    const routine = parseRoutine({ id: "r1" });
    expect(routine?.enabled).toBe(false);
    expect(routine?.requireApproval).toBe(false);
    // A string "true" is not a boolean true on this wire; treating it as one
    // would claim a gate the server never declared.
    expect(parseRoutine({ id: "r1", enabled: "true" })?.enabled).toBe(false);
  });

  it("treats a never-run routine's null last_run_at as absent, not as an epoch", () => {
    expect(parseRoutine(wireRoutine({ last_run_at: null }))?.lastRunAt).toBeNull();
  });

  it("drops Go's zero time, which would otherwise render as year 1", () => {
    expect(timestamp("0001-01-01T00:00:00Z")).toBeNull();
    expect(timestamp("not a date")).toBeNull();
    expect(timestamp("")).toBeNull();
    expect(timestamp("2026-07-20T09:00:00Z")).toBe("2026-07-20T09:00:00Z");
  });

  it("reads the {items} envelope AND a bare array, so drift cannot silently empty the screen", () => {
    expect(parseRoutineList({ items: [wireRoutine()] })).toHaveLength(1);
    expect(parseRoutineList([wireRoutine()])).toHaveLength(1);
    expect(parseRoutineList({ items: [wireRoutine(), { id: "" }] })).toHaveLength(
      1,
    );
    expect(parseRoutineList({ data: [wireRoutine()] })).toEqual([]);
    expect(parseRoutineList(null)).toEqual([]);
  });
});

describe("agentRoutines — parsing the run wire shape", () => {
  it("carries the approval id, so run → approval needs no second request", () => {
    expect(parseRun(wireRun())?.approvalId).toBe("apr-4");
  });

  it("keeps an unset status empty rather than defaulting it to a success", () => {
    const run = parseRun(wireRun({ status: "" }));
    expect(run?.status).toBe("");
    expect(runStatusPresentation(run!, Date.now()).label).toBe("Unknown");
  });

  it("treats a still-running run's null finished_at as absent", () => {
    const run = parseRun(wireRun({ status: "running", finished_at: null }));
    expect(run?.finishedAt).toBeNull();
  });

  it("parses the run list envelope", () => {
    expect(parseRunList({ items: [wireRun()] })).toHaveLength(1);
    expect(parseRunList([wireRun()])).toHaveLength(1);
    expect(parseRunList({})).toEqual([]);
  });

  it("parses the 202 acknowledgement and refuses to invent a run id", () => {
    expect(parseRunNowAck({ run_id: "run-7", status: "running" })).toEqual({
      runId: "run-7",
      status: "running",
    });
    // Status is defaulted (the handler always sends "running"); the ID is not.
    expect(parseRunNowAck({ run_id: "run-7" })?.status).toBe("running");
    expect(parseRunNowAck({ status: "running" })).toBeNull();
    expect(parseRunNowAck(null)).toBeNull();
  });
});

describe("agentRoutines — run status presentation", () => {
  const start = Date.parse("2026-07-20T09:00:00Z");

  it("names the two terminal outcomes and speaks them in full", () => {
    const ok = runStatusPresentation(
      { status: "succeeded", startedAt: null, finishedAt: null },
      start,
    );
    expect(ok).toMatchObject({ label: "Succeeded", tone: "success" });
    expect(ok.spoken.length).toBeGreaterThan(ok.label.length);

    expect(
      runStatusPresentation(
        { status: "failed", startedAt: null, finishedAt: null },
        start,
      ),
    ).toMatchObject({ label: "Failed", tone: "danger" });
  });

  it("shows a fresh run as running", () => {
    expect(
      runStatusPresentation(
        {
          status: "running",
          startedAt: "2026-07-20T09:00:00Z",
          finishedAt: null,
        },
        start + 30_000,
      ),
    ).toMatchObject({ label: "Running", tone: "neutral" });
  });

  it("stops claiming progress once the server's own execution bound has passed", () => {
    // ExecuteTimeout is three minutes (runner.go:33) and nothing sweeps a row
    // whose terminal write never landed. Past the bound the honest answer is
    // "outcome unknown", not a spinner that will never stop.
    const stalled = runStatusPresentation(
      { status: "running", startedAt: "2026-07-20T09:00:00Z", finishedAt: null },
      start + RUN_STALL_MS + 1,
    );
    expect(stalled).toMatchObject({ label: "Outcome unknown", tone: "warning" });
    expect(stalled.spoken).toContain("three minutes");
  });

  it("shows an unrecognised status verbatim and never as a success", () => {
    const odd = runStatusPresentation(
      { status: "cancelled", startedAt: null, finishedAt: null },
      start,
    );
    expect(odd.label).toBe("cancelled");
    expect(odd.tone).not.toBe("success");
  });

  it("polls only while a run is genuinely live", () => {
    const live: AgentRoutineRun[] = [
      parseRun(wireRun({ status: "running", finished_at: null }))!,
    ];
    expect(hasLiveRun(live, start + 10_000)).toBe(true);
    // Past the stall bound there is nothing left to wait for, so the poll must
    // stop rather than burn a request every five seconds forever.
    expect(hasLiveRun(live, start + RUN_STALL_MS + 1)).toBe(false);
    expect(hasLiveRun([parseRun(wireRun())!], start)).toBe(false);
    expect(hasLiveRun([], start)).toBe(false);
  });
});

describe("agentRoutines — durations and ordering", () => {
  const start = Date.parse("2026-07-20T09:00:00Z");

  it("measures a finished run from its own timestamps", () => {
    expect(runDurationMs(parseRun(wireRun())!, start + 999_999)).toBe(42_000);
  });

  it("measures a live run against now", () => {
    const run = parseRun(wireRun({ status: "running", finished_at: null }))!;
    expect(runDurationMs(run, start + 5_000)).toBe(5_000);
  });

  it("returns null — not zero — when there is no measurement to make", () => {
    expect(
      runDurationMs({ startedAt: null, finishedAt: null }, start),
    ).toBeNull();
    // Clock skew must not produce a negative duration on screen.
    expect(
      runDurationMs(
        {
          startedAt: "2026-07-20T09:00:00Z",
          finishedAt: "2026-07-20T08:59:00Z",
        },
        start,
      ),
    ).toBeNull();
  });

  it("finds the newest run by timestamp rather than trusting array order", () => {
    const runs = [
      parseRun(wireRun({ id: "old", started_at: "2026-07-01T09:00:00Z" }))!,
      parseRun(wireRun({ id: "new", started_at: "2026-07-20T09:00:00Z" }))!,
    ];
    expect(latestRun(runs)?.id).toBe("new");
    expect(latestRun([...runs].reverse())?.id).toBe("new");
    expect(latestRun([])).toBeNull();
    expect(
      latestRun([parseRun(wireRun({ started_at: null }))!]),
    ).toBeNull();
  });
});

describe("agentRoutines — labels", () => {
  it("says what a routine produces without guessing", () => {
    expect(routineKindLabel("draft_campaign")).toBe("Drafts a campaign");
    expect(routineKindLabel("draft_sequence")).toBe("Drafts a sequence");
    expect(routineKindLabel("draft_postcard")).toBe("draft_postcard");
    expect(routineKindLabel("  ")).toBe("Unknown output");
  });

  it("names each schedule the server accepts", () => {
    expect(scheduleLabel("daily")).toBe("Daily");
    expect(scheduleLabel("WEEKLY")).toBe("Weekly");
    expect(scheduleLabel("monthly")).toBe("Monthly");
    expect(scheduleLabel("manual")).toBe("Manual only");
    expect(scheduleLabel("hourly")).toBe("hourly");
  });
});

describe("agentRoutines — the filter partitions the set exactly", () => {
  const scheduled = parseRoutine(wireRoutine({ id: "s" }))!;
  const manual = parseRoutine(wireRoutine({ id: "m", schedule: "manual" }))!;
  const pausedScheduled = parseRoutine(
    wireRoutine({ id: "p1", enabled: false }),
  )!;
  const pausedManual = parseRoutine(
    wireRoutine({ id: "p2", enabled: false, schedule: "manual" }),
  )!;
  const every = [scheduled, manual, pausedScheduled, pausedManual];

  it("puts every routine in exactly one non-'all' bucket", () => {
    for (const routine of every) {
      const hits = (["scheduled", "manual", "paused"] as const).filter((f) =>
        matchesRoutineFilter(routine, f),
      );
      expect(hits).toHaveLength(1);
    }
  });

  it("mirrors the scheduler's own predicate: paused wins over schedule", () => {
    // `FindDue` is `WHERE enabled AND schedule <> 'manual'`, so a disabled
    // weekly routine is not "scheduled" in any sense the platform honours.
    expect(matchesRoutineFilter(pausedScheduled, "paused")).toBe(true);
    expect(matchesRoutineFilter(pausedScheduled, "scheduled")).toBe(false);
    expect(matchesRoutineFilter(pausedManual, "paused")).toBe(true);
    expect(matchesRoutineFilter(manual, "manual")).toBe(true);
    expect(matchesRoutineFilter(scheduled, "scheduled")).toBe(true);
  });

  it("counts the buckets so the segments carry real badges", () => {
    expect(routineFilterCounts(every)).toEqual({
      all: 4,
      scheduled: 1,
      manual: 1,
      paused: 2,
    });
    expect(routineFilterCounts([])).toEqual({
      all: 0,
      scheduled: 0,
      manual: 0,
      paused: 0,
    });
  });

  it("searches the two fields a person can recall", () => {
    expect(matchesRoutineQuery(scheduled, "monday")).toBe(true);
    expect(matchesRoutineQuery(scheduled, "  LAPSED ")).toBe(true);
    expect(matchesRoutineQuery(scheduled, "black friday")).toBe(false);
    expect(matchesRoutineQuery(scheduled, "   ")).toBe(true);
  });
});

