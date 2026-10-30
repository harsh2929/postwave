/**
 * control-groups-helpers — pure logic behind ControlGroupsCard (#13).
 *
 * High-stakes invariants:
 *   1. Percent bounds mirror apps/api/internal/control_group's
 *      Repo.Create exactly (0..50 inclusive) so the 400 backstop
 *      almost never fires.
 *   2. The status set matches the control_groups.status CHECK
 *      (active|paused|dissolved) — sending anything else is a
 *      guaranteed validation error.
 *   3. incremental_lift is treated − control engagement (both
 *      fractions), so the UI renders percentage POINTS — rendering a
 *      relative % would overstate small lifts dramatically.
 *   4. Reports with an empty cohort must be flagged un-meaningful so
 *      the card shows an honest "not enough data" message, never fake
 *      0% engagement numbers.
 */

import { describe, expect, it } from "vitest";

import type { ControlGroupReport } from "../../lib/api-client";
import {
  hasPublishableLift,
  CONTROL_GROUP_STATUSES,
  DEFAULT_REPORT_WINDOW,
  REPORT_WINDOW_OPTIONS,
  fmtEngagementRate,
  liftSummary,
  parsePercent,
  reportHasCohorts,
  statusBadgeClass,
  validateControlGroupDraft,
} from "../../components/experiments/control-groups-helpers";

function report(over: Partial<ControlGroupReport> = {}): ControlGroupReport {
  return {
    group_id: "g1",
    window_days: 30,
    // These fixtures describe a report the server WAS able to publish, i.e.
    // one where control members were genuinely excluded from the send. The
    // server omits the three comparison fields entirely when that is not
    // true — see the "unenforced control groups" block below.
    enforced: true,
    control_size: 100,
    treated_size: 1900,
    control_engagement_rate: 0.2,
    treated_engagement_rate: 0.25,
    incremental_lift: 0.05,
    generated_at: "2026-06-11T00:00:00Z",
    ...over,
  };
}

describe("parsePercent", () => {
  it("parses plain and decimal numbers", () => {
    expect(parsePercent("5")).toBe(5);
    expect(parsePercent(" 12.5 ")).toBe(12.5);
    expect(parsePercent("0")).toBe(0);
  });

  it("rejects empty, partial-numeric, and non-finite input", () => {
    expect(parsePercent("")).toBeNull();
    expect(parsePercent("   ")).toBeNull();
    expect(parsePercent("10%")).toBeNull();
    expect(parsePercent("five")).toBeNull();
    expect(parsePercent("Infinity")).toBeNull();
  });
});

describe("validateControlGroupDraft", () => {
  it("accepts a valid draft and returns the parsed percent", () => {
    const v = validateControlGroupDraft({
      name: "Global holdback",
      description: "",
      percent: "5",
    });
    expect(v.ok).toBe(true);
    expect(v.percent).toBe(5);
    expect(v.errors).toEqual({});
  });

  it("requires a name", () => {
    const v = validateControlGroupDraft({
      name: "   ",
      description: "",
      percent: "5",
    });
    expect(v.ok).toBe(false);
    expect(v.errors.name).toBeTruthy();
  });

  it("mirrors the server's 0..50 percent bounds (inclusive)", () => {
    for (const pct of ["0", "50", "12.5"]) {
      expect(
        validateControlGroupDraft({ name: "x", description: "", percent: pct })
          .ok,
      ).toBe(true);
    }
    for (const pct of ["-1", "50.1", "100"]) {
      const v = validateControlGroupDraft({
        name: "x",
        description: "",
        percent: pct,
      });
      expect(v.ok).toBe(false);
      expect(v.errors.percent).toContain("between 0 and 50");
    }
  });

  it("flags unparseable percent input", () => {
    const v = validateControlGroupDraft({
      name: "x",
      description: "",
      percent: "lots",
    });
    expect(v.ok).toBe(false);
    expect(v.errors.percent).toBeTruthy();
  });

  it("reports both errors at once", () => {
    const v = validateControlGroupDraft({
      name: "",
      description: "",
      percent: "99",
    });
    expect(v.errors.name).toBeTruthy();
    expect(v.errors.percent).toBeTruthy();
  });
});

