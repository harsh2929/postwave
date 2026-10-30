import { describe, expect, it } from "vitest";

import {
  DEFAULT_BRIEF_WINDOW_DAYS,
  asBriefMetric,
  briefErrorCopy,
  briefProgressCopy,
  formatBriefDelta,
  formatBriefMetricValue,
  formatUnscopedRevenueMinorUnits,
  isSupportedBriefCurrency,
} from "../../components/dashboard/anomaly-brief-helpers";
import { ANOMALY_BRIEF_METRICS } from "../../lib/api-client";

describe("DEFAULT_BRIEF_WINDOW_DAYS", () => {
  it("defaults to 7 days per spec", () => {
    expect(DEFAULT_BRIEF_WINDOW_DAYS).toBe(7);
  });
});

describe("asBriefMetric", () => {
  it("accepts every whitelisted metric as-is", () => {
    for (const m of ANOMALY_BRIEF_METRICS) {
      expect(asBriefMetric(m)).toBe(m);
    }
  });
  it("normalises case and whitespace", () => {
    expect(asBriefMetric("  Bounces ")).toBe("bounces");
    expect(asBriefMetric("REVENUE")).toBe("revenue");
  });
  it("maps singular / shorthand aliases", () => {
    expect(asBriefMetric("bounce")).toBe("bounces");
    expect(asBriefMetric("open")).toBe("opens");
    expect(asBriefMetric("click")).toBe("clicks");
    expect(asBriefMetric("unsub")).toBe("unsubscribes");
    expect(asBriefMetric("unsubs")).toBe("unsubscribes");
    expect(asBriefMetric("complaint")).toBe("complaints");
  });
  it("returns null for unexplainable metrics — callers hide the button", () => {
    expect(asBriefMetric("subs")).toBeNull();
    expect(asBriefMetric("subscribers")).toBeNull();
    expect(asBriefMetric("")).toBeNull();
    expect(asBriefMetric(null)).toBeNull();
    expect(asBriefMetric(undefined)).toBeNull();
  });
});

describe("briefErrorCopy", () => {
  it("429 / cost_cap_exceeded → budget copy, not retryable", () => {
    const byCode = briefErrorCopy({
      message: "cost cap exceeded",
      code: "cost_cap_exceeded",
      status: 429,
    });
    expect(byCode.title).toBe("Daily AI budget exhausted");
    expect(byCode.detail).toContain("resets at UTC midnight");
    expect(byCode.retryable).toBe(false);

    const byStatus = briefErrorCopy({ message: "too many", status: 429 });
    expect(byStatus.title).toBe("Daily AI budget exhausted");
  });
  it("429 with retryAfterSeconds gives a concrete wait", () => {
    const c = briefErrorCopy({
      message: "x",
      status: 429,
      retryAfterSeconds: 600,
    });
    expect(c.detail).toContain("~10 min");
  });
  it("does not render unsafe or implausibly large retry numerics", () => {
    for (const retryAfterSeconds of [
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      86_401,
      2.5,
    ]) {
      expect(
        briefErrorCopy({ status: 429, retryAfterSeconds }).detail,
      ).toContain("resets at UTC midnight");
    }
  });
  it("503 / nlq_unavailable → configuration copy, not retryable", () => {
    const c = briefErrorCopy({
      message: "nlq unavailable",
      code: "nlq_unavailable",
      status: 503,
    });
    expect(c.title).toBe("AI explanations aren't available");
    expect(c.detail).toContain("not configured for this environment");
    expect(c.retryable).toBe(false);
  });
  it("timeout → retryable with 60s explanation", () => {
    const c = briefErrorCopy({ message: "timed out", kind: "timeout" });
    expect(c.retryable).toBe(true);
    expect(c.detail).toContain("60 seconds");
  });
  it("keeps unclassified error payloads out of operator-visible copy", () => {
    const privatePayload =
      "code=PRIVATE_DB_ERROR https://internal.example.test token=sk-private-token";
    const c = briefErrorCopy({ message: privatePayload, status: 500 });
    expect(c.detail).toContain("could not complete the request");
    expect(c.detail).not.toContain(privatePayload);
    expect(c.detail).not.toContain("PRIVATE_DB_ERROR");
    expect(c.detail).not.toContain("internal.example.test");
    expect(c.detail).not.toContain("sk-private-token");
    expect(c.retryable).toBe(true);
  });
});

