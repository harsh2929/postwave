/**
 * The a11y report reader: score clamped, findings bounded for a phone, and
 * the headline/tone pair that decides how loudly the row speaks.
 */
import { describe, expect, it } from "vitest";

import {
  A11Y_FINDINGS_SHOWN,
  a11yHeadline,
  a11yTone,
  readA11yReport,
} from "./campaignA11y";

const finding = (i: number, severity = "warn") => ({
  rule: `rule-${i}`,
  severity,
  message: `message ${i}`,
  wcag: "1.4.3",
});

describe("readA11yReport", () => {
  it("reads score, counts and findings", () => {
    const reading = readA11yReport({
      score: 82.4,
      counts: { info: 1, warn: 2, error: 3 },
      findings: [finding(1, "error")],
    });
    expect(reading).not.toBeNull();
    expect(reading!.score).toBe(82);
    expect(reading!.counts).toEqual({ info: 1, warn: 2, error: 3 });
    expect(reading!.findings[0]!.severity).toBe("error");
    expect(reading!.truncated).toBe(false);
  });

  it("bounds the findings shown and says so", () => {
    const reading = readA11yReport({
      score: 50,
      counts: {},
      findings: Array.from({ length: 40 }, (_, i) => finding(i)),
    });
    expect(reading!.findings).toHaveLength(A11Y_FINDINGS_SHOWN);
    expect(reading!.truncated).toBe(true);
  });

  it("null without a numeric score — a missing measurement is not a zero", () => {
    expect(readA11yReport({ findings: [] })).toBeNull();
    expect(readA11yReport(null)).toBeNull();
  });
});

describe("headline + tone", () => {
  it("errors speak as danger, warnings as warning, clean as success", () => {
    const errors = readA11yReport({ score: 40, counts: { error: 2 }, findings: [] })!;
    expect(a11yTone(errors)).toBe("danger");
    expect(a11yHeadline(errors)).toMatch(/2 errors/);

    const warns = readA11yReport({ score: 70, counts: { warn: 1 }, findings: [] })!;
    expect(a11yTone(warns)).toBe("warning");
    expect(a11yHeadline(warns)).toMatch(/1 warning\b/);

    const clean = readA11yReport({ score: 100, counts: {}, findings: [] })!;
    expect(a11yTone(clean)).toBe("success");
    expect(a11yHeadline(clean)).toMatch(/no blocking findings/);
  });
});