describe("statuses + windows", () => {
  it("matches the control_groups.status CHECK set exactly", () => {
    expect([...CONTROL_GROUP_STATUSES]).toEqual([
      "active",
      "paused",
      "dissolved",
    ]);
  });

  it("offers windows within the server's 1..365 clamp, defaulting 30", () => {
    expect(DEFAULT_REPORT_WINDOW).toBe(30);
    for (const w of REPORT_WINDOW_OPTIONS) {
      expect(w).toBeGreaterThan(0);
      expect(w).toBeLessThanOrEqual(365);
    }
  });

  it("maps statuses onto badge tones", () => {
    expect(statusBadgeClass("active")).toBe("badge accent");
    expect(statusBadgeClass("paused")).toBe("badge warning");
    expect(statusBadgeClass("dissolved")).toBe("badge");
    expect(statusBadgeClass("???")).toBe("badge");
  });
});

describe("fmtEngagementRate", () => {
  it("renders fractions as one-decimal percentages", () => {
    expect(fmtEngagementRate(0.123)).toBe("12.3%");
    expect(fmtEngagementRate(0)).toBe("0.0%");
    expect(fmtEngagementRate(1)).toBe("100.0%");
  });

  it("dashes out missing / non-finite values", () => {
    expect(fmtEngagementRate(null)).toBe("—");
    expect(fmtEngagementRate(undefined)).toBe("—");
    expect(fmtEngagementRate(Number.NaN)).toBe("—");
  });
});

describe("reportHasCohorts", () => {
  it("is true only when both cohorts have members", () => {
    expect(reportHasCohorts(report())).toBe(true);
    expect(reportHasCohorts(report({ control_size: 0 }))).toBe(false);
    expect(reportHasCohorts(report({ treated_size: 0 }))).toBe(false);
    expect(
      reportHasCohorts(report({ control_size: 0, treated_size: 0 })),
    ).toBe(false);
  });
});

describe("liftSummary", () => {
  it("renders incremental_lift as signed percentage points", () => {
    expect(liftSummary(report({ incremental_lift: 0.05 }))).toEqual({
      text: "+5.0 pts",
      tone: "good",
    });
    expect(liftSummary(report({ incremental_lift: -0.023 }))).toEqual({
      text: "-2.3 pts",
      tone: "bad",
    });
  });

  it("treats zero lift as neutral", () => {
    expect(liftSummary(report({ incremental_lift: 0 }))).toEqual({
      text: "0.0 pts",
      tone: "neutral",
    });
  });
});

// The server now withholds engagement rates and incremental_lift whenever
// control-group membership is not actually excluded at send time (`enforced:
// false`) — because until then the "control" cohort received the campaign
// too, and any lift is noise. The card must render that absence as an
// explanation, never as a number. Before this, `report.incremental_lift * 100`
// on an absent field produced NaN.
describe("unenforced control groups", () => {
  const unenforced = {
    group_id: "g1",
    window_days: 30,
    enforced: false,
    warning: "Incremental lift is unavailable: control-group membership is not yet excluded at send time.",
    control_size: 100,
    treated_size: 900,
    generated_at: "2026-07-13T00:00:00Z",
  } as ControlGroupReport;

  it("reports no publishable lift", () => {
    expect(hasPublishableLift(unenforced)).toBe(false);
  });

  it("renders an em dash rather than NaN", () => {
    expect(liftSummary(unenforced).text).toBe("—");
    expect(liftSummary(unenforced).tone).toBe("neutral");
  });

  it("still treats an enforced report as publishable", () => {
    const enforced = {
      ...unenforced,
      enforced: true,
      warning: undefined,
      control_engagement_rate: 0.1,
      treated_engagement_rate: 0.2,
      incremental_lift: 0.1,
    } as ControlGroupReport;
    expect(hasPublishableLift(enforced)).toBe(true);
    expect(liftSummary(enforced).text).toBe("+10.0 pts");
  });
});
