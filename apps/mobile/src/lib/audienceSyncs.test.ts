import { describe, expect, it } from "vitest";

import {
  count,
  destinationTypeLabel,
  hasLiveRun,
  parseRunNowResult,
  parseSync,
  parseSyncList,
  parseSyncRun,
  parseSyncRunList,
  runDurationMs,
  runStatusPresentation,
  scheduleLabel,
  sourceLabel,
  SYNC_RUN_LIST_CAP,
  SYNC_RUN_STALL_MS,
  timestamp,
  triggerLabel,
  type AudienceSyncRun,
} from "./audienceSyncs";

const NOW = Date.parse("2026-07-25T12:00:00Z");

function run(overrides: Record<string, unknown> = {}): AudienceSyncRun {
  return parseSyncRun({
    id: "run-1",
    sync_id: "sync-1",
    status: "succeeded",
    rows_exported: 1200,
    batches_sent: 3,
    source_members_observed: 1300,
    excluded_count: 100,
    cap_exceeded: false,
    started_at: "2026-07-25T11:59:00Z",
    finished_at: "2026-07-25T11:59:42Z",
    trigger_kind: "scheduled",
    ...overrides,
  })!;
}

describe("parsing the sync list", () => {
  it("reads the envelope the handler actually writes", () => {
    // sync_handlers.go:78 — `{"items":[…]}`.
    const rows = parseSyncList({
      items: [
        {
          id: "s-1",
          name: "Warehouse mirror",
          source: { list_id: "l-1" },
          destination: {
            type: "webhook",
            url: "https://in.example.test/hook",
            secret_set: true,
            secret_hint: "••••beef",
          },
          schedule: "daily",
          enabled: true,
          last_run_at: "2026-07-25T03:00:00Z",
          last_run_status: "failed",
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Warehouse mirror");
    expect(rows[0]?.listId).toBe("l-1");
    expect(rows[0]?.segmentId).toBeNull();
    expect(rows[0]?.lastRunStatus).toBe("failed");
    expect(rows[0]?.destination.secretSet).toBe(true);
  });

  it("accepts a bare array, because envelope drift silently empties screens", () => {
    expect(parseSyncList([{ id: "s-1" }])).toHaveLength(1);
  });

  it("renders a failed fetch shape as an empty list rather than throwing", () => {
    expect(parseSyncList(null)).toEqual([]);
    expect(parseSyncList({ data: "nope" })).toEqual([]);
  });

  it("drops rows with no id rather than rendering a keyless ghost", () => {
    expect(parseSyncList({ items: [{ name: "no id" }] })).toEqual([]);
  });

  it("never reads an absent `enabled` as 'the scheduler is running this'", () => {
    // Claiming a sync is enabled when the field is missing would tell an
    // operator their destination is being kept up to date when it is not.
    expect(parseSync({ id: "s-1" })?.enabled).toBe(false);
  });

  it("never reads an absent `secret_set` as 'these batches are signed'", () => {
    expect(parseSync({ id: "s-1" })?.destination.secretSet).toBe(false);
  });

  it("does not render Go's zero time as a date from year one", () => {
    expect(timestamp("0001-01-01T00:00:00Z")).toBeNull();
    expect(parseSync({ id: "s-1", last_run_at: "0001-01-01T00:00:00Z" })?.lastRunAt).toBeNull();
  });
});

describe("parsing a run", () => {
  it("keeps the three member counts distinct", () => {
    const parsed = run();
    expect(parsed.sourceMembersObserved).toBe(1300);
    expect(parsed.excludedCount).toBe(100);
    expect(parsed.rowsExported).toBe(1200);
  });

  it("treats an ABSENT count as absent, never as zero", () => {
    // "0 delivered" is a serious claim about a sync; a missing field is not it.
    const parsed = parseSyncRun({ id: "r", status: "succeeded" })!;
    expect(parsed.rowsExported).toBeNull();
    expect(parsed.excludedCount).toBeNull();
    expect(parsed.sourceMembersObserved).toBeNull();
    expect(count(undefined)).toBeNull();
    expect(count(0)).toBe(0);
  });

  it("leaves an unrecognised status verbatim rather than defaulting to success", () => {
    expect(parseSyncRun({ id: "r", status: "weird" })?.status).toBe("weird");
    expect(parseSyncRun({ id: "r" })?.status).toBe("");
  });

  it("reads the run-now response, which is a run row and not an ack", () => {
    // sync_handlers.go:192 writes the closed SyncRun itself.
    expect(parseRunNowResult({ id: "r-9", status: "failed" })?.status).toBe("failed");
    expect(parseRunNowResult({})).toBeNull();
  });

  it("reads the runs envelope", () => {
    expect(parseSyncRunList({ items: [{ id: "a" }, { id: "b" }] })).toHaveLength(2);
  });
});

describe("how one run reads", () => {
  it("distinguishes all four failure shades instead of flattening them", () => {
    expect(runStatusPresentation(run({ status: "failed" }), NOW).label).toBe("Failed");
    expect(runStatusPresentation(run({ status: "partial" }), NOW).label).toBe("Partial");
    expect(runStatusPresentation(run({ status: "rejected" }), NOW).label).toBe("Rejected");
    expect(
      runStatusPresentation(run({ status: "needs_reconciliation" }), NOW).label,
    ).toBe("Needs reconciliation");
  });

  it("says a partial run left the two sides disagreeing", () => {
    // The dangerous one: rows DID leave, so "failed" alone would understate it.
    expect(runStatusPresentation(run({ status: "partial" }), NOW).spoken).toMatch(
      /part of the audience/,
    );
  });

  it("never states a status by colour alone", () => {
    for (const status of ["succeeded", "failed", "partial", "rejected", "needs_reconciliation", "running"]) {
      const presented = runStatusPresentation(run({ status }), NOW);
      expect(presented.label.length).toBeGreaterThan(0);
      expect(presented.spoken.length).toBeGreaterThan(presented.label.length);
    }
  });

  it("calls a fresh running run running", () => {
    const live = run({ status: "running", finished_at: null, started_at: new Date(NOW - 10_000).toISOString() });
    expect(runStatusPresentation(live, NOW).label).toBe("Running");
    expect(hasLiveRun([live], NOW)).toBe(true);
  });

  it("stops claiming a stalled run is in progress", () => {
    // Nothing sweeps a `running` row: the lease-expiry rewrite only fires when
    // a LATER operation reuses the key. Past the bound, a spinner would never
    // stop and would be a lie.
    const stalled = run({
      status: "running",
      finished_at: null,
      started_at: new Date(NOW - SYNC_RUN_STALL_MS - 1000).toISOString(),
    });
    expect(runStatusPresentation(stalled, NOW).label).toBe("Outcome unknown");
    expect(hasLiveRun([stalled], NOW)).toBe(false);
  });

  it("reports an unknown status verbatim rather than guessing", () => {
    expect(runStatusPresentation(run({ status: "banana" }), NOW).label).toBe("banana");
    expect(runStatusPresentation(run({ status: "" }), NOW).label).toBe("Unknown");
  });
});

describe("derived measurements", () => {
  it("measures a finished run between its own stamps", () => {
    expect(runDurationMs(run(), NOW)).toBe(42_000);
  });

  it("measures a live run against now", () => {
    const live = run({ started_at: new Date(NOW - 5_000).toISOString(), finished_at: null });
    expect(runDurationMs(live, NOW)).toBe(5_000);
  });

  it("returns null — not zero — when there is no start to measure from", () => {
    expect(runDurationMs(run({ started_at: null }), NOW)).toBeNull();
  });

  it("measures a run whose stamps run backwards as unmeasurable, not negative", () => {
    const backwards = run({
      started_at: "2026-07-25T12:00:00Z",
      finished_at: "2026-07-25T11:00:00Z",
    });
    expect(runDurationMs(backwards, NOW)).toBeNull();
  });
});

describe("labels", () => {
  it("names every destination type the CHECK constraint allows", () => {
    expect(destinationTypeLabel("webhook")).toBe("Webhook");
    expect(destinationTypeLabel("google_ads")).toBe("Google Ads");
    expect(destinationTypeLabel("tiktok")).toBe("TikTok");
    expect(destinationTypeLabel("snap")).toBe("Snapchat");
  });

  it("shows an unrecognised type verbatim so it can be reported", () => {
    expect(destinationTypeLabel("pigeon")).toBe("pigeon");
    expect(destinationTypeLabel("  ")).toBe("Unknown destination");
  });

  it("names the three schedules and nothing else", () => {
    expect(scheduleLabel("hourly")).toBe("Hourly");
    expect(scheduleLabel("daily")).toBe("Daily");
    expect(scheduleLabel("manual")).toBe("Manual only");
    expect(scheduleLabel("weekly")).toBe("weekly");
  });

  it("reads the XOR source without ever claiming both", () => {
    expect(sourceLabel({ listId: "l", segmentId: null })).toBe("List");
    expect(sourceLabel({ listId: null, segmentId: "s" })).toBe("Segment");
    expect(sourceLabel({ listId: null, segmentId: null })).toBe("Unknown source");
  });

  it("distinguishes a scheduled run from a hand-started one", () => {
    expect(triggerLabel("scheduled")).toBe("On schedule");
    expect(triggerLabel("manual")).toBe("By hand");
  });

  it("pins the server's run-history cap", () => {
    // sync_handlers.go:209 passes a literal 25. If the server ever raises it,
    // this fails and the "no further pages" copy gets revisited.
    expect(SYNC_RUN_LIST_CAP).toBe(25);
  });
});
