import { describe, expect, it } from "vitest";

import {
  parseScheduledReports,
  pauseConfirmCopy,
  recipientsSummary,
  reportHealth,
  reportStatusLine,
  scheduleLabel,
  scheduledReportSpoken,
  sendNowConfirmCopy,
  sortScheduledReports,
  type ScheduledReportRow,
} from "./scheduledReports";

const NOW = Date.parse("2026-07-26T12:00:00Z");

function row(over: Partial<ScheduledReportRow> = {}): ScheduledReportRow {
  return {
    id: "r1",
    name: "Weekly exec digest",
    enabled: true,
    template: "campaign_summary",
    schedule: "weekly:mon@09:00",
    timezone: "America/New_York",
    recipients: ["ops@acme.com", "cfo@acme.com"],
    lastRunAt: "2026-07-20T13:00:00Z",
    lastRunError: "",
    latestRunId: "run-1",
    latestRunStatus: "completed",
    acceptedCount: 2,
    failedCount: 0,
    recipientCount: 2,
    nextDueAt: "2026-07-27T13:00:00Z",
    ...over,
  };
}

describe("parseScheduledReports", () => {
  it("reads the server's { reports: [...] } envelope", () => {
    const parsed = parseScheduledReports({
      reports: [
        {
          id: "abc",
          name: "Digest",
          enabled: true,
          template: "t",
          schedule: "weekly:fri@08:30",
          timezone: "UTC",
          recipients: ["a@b.com"],
          latest_run_id: "run-9",
          latest_run_status: "completed",
          latest_run_accepted_count: 4,
          latest_run_failed_count: 1,
          latest_run_recipient_count: 5,
          next_due_at: "2026-07-31T08:30:00Z",
        },
      ],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.acceptedCount).toBe(4);
    expect(parsed[0]?.failedCount).toBe(1);
  });

  it("ABSENCE IS NOT ZERO — a never-run report has null counters", () => {
    // The list SQL COALESCEs the counters to 0, so a report that has never
    // run is indistinguishable from one that delivered to nobody unless
    // latest_run_id is used as the discriminator.
    const parsed = parseScheduledReports({
      reports: [
        {
          id: "abc",
          name: "New",
          enabled: true,
          schedule: "weekly:mon@09:00",
          latest_run_accepted_count: 0,
          latest_run_failed_count: 0,
          latest_run_recipient_count: 0,
        },
      ],
    });
    expect(parsed[0]?.latestRunId).toBeNull();
    expect(parsed[0]?.acceptedCount).toBeNull();
    expect(parsed[0]?.failedCount).toBeNull();
  });

  it("drops a row with no id — every action is addressed by it", () => {
    expect(
      parseScheduledReports({ reports: [{ name: "no id" }, { id: "ok" }] }),
    ).toHaveLength(1);
  });

  it("survives a wrong-shaped payload", () => {
    expect(parseScheduledReports(null)).toEqual([]);
    expect(parseScheduledReports({})).toEqual([]);
    expect(parseScheduledReports({ reports: "nope" })).toEqual([]);
    expect(parseScheduledReports({ reports: [1, "x", null] })).toEqual([]);
  });
});

describe("scheduleLabel", () => {
  it("renders the server's two grammars in words", () => {
    expect(scheduleLabel("weekly:mon@09:00", "UTC")).toBe(
      "Weekly on Monday at 09:00 UTC",
    );
    expect(scheduleLabel("monthly:15@23:30", "Europe/Berlin")).toBe(
      "Monthly on day 15 at 23:30 Europe/Berlin",
    );
  });

  it("returns an UNPARSEABLE schedule verbatim rather than guessing", () => {
    // A grammar added server-side after this shipped must not be rendered as
    // a confident mis-reading — this is the string an operator acts on.
    expect(scheduleLabel("daily@06:00", "UTC")).toBe("daily@06:00 UTC");
    expect(scheduleLabel("weekly:funday@09:00", "UTC")).toBe(
      "weekly:funday@09:00 UTC",
    );
    // day-of-month is capped at 28 server-side (Feb-29 edge case).
    expect(scheduleLabel("monthly:31@09:00", "UTC")).toBe(
      "monthly:31@09:00 UTC",
    );
  });

  it("renders an em-dash for no schedule at all", () => {
    expect(scheduleLabel("", "UTC")).toBe("—");
  });
});

describe("reportHealth", () => {
  it("failing beats paused — a pause is not a fix", () => {
    const r = row({ enabled: false, lastRunError: "SMTP 550" });
    expect(reportHealth(r, NOW)).toBe("failing");
  });

  it("counts a failed delivery as failing even with no error string", () => {
    expect(reportHealth(row({ failedCount: 1 }), NOW)).toBe("failing");
    expect(reportHealth(row({ latestRunStatus: "failed" }), NOW)).toBe(
      "failing",
    );
  });

  it("is due once next_due_at is in the past", () => {
    expect(
      reportHealth(row({ nextDueAt: "2026-07-26T11:59:00Z" }), NOW),
    ).toBe("due");
    expect(reportHealth(row(), NOW)).toBe("scheduled");
  });

  it("an unparseable next_due_at is scheduled, not due", () => {
    expect(reportHealth(row({ nextDueAt: "soon" }), NOW)).toBe("scheduled");
  });
});

describe("reportStatusLine", () => {
  it("says the error when there is one", () => {
    expect(reportStatusLine(row({ lastRunError: "SMTP 550" }), NOW)).toBe(
      "SMTP 550",
    );
  });

  it("never claims a delivery count for a report that has not run", () => {
    expect(
      reportStatusLine(
        row({ latestRunId: null, acceptedCount: null, failedCount: null }),
        NOW,
      ),
    ).toBe("Has not run yet.");
  });

  it("reports a clean run and a partial one differently", () => {
    expect(reportStatusLine(row(), NOW)).toBe("Last run: 2 recipients.");
    expect(
      reportStatusLine(row({ acceptedCount: 1, failedCount: 0 }), NOW),
    ).toBe("Last run: 1 recipient.");
  });
});

describe("sortScheduledReports", () => {
  it("puts broken first, soonest next, paused last", () => {
    const rows = [
      row({ id: "paused", enabled: false, nextDueAt: null }),
      row({ id: "later", nextDueAt: "2026-08-01T00:00:00Z" }),
      row({ id: "broken", lastRunError: "boom" }),
      row({ id: "soon", nextDueAt: "2026-07-26T18:00:00Z" }),
    ];
    expect(sortScheduledReports(rows, NOW).map((r) => r.id)).toEqual([
      "broken",
      "soon",
      "later",
      "paused",
    ]);
  });

  it("does not mutate its input", () => {
    const rows = [row({ id: "a" }), row({ id: "b", lastRunError: "x" })];
    sortScheduledReports(rows, NOW);
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("confirm copy", () => {
  it("states the consequence in terms of recipients, not a boolean", () => {
    const copy = pauseConfirmCopy(row());
    expect(copy.confirmLabel).toBe("Pause");
    expect(copy.destructive).toBe(true);
    expect(copy.consequence).toContain("2 recipients");
    expect(copy.consequence).not.toContain("enabled");
  });

  it("resuming is not destructive", () => {
    const copy = pauseConfirmCopy(row({ enabled: false }));
    expect(copy.confirmLabel).toBe("Resume");
    expect(copy.destructive).toBe(false);
  });

  it("send-now says it does not skip the next scheduled run", () => {
    const copy = sendNowConfirmCopy(row());
    expect(copy.message).toContain("does not change the schedule");
    expect(copy.consequence).toContain("receive a real email");
  });
});

describe("recipientsSummary", () => {
  it("names a lone recipient and counts several", () => {
    expect(recipientsSummary(row({ recipients: ["a@b.com"] }))).toBe(
      "a@b.com",
    );
    expect(recipientsSummary(row())).toBe("2 recipients");
    expect(recipientsSummary(row({ recipients: [] }))).toBe("No recipients");
  });
});

describe("scheduledReportSpoken", () => {
  it("carries the state, the schedule and the outcome in one sentence", () => {
    const spoken = scheduledReportSpoken(row(), NOW, "in 1 day");
    expect(spoken).toContain("Weekly exec digest");
    expect(spoken).toContain("Weekly on Monday at 09:00 America/New_York");
    expect(spoken).toContain("Next run in 1 day");
    expect(spoken).toContain("Last run: 2 recipients.");
  });

  it("omits a next run for a paused report rather than inventing one", () => {
    const spoken = scheduledReportSpoken(
      row({ enabled: false }),
      NOW,
      "in 1 day",
    );
    expect(spoken).toContain("paused");
    expect(spoken).not.toContain("Next run");
  });
});
