import { describe, expect, it } from "vitest";

import {
  bounceClassTone,
  diagnosticNotice,
  ispLabel,
  ispVerdict,
  ISP_VERDICT_MIN_VOLUME,
  parseBounceClasses,
  parseIspBreakdown,
  parseWarmupPlans,
  parseWarmupToday,
  warmupMeter,
  type IspBucket,
} from "./deliverabilityDiagnostics";

function bucket(over: Partial<IspBucket> & { isp: string }): IspBucket {
  return {
    label: over.label ?? over.isp,
    subscribers: 1000,
    opens: 0,
    clicks: 0,
    bounces: 0,
    complaints: 0,
    openRate: 0,
    bounceRate: 0,
    complaintRate: 0,
    ...over,
  };
}

describe("ispLabel", () => {
  it("renders the server's slugs as names a human says", () => {
    expect(ispLabel("gmail")).toBe("Gmail");
    // The CASE fallthrough is literally `b2b_other`; rendering it raw is the
    // difference between a diagnostic and a database dump.
    expect(ispLabel("b2b_other")).toBe("Business / other");
    expect(ispLabel("outlook")).toBe("Microsoft");
  });

  it("degrades an unknown slug instead of dropping the row", () => {
    expect(ispLabel("some_new_isp")).toBe("some new isp");
    expect(ispLabel("")).toBe("Unknown");
    expect(ispLabel(undefined)).toBe("Unknown");
  });
});

describe("parseIspBreakdown", () => {
  it("reads the documented envelope and sorts by volume", () => {
    const parsed = parseIspBreakdown({
      window_days: 7,
      buckets: [
        { isp: "yahoo", sent: 10, bounce_rate: 0.5 },
        { isp: "gmail", sent: 900, bounce_rate: 0.001, open_rate: 0.42 },
      ],
    });
    expect(parsed.windowDays).toBe(7);
    expect(parsed.buckets.map((b) => b.isp)).toEqual(["gmail", "yahoo"]);
    expect(parsed.buckets[0]?.openRate).toBe(0.42);
  });

  it("coerces numeric strings rather than concatenating them", () => {
    const parsed = parseIspBreakdown({
      buckets: [{ isp: "gmail", sent: "300", bounces: "12" }],
    });
    expect(parsed.buckets[0]?.subscribers).toBe(300);
    expect(parsed.buckets[0]?.bounces).toBe(12);
  });

  it("drops rows with no isp key instead of rendering a nameless bar", () => {
    const parsed = parseIspBreakdown({
      buckets: [{ sent: 10 }, { isp: "  ", sent: 4 }, { isp: "aol", sent: 2 }],
    });
    expect(parsed.buckets).toHaveLength(1);
  });

  it("throws on an unrecognisable envelope rather than showing zero", () => {
    expect(() => parseIspBreakdown("nope")).toThrow(/ISP breakdown/);
  });
});

describe("ispVerdict", () => {
  it("names the provider to look at, and contrasts it with a healthy one", () => {
    const verdict = ispVerdict([
      bucket({ isp: "gmail", label: "Gmail", bounceRate: 0.004 }),
      bucket({ isp: "outlook", label: "Microsoft", bounceRate: 0.071 }),
    ]);
    expect(verdict.worst?.isp).toBe("outlook");
    expect(verdict.tone).toBe("danger");
    expect(verdict.sentence).toContain("Microsoft is bouncing 7.1%");
    expect(verdict.sentence).toContain("Gmail is fine at 0.4%");
  });

  it("uses the same 2% / 5% boundaries as the hub score tile", () => {
    expect(ispVerdict([bucket({ isp: "gmail", bounceRate: 0.019 })]).tone).toBe(
      "success",
    );
    expect(ispVerdict([bucket({ isp: "gmail", bounceRate: 0.021 })]).tone).toBe(
      "warning",
    );
    expect(ispVerdict([bucket({ isp: "gmail", bounceRate: 0.051 })]).tone).toBe(
      "danger",
    );
  });

  it("refuses to open an investigation on a tiny bucket", () => {
    // 4 of 5 bounced is an 80% rate and means nothing.
    const verdict = ispVerdict([
      bucket({
        isp: "vanity",
        subscribers: ISP_VERDICT_MIN_VOLUME - 1,
        bounceRate: 0.8,
      }),
    ]);
    expect(verdict.worst).toBeNull();
    expect(verdict.sentence).toMatch(/Not enough volume/);
  });

  it("says nothing at all when there is no data", () => {
    expect(ispVerdict([])).toEqual({
      worst: null,
      tone: "neutral",
      sentence: "",
    });
  });
});

