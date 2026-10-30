/**
 * Pure-logic tests for the Analytics "Scheduled reports" section (#31).
 * Node environment — no DOM, no React.
 */

import { describe, expect, it } from "vitest";

import type { ScheduledReport } from "../lib/api-client";
import {
  DEFAULT_SCHEDULE,
  composeSchedule,
  draftErrors,
  draftFromReport,
  draftToCreateInput,
  draftToPatchInput,
  humanizeSchedule,
  invalidRecipients,
  parseRecipients,
  parseSchedule,
  sendNowMessage,
  templateLabel,
} from "../pages/analytics-scheduled-reports";

function report(partial: Partial<ScheduledReport> = {}): ScheduledReport {
  return {
    id: "rep_1",
    name: "Weekly digest",
    enabled: true,
    template: "engagement_summary",
    schedule: "weekly:mon@09:00",
    timezone: "UTC",
    recipients: ["a@example.com", "b@example.com"],
    latest_run_accepted_count: 0,
    latest_run_failed_count: 0,
    latest_run_unknown_count: 0,
    latest_run_recipient_count: 0,
    created_at: "2026-06-01T00:00:00Z",
    ...partial,
  };
}

describe("parseSchedule / composeSchedule", () => {
  it("round-trips the weekly wire shape", () => {
    const p = parseSchedule("weekly:mon@09:00");
    expect(p).toEqual({ kind: "weekly", dow: "mon", dom: "1", time: "09:00" });
    expect(composeSchedule(p!)).toBe("weekly:mon@09:00");
  });

  it("round-trips the monthly wire shape", () => {
    const p = parseSchedule("monthly:14@18:30");
    expect(p?.kind).toBe("monthly");
    expect(p?.dom).toBe("14");
    expect(composeSchedule(p!)).toBe("monthly:14@18:30");
  });

  it("pads single-digit hours so the round-trip is stable", () => {
    expect(parseSchedule("weekly:fri@9:05")?.time).toBe("09:05");
  });

  it("rejects shapes the server rejects", () => {
    expect(parseSchedule("daily@09:00")).toBeNull(); // no kind:rest split
    expect(parseSchedule("monthly:29@09:00")).toBeNull(); // dom must be 1..28
    expect(parseSchedule("weekly:funday@09:00")).toBeNull();
    expect(parseSchedule("weekly:mon@25:00")).toBeNull();
    expect(parseSchedule("")).toBeNull();
    expect(parseSchedule(undefined)).toBeNull();
  });
});

describe("humanizeSchedule", () => {
  it("renders parsed schedules", () => {
    expect(humanizeSchedule("weekly:mon@09:00")).toBe(
      "Weekly on Monday at 09:00",
    );
    expect(humanizeSchedule("monthly:1@07:15")).toBe(
      "Monthly on day 1 at 07:15",
    );
  });

  it("echoes unknown shapes verbatim instead of guessing", () => {
    expect(humanizeSchedule("cron:*/5")).toBe("cron:*/5");
    expect(humanizeSchedule(undefined)).toBe("—");
  });
});

describe("parseRecipients / invalidRecipients", () => {
  it("splits on commas, semicolons, whitespace and newlines", () => {
    expect(parseRecipients("a@x.com, b@x.com;c@x.com\nd@x.com")).toEqual([
      "a@x.com",
      "b@x.com",
      "c@x.com",
      "d@x.com",
    ]);
  });

  it("dedupes case-insensitively, first spelling wins", () => {
    expect(parseRecipients("A@x.com a@X.COM b@x.com")).toEqual([
      "A@x.com",
      "b@x.com",
    ]);
  });

  it("flags non-email entries", () => {
    expect(invalidRecipients(["ok@x.com", "nope", "also@bad"])).toEqual([
      "nope",
      "also@bad",
    ]);
  });
});

describe("draft round-trip + validation", () => {
  it("hydrates a draft from an existing report", () => {
    const d = draftFromReport(report());
    expect(d.name).toBe("Weekly digest");
    expect(d.schedule.kind).toBe("weekly");
    expect(d.rawSchedule).toBeNull();
    expect(d.recipientsText).toBe("a@example.com\nb@example.com");
    expect(d.enabled).toBe(true);
  });

  it("falls back to raw-schedule mode for shapes the editor can't round-trip", () => {
    const d = draftFromReport(report({ schedule: "cron:*/5" }));
    expect(d.rawSchedule).toBe("cron:*/5");
    const e = draftErrors(d);
    expect(e.schedule).toContain("weekly:mon@09:00");
  });

  it("defaults for a blank create draft", () => {
    const d = draftFromReport(null);
    expect(d.template).toBe("engagement_summary");
    expect(d.schedule).toEqual(DEFAULT_SCHEDULE);
    expect(draftErrors(d).name).toBeTruthy();
    expect(draftErrors(d).recipients).toBeTruthy();
  });

  it("builds the create input on the exact wire shape", () => {
    const d = draftFromReport(null);
    d.name = " Growth report ";
    d.template = "growth";
    d.schedule = { kind: "monthly", dow: "mon", dom: "7", time: "08:00" };
    d.timezone = "Asia/Kolkata";
    d.recipientsText = "ceo@x.com, ceo@x.com\nops@x.com";
    expect(draftErrors(d)).toEqual({});
    expect(draftToCreateInput(d)).toEqual({
      name: "Growth report",
      template: "growth",
      schedule: "monthly:7@08:00",
      timezone: "Asia/Kolkata",
      recipients: ["ceo@x.com", "ops@x.com"],
    });
  });

  it("builds the patch input including the enabled flag", () => {
    const d = draftFromReport(report({ enabled: false }));
    expect(draftToPatchInput(d)).toEqual({
      name: "Weekly digest",
      schedule: "weekly:mon@09:00",
      timezone: "UTC",
      recipients: ["a@example.com", "b@example.com"],
      enabled: false,
    });
  });
});

describe("display helpers", () => {
  it("labels known templates and echoes unknown ones", () => {
    expect(templateLabel("deliverability")).toBe("Deliverability");
    expect(templateLabel("mystery")).toBe("mystery");
  });

  it("send-now toast is honest about queueing", () => {
    const msg = sendNowMessage(report(), {
      queued: true,
      run_id: "11111111-1111-4111-8111-111111111111",
      scheduled_report_id: "22222222-2222-4222-8222-222222222222",
      run_kind: "manual",
      status: "queued",
      occurrence_at: "2026-06-02T00:00:00Z",
      created_at: "2026-06-02T00:00:00Z",
    });
    expect(msg).toContain("11111111");
    expect(msg).toContain("queued");
    expect(msg).toContain("2 recipients");
    expect(msg).not.toMatch(/sent\b/i);
  });
});
