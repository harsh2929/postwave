// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it } from "vitest";

import {
  resetCSPReportLimiterForTests,
  shouldLogCSPReport,
} from "@/app/api/csp-report/rate-limit";

function report(id: number): Record<string, unknown>[] {
  return [
    {
      document_uri: `https://app.example/path-${id}`,
      blocked_uri: "https://blocked.example/",
      effective_directive: "connect-src",
    },
  ];
}

describe("CSP report log limiter", () => {
  beforeEach(() => resetCSPReportLimiterForTests());

  it("deduplicates identical browser retries for five minutes", () => {
    expect(shouldLogCSPReport(report(1), 1_000)).toBe(true);
    expect(shouldLogCSPReport(report(1), 1_001)).toBe(false);
    expect(shouldLogCSPReport(report(1), 300_999)).toBe(false);
    expect(shouldLogCSPReport(report(1), 301_000)).toBe(true);
  });

  it("caps unique unauthenticated log entries per process and minute", () => {
    const decisions = Array.from({ length: 35 }, (_, index) =>
      shouldLogCSPReport(report(index), 10_000 + index),
    );
    expect(decisions.filter(Boolean)).toHaveLength(30);
    expect(decisions.slice(30)).toEqual([false, false, false, false, false]);

    expect(shouldLogCSPReport(report(100), 70_000)).toBe(true);
  });

  it("does not consume budget for empty sanitized reports", () => {
    expect(shouldLogCSPReport([], 1_000)).toBe(false);
    expect(shouldLogCSPReport(report(1), 1_000)).toBe(true);
  });
});
