import { describe, expect, it } from "vitest";

import {
  linkRows,
  namedOpenRows,
  readBounces,
  readGoalResults,
  readHoldoutLift,
  shortLinkLabel,
} from "./campaignInsights";

describe("shortLinkLabel", () => {
  it("drops the scheme and the trailing slash", () => {
    expect(shortLinkLabel("https://acme.com/sale/")).toBe("acme.com/sale");
  });

  it("truncates rather than overflowing a phone row", () => {
    const long = `https://acme.com/${"a".repeat(200)}`;
    expect(shortLinkLabel(long).length).toBeLessThanOrEqual(46);
    expect(shortLinkLabel(long).endsWith("…")).toBe(true);
  });

  it("names the gap instead of rendering an empty row", () => {
    expect(shortLinkLabel(undefined)).toBe("(no URL)");
    expect(shortLinkLabel("   ")).toBe("(no URL)");
  });
});

describe("linkRows", () => {
  it("ranks by clicks and scales the bar against the top row", () => {
    const rows = linkRows([
      { url: "https://a.com", clicks: 10, ctr: 0.1 },
      { url: "https://b.com", clicks: 40, ctr: 0.4 },
      { url: "https://c.com", clicks: 20 },
    ]);
    expect(rows.map((r) => r.label)).toEqual(["b.com", "c.com", "a.com"]);
    expect(rows[0]?.share).toBe(1);
    expect(rows[1]?.share).toBe(0.5);
  });

  it("survives a payload that isn't an array", () => {
    expect(linkRows(null)).toEqual([]);
    expect(linkRows({ rows: [] })).toEqual([]);
    expect(linkRows([{ url: "x" }])).toEqual([]);
  });

  it("speaks the FULL url and the click-through rate the row has no room for", () => {
    // The visible label is truncated to fit a phone row; a screen reader must
    // still get the whole destination, not "acme.com/aaaaaa…".
    const long = `https://acme.com/${"a".repeat(120)}`;
    const [row] = linkRows([{ url: long, clicks: 12_345, ctr: 0.2 }]);
    expect(row?.label).toContain("…");
    expect(row?.spoken).not.toContain("…");
    expect(row?.spoken).toContain("12,345 clicks");
    expect(row?.spoken).toContain("20.0% click-through");
  });
});

describe("namedOpenRows", () => {
  it("reads the field the endpoint actually used", () => {
    expect(
      namedOpenRows([{ client: "Apple Mail", opens: 5 }], "client")[0]?.label,
    ).toBe("Apple Mail");
    expect(
      namedOpenRows([{ country: "DE", opens: 5 }], "country")[0]?.label,
    ).toBe("DE");
  });

  it("labels an empty name rather than rendering a blank row", () => {
    expect(namedOpenRows([{ client: "", opens: 3 }], "client")[0]?.label).toBe(
      "Unknown",
    );
  });
});

describe("readBounces", () => {
  it("separates hard from soft — they demand different responses", () => {
    const reading = readBounces({ hard: 3, soft: 7, spam_trap: 0, total: 10 });
    expect(reading.rows.map((r) => r.value)).toEqual(["3", "7", "0"]);
    expect(reading.clean).toBe(false);
    expect(reading.warning).toBeNull();
  });

  it("warns loudly on a spam-trap hit", () => {
    const reading = readBounces({ hard: 0, soft: 0, spam_trap: 1, total: 1 });
    expect(reading.warning).toContain("spam trap");
  });

  it("reports a clean send when every category is zero", () => {
    expect(
      readBounces({ hard: 0, soft: 0, spam_trap: 0, total: 0 }).clean,
    ).toBe(true);
    expect(readBounces(null).clean).toBe(true);
  });

  it("derives the total when the server omits it", () => {
    expect(readBounces({ hard: 2, soft: 1 }).clean).toBe(false);
  });
});

