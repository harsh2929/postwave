// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from "vitest";

import {
  humanizeMetricKey,
  formatMetricValue,
  formatCents,
  computeEngagementRates,
  formatRate,
  pluralize,
  RANGE_OPTIONS,
  rangeDays,
  rangeSubtitle,
  csvCell,
  toCsv,
  buildStatsCsv,
} from "@/lib/analytics-format";
import type { DashboardStats } from "@/lib/analytics-api";

describe("humanizeMetricKey", () => {
  it("maps known predictive keys to friendly labels", () => {
    expect(humanizeMetricKey("AVERAGE_LTV_CENTS")).toBe("Average LTV");
    expect(humanizeMetricKey("REPEAT_PURCHASE_RATE")).toBe("Repeat purchase rate");
    expect(humanizeMetricKey("MODEL_QUALITY")).toBe("Model quality");
    expect(humanizeMetricKey("CUSTOMERS")).toBe("Customers");
  });

  it("title-cases unknown SCREAMING_SNAKE keys and preserves acronyms", () => {
    expect(humanizeMetricKey("PREDICTED_AGE")).toBe("Predicted age");
    expect(humanizeMetricKey("PREDICTED_CLV_CENTS")).toBe("Predicted CLV");
    expect(humanizeMetricKey(" engagement_ctr ")).toBe("Engagement CTR");
  });

  it("never returns the raw screaming key", () => {
    const out = humanizeMetricKey("SOME_BRAND_NEW_FIELD");
    expect(out).not.toBe("SOME_BRAND_NEW_FIELD");
    expect(out).toBe("Some brand new field");
  });

  it("falls back to the raw string for empty input", () => {
    expect(humanizeMetricKey("")).toBe("");
  });
});

describe("formatCents", () => {
  it("renders cents as localized currency", () => {
    expect(formatCents(6400)).toBe("$64.00");
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(123456)).toBe("$1,234.56");
  });
  it("honors a currency code", () => {
    // Non-USD still renders with 2 decimals; exact symbol is locale-driven, so
    // assert the numeric part is present.
    expect(formatCents(6400, "EUR")).toContain("64.00");
  });
  it("handles negative and non-finite gracefully", () => {
    expect(formatCents(-6400)).toBe("-$64.00");
    expect(formatCents(Number.NaN)).toBe("—");
  });
});

describe("formatMetricValue", () => {
  it("formats *_CENTS keys as currency", () => {
    expect(formatMetricValue("AVERAGE_LTV_CENTS", 6400)).toBe("$64.00");
  });
  it("formats *_RATE keys as a percentage of a 0..1 fraction", () => {
    expect(formatMetricValue("REPEAT_PURCHASE_RATE", 0.25)).toBe("25%");
    expect(formatMetricValue("REPEAT_PURCHASE_RATE", 0)).toBe("0%");
  });
  it("formats a *_RATE already expressed as a whole percentage", () => {
    // Values > 1 are treated as already-percentages (e.g. 25 => 25%).
    expect(formatMetricValue("REPEAT_PURCHASE_RATE", 25)).toBe("25%");
  });
  it("formats counts as plain localized numbers", () => {
    expect(formatMetricValue("CUSTOMERS", 12000)).toBe("12,000");
  });
  it("passes strings through", () => {
    expect(formatMetricValue("MODEL_QUALITY", "high")).toBe("high");
  });
  it("returns a dash for nullish", () => {
    expect(formatMetricValue("CUSTOMERS", null)).toBe("—");
    expect(formatMetricValue("CUSTOMERS", undefined)).toBe("—");
  });
});

describe("computeEngagementRates", () => {
  const base: DashboardStats = {
    subscribers_total: 100,
    subscribers_added_30d: 10,
    subscribers_unsubbed_30d: 2,
    campaigns_sent_30d: 3,
    opens_total_30d: 500,
    clicks_total_30d: 120,
    bounces_total_30d: 8,
    unique_opens_30d: 400,
    unique_clicks_30d: 100,
    unique_bounces_30d: 8,
    unique_delivered_30d: 1000,
    unique_sent_30d: 1010,
  };

  it("computes open/click/ctor/bounce/unsub rates as 0..1 fractions", () => {
    const r = computeEngagementRates(base);
    expect(r.openRate).toBeCloseTo(0.4, 5); // 400/1000
    expect(r.clickRate).toBeCloseTo(0.1, 5); // 100/1000
    expect(r.clickToOpen).toBeCloseTo(0.25, 5); // 100/400
    expect(r.bounceRate).toBeCloseTo(8 / 1010, 5); // unique_bounces/unique_sent
    expect(r.unsubRate).toBeCloseTo(2 / 1000, 5); // unsubbed/delivered
  });

  it("returns null (not NaN/Infinity) on divide-by-zero", () => {
    const r = computeEngagementRates({
      ...base,
      unique_opens_30d: 0,
      unique_clicks_30d: 0,
      unique_bounces_30d: 0,
      unique_delivered_30d: 0,
      unique_sent_30d: 0,
    });
    expect(r.openRate).toBeNull();
    expect(r.clickRate).toBeNull();
    expect(r.clickToOpen).toBeNull();
    expect(r.bounceRate).toBeNull();
    expect(r.unsubRate).toBeNull();
  });

  it("falls back to non-unique totals when unique fields are absent", () => {
    const r = computeEngagementRates({
      subscribers_total: 1,
      subscribers_added_30d: 0,
      subscribers_unsubbed_30d: 0,
      campaigns_sent_30d: 1,
      opens_total_30d: 50,
      clicks_total_30d: 10,
      bounces_total_30d: 0,
      emails_sent_30d: 100,
    });
    // With no delivered denominator, open/click rates are null (honest).
    expect(r.openRate).toBeNull();
  });
});