describe("parseBounceClasses", () => {
  it("keeps the server's share and ranks by count", () => {
    const parsed = parseBounceClasses({
      window_days: 30,
      total_bounces: 100,
      classes: [
        { class_code: "soft", label: "Soft bounce", count: 30, share: 0.3 },
        { class_code: "hard", label: "Hard bounce", count: 70, share: 0.7 },
      ],
    });
    expect(parsed.classes.map((c) => c.code)).toEqual(["hard", "soft"]);
    expect(parsed.classes[0]?.share).toBe(0.7);
    expect(parsed.totalBounces).toBe(100);
  });

  it("recomputes share when a legacy payload omits it", () => {
    // Without this every row renders 0% and the card claims nothing dominates.
    const parsed = parseBounceClasses({
      total_bounces: 4,
      classes: [{ class_code: "hard", count: 3 }],
    });
    expect(parsed.classes[0]?.share).toBeCloseTo(0.75, 5);
    expect(parsed.classes[0]?.label).toBe("Hard bounce");
  });

  it("survives an empty window without throwing", () => {
    const parsed = parseBounceClasses({ window_days: 7, total_bounces: 0 });
    expect(parsed.classes).toEqual([]);
    expect(parsed.windowDays).toBe(7);
  });
});

describe("bounceClassTone", () => {
  it("tones by what the operator must DO, not by magnitude", () => {
    expect(bounceClassTone("hard")).toBe("danger");
    expect(bounceClassTone("spam_trap")).toBe("danger");
    expect(bounceClassTone("soft")).toBe("warning");
    expect(bounceClassTone("unknown")).toBe("neutral");
  });
});

describe("warmup", () => {
  it("parses today's allowance", () => {
    const today = parseWarmupToday({
      domain: "mail.example.com",
      status: "active",
      day_index: 3,
      day_quota: 400,
      sent_today: 120,
      remaining: 280,
      at_target: false,
    });
    expect(today.dayQuota).toBe(400);
    expect(today.atTarget).toBe(false);
  });

  it("distinguishes 'no plan' from 'quota zero'", () => {
    expect(warmupMeter(null).fraction).toBeNull();
    expect(warmupMeter(null).caption).toMatch(/No warm-up plan/);
    const stalled = warmupMeter({
      domain: "d",
      status: "active",
      dayIndex: 0,
      dayQuota: 0,
      sentToday: 0,
      remaining: 0,
      atTarget: false,
    });
    expect(stalled.fraction).toBeNull();
    expect(stalled.caption).toMatch(/not ramping/);
  });

  it("never reports a spent allowance as danger — that is the plan working", () => {
    const spent = warmupMeter({
      domain: "d",
      status: "active",
      dayIndex: 2,
      dayQuota: 200,
      sentToday: 200,
      remaining: 0,
      atTarget: false,
    });
    expect(spent.fraction).toBe(1);
    expect(spent.tone).toBe("warning");
    expect(spent.caption).toMatch(/allowance used up/);
    expect(spent.dayLabel).toBe("Day 3");
  });

  it("labels a graduated plan as at-target rather than as day N", () => {
    const done = warmupMeter({
      domain: "d",
      status: "completed",
      dayIndex: 20,
      dayQuota: 5000,
      sentToday: 100,
      remaining: 4900,
      atTarget: true,
    });
    expect(done.dayLabel).toBe("At full target volume");
    expect(done.tone).toBe("success");
  });

  it("parses either the {plans} envelope or a bare array", () => {
    const wrapped = parseWarmupPlans({
      plans: [{ id: "1", domain: "a.com", target_daily: 5000, days: 21 }],
    });
    const bare = parseWarmupPlans([
      { id: "1", domain: "a.com", target_daily: 5000, days: 21 },
    ]);
    expect(wrapped).toEqual(bare);
    expect(wrapped[0]?.status).toBe("active");
  });
});

describe("diagnosticNotice", () => {
  it("says nothing when the read worked", () => {
    expect(diagnosticNotice("The provider breakdown", false, false)).toBeNull();
  });

  it("never lets a failed read be mistaken for an empty result", () => {
    expect(diagnosticNotice("The bounce breakdown", true, false)).toMatch(
      /not an empty result/,
    );
    expect(diagnosticNotice("The bounce breakdown", true, true)).toMatch(
      /needs a connection/,
    );
  });
});