describe("readGoalResults", () => {
  it("says plainly when no goal is configured", () => {
    const reading = readGoalResults({ configured: false });
    expect(reading.configured).toBe(false);
    expect(reading.rows).toEqual([]);
    expect(reading.headline).toContain("No conversion goal");
  });

  it("names the goal event and its attribution window", () => {
    const reading = readGoalResults({
      configured: true,
      goal_event: "purchase",
      goal_window_hours: 24,
      conversion_count: 12,
      recipients: 400,
      conversion_rate: 0.03,
    });
    expect(reading.headline).toContain("purchase");
    expect(reading.headline).toContain("24h");
    expect(reading.rows.map((r) => r.key)).toEqual([
      "conversions",
      "rate",
      "recipients",
    ]);
  });

  it("omits revenue entirely when nothing was attributed", () => {
    const reading = readGoalResults({
      configured: true,
      goal_event: "purchase",
      attributed_revenue_cents: 0,
    });
    expect(reading.rows.some((r) => r.key === "revenue")).toBe(false);
  });

  it("renders attributed revenue from CENTS", () => {
    const reading = readGoalResults({
      configured: true,
      goal_event: "purchase",
      attributed_revenue_cents: 123_400,
      currency: "USD",
    });
    const revenue = reading.rows.find((r) => r.key === "revenue");
    expect(revenue?.value).toContain("1,234");
  });
});

describe("readHoldoutLift", () => {
  it("does not invent a lift before the holdout is decided", () => {
    const reading = readHoldoutLift({ status: "pending", message: "not yet" });
    expect(reading.state).toBe("pending");
    expect(reading.decided).toBe(false);
    expect(reading.rows).toEqual([]);
    expect(reading.headline).toBe("not yet");
  });

  it("treats a missing payload as undecided rather than as zero lift", () => {
    expect(readHoldoutLift(null).decided).toBe(false);
  });

  it("renders only the frozen powered significance result", () => {
    const reading = readHoldoutLift({
      status: "powered",
      outcome_metric: "purchase",
      held_out_subs: 50,
      sent_subs: 450,
      significance: {
        control_rate: 0.1,
        treatment_rate: 0.12,
        absolute_lift: 0.02,
        relative_lift: 0.2,
        incremental_conversions: 9,
        p_value: 0.02,
        ci_low: 0.004,
        ci_high: 0.036,
        powered: true,
        minimum_detectable_effect: 0.03,
      },
    });
    expect(reading.state).toBe("measured");
    expect(reading.decided).toBe(true);
    expect(reading.positive).toBe(true);
    expect(reading.headline).toContain("+20.0%");
    expect(reading.rows[0]?.label).toContain("purchase");
    expect(reading.caveat).toContain("95% confidence interval");
  });

  it("labels an underpowered experiment as underpowered, never no lift", () => {
    const reading = readHoldoutLift({
      status: "underpowered",
      held_out_subs: 10,
      sent_subs: 90,
      significance: {
        control_rate: 0.1,
        treatment_rate: 0.09,
        absolute_lift: null,
        relative_lift: null,
        incremental_conversions: null,
        p_value: 0.8,
        ci_low: null,
        ci_high: null,
        powered: false,
        minimum_detectable_effect: 0.2,
        underpowered_reason: "sample is too small",
      },
    });
    expect(reading.state).toBe("underpowered");
    expect(reading.badge?.label).toContain("Underpowered");
    expect(reading.headline).toContain("No lift number is shown");
    expect(reading.headline).not.toMatch(/no lift detected/i);
    expect(reading.positive).toBe(false);
    expect(reading.decided).toBe(false);
  });

  it("fails loud when immutable evidence or significance is unavailable", () => {
    const reading = readHoldoutLift({
      status: "unavailable",
      message: "assignment evidence unavailable",
    });
    expect(reading.state).toBe("unavailable");
    expect(reading.badge?.label).toContain("Unavailable");
    expect(reading.caveat).toContain("not a result of zero");
    expect(reading.rows).toEqual([]);
  });
});