describe("formatRate", () => {
  it("renders a fraction as a percentage with one decimal", () => {
    expect(formatRate(0.4)).toBe("40.0%");
    expect(formatRate(0.005)).toBe("0.5%");
  });
  it("renders a dash for null", () => {
    expect(formatRate(null)).toBe("—");
  });
});

describe("pluralize", () => {
  it("uses the singular for exactly 1", () => {
    expect(pluralize(1, "star")).toBe("star");
    expect(pluralize(1, "star", "stars")).toBe("star");
  });
  it("uses the plural otherwise", () => {
    expect(pluralize(0, "star")).toBe("stars");
    expect(pluralize(2, "star")).toBe("stars");
    expect(pluralize(5, "star")).toBe("stars");
  });
  it("accepts a numeric string", () => {
    expect(pluralize("1", "star")).toBe("star");
    expect(pluralize("3", "star")).toBe("stars");
  });
  it("honors an explicit irregular plural", () => {
    expect(pluralize(2, "person", "people")).toBe("people");
  });
});

describe("range helpers", () => {
  it("exposes 7d/30d/90d options", () => {
    expect(RANGE_OPTIONS.map((o) => o.value)).toEqual(["7d", "30d", "90d"]);
  });
  it("maps a range to a day count", () => {
    expect(rangeDays("7d")).toBe(7);
    expect(rangeDays("30d")).toBe(30);
    expect(rangeDays("90d")).toBe(90);
    expect(rangeDays("garbage")).toBe(30);
  });
  it("produces a subtitle reflecting the window", () => {
    expect(rangeSubtitle("7d")).toContain("7 days");
    expect(rangeSubtitle("90d")).toContain("90 days");
  });
});

describe("csv serialization", () => {
  it("quotes cells containing comma/quote/newline", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });
  it("renders numbers and nullish", () => {
    expect(csvCell(42)).toBe("42");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
  it("joins rows with CRLF", () => {
    const csv = toCsv([
      ["Metric", "Value"],
      ["Opens", 500],
      ["Note", "a,b"],
    ]);
    expect(csv).toBe('Metric,Value\r\nOpens,500\r\nNote,"a,b"');
  });
  it("builds a stats CSV with a header row and metric rows", () => {
    const csv = buildStatsCsv(
      {
        subscribers_total: 1234,
        subscribers_added_30d: 56,
        subscribers_unsubbed_30d: 7,
        campaigns_sent_30d: 8,
        opens_total_30d: 900,
        clicks_total_30d: 123,
        bounces_total_30d: 4,
      },
      "30d",
    );
    expect(csv.split("\r\n")[0]).toBe("Metric,Value,Window");
    expect(csv).toContain("Subscribers (total),1234,30d");
    expect(csv).toContain("Opens,900,30d");
  });
});

import { reconcileKpiOrder } from "@/lib/analytics-format";

describe("reconcileKpiOrder (ANL-034)", () => {
  const all = ["a", "b", "c", "d"];
  it("returns all keys in default order when no layout is saved", () => {
    expect(reconcileKpiOrder(all, undefined)).toEqual(all);
    expect(reconcileKpiOrder(all, [])).toEqual(all);
  });
  it("treats an all-unknown saved order (legacy default) as no custom layout", () => {
    expect(reconcileKpiOrder(all, ["subs", "opens"])).toEqual(all);
  });
  it("uses the saved known keys as the visible ordered set, hiding the rest", () => {
    expect(reconcileKpiOrder(all, ["c", "a"])).toEqual(["c", "a"]);
  });
  it("drops unknown keys but keeps the known ones in order", () => {
    expect(reconcileKpiOrder(all, ["b", "zzz", "d"])).toEqual(["b", "d"]);
  });
});