describe("formatBriefDelta", () => {
  it("computes a signed percent change vs the previous window", () => {
    expect(formatBriefDelta(150, 100, 7)).toBe("+50% vs previous 7 days");
    expect(formatBriefDelta(50, 100, 7)).toBe("-50% vs previous 7 days");
  });
  it("previous=0 → no fabricated percentage", () => {
    expect(formatBriefDelta(42, 0, 7)).toBe(
      "no activity in the previous 7 days to compare against",
    );
    expect(formatBriefDelta(0, 0, 7)).toBe("no activity in either window");
  });
  it("non-finite inputs yield empty string", () => {
    expect(formatBriefDelta(NaN, 10, 7)).toBe("");
  });
  it("rejects unsafe/fractional inputs and bounds extreme percentage copy", () => {
    expect(formatBriefDelta(Number.MAX_SAFE_INTEGER + 1, 1, 7)).toBe("");
    expect(formatBriefDelta(10.5, 1, 7)).toBe("");
    expect(formatBriefDelta(10, 1, Number.POSITIVE_INFINITY)).toBe("");
    expect(formatBriefDelta(Number.MAX_SAFE_INTEGER, 1, 7)).toBe(
      "more than 9,999% above previous 7 days",
    );
    expect(formatBriefDelta(Number.MAX_SAFE_INTEGER, 1, 7)).not.toContain(
      "Infinity",
    );
  });
});

describe("formatBriefMetricValue", () => {
  it("formats revenue endpoint values as minor units in the returned currency", () => {
    const rendered = formatBriefMetricValue("revenue", 12_345, "EUR");
    const expected = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "EUR",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(123.45);
    expect(rendered).toBe(expected);
    expect(rendered).not.toContain("$");
  });

  it("formats event metrics as counts and rejects unsafe wire values", () => {
    expect(formatBriefMetricValue("opens", 12_345)).toMatch(/12[,.]?345/);
    expect(formatBriefMetricValue("opens", 12.5)).toBe("unavailable");
    expect(formatBriefMetricValue("revenue", Number.POSITIVE_INFINITY)).toBe(
      "unavailable",
    );
    expect(formatBriefMetricValue("revenue", Number.MAX_SAFE_INTEGER + 1)).toBe(
      "unavailable",
    );
    expect(formatBriefMetricValue("revenue", 100, "ZZZ")).toBe("unavailable");
    expect(formatBriefMetricValue("revenue", 100, null)).toBe("unavailable");
    expect(formatBriefMetricValue("revenue", 0, null)).toBe(
      "0 minor units (no currency selected)",
    );
  });
});

describe("revenue currency provenance", () => {
  it("accepts supported upper-case ISO currencies and rejects invented/malformed codes", () => {
    expect(isSupportedBriefCurrency("USD")).toBe(true);
    expect(isSupportedBriefCurrency("EUR")).toBe(true);
    expect(isSupportedBriefCurrency("usd")).toBe(false);
    expect(isSupportedBriefCurrency("ZZZ")).toBe(false);
    expect(isSupportedBriefCurrency(null)).toBe(false);
  });

  it("keeps unscoped history values in raw minor units without a false currency", () => {
    expect(formatUnscopedRevenueMinorUnits(12_345)).toMatch(
      /12[,.]?345 minor units \(currency unavailable\)/,
    );
    expect(formatUnscopedRevenueMinorUnits(12_345)).not.toMatch(/[$€£]/u);
    expect(formatUnscopedRevenueMinorUnits(50.5)).toContain("minor units");
    expect(formatUnscopedRevenueMinorUnits(Number.POSITIVE_INFINITY)).toBe(
      "unavailable",
    );
  });
});

describe("briefProgressCopy", () => {
  it("stages the copy as the wait grows", () => {
    const early = briefProgressCopy(2);
    const mid = briefProgressCopy(15);
    const late = briefProgressCopy(45);
    expect(early).not.toBe(mid);
    expect(mid).not.toBe(late);
    expect(late).toContain("60 seconds");
  });
});
