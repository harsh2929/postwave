/**
 * The churn-risk refine reader + the one-sentence summary the send flow
 * shows. dry_run vs committed changes the verb; zero exclusions is a real,
 * different sentence.
 */
import { describe, expect, it } from "vitest";

import {
  readPresendRefine,
  refineSummary,
  REFINE_DEFAULT_THRESHOLD,
} from "./campaignPresendRefine";

describe("readPresendRefine", () => {
  it("reads the PreSendRefineResult shape", () => {
    const reading = readPresendRefine({
      churn_threshold: 90,
      cooling_off_hours: 48,
      excluded_count: 12,
      cooling_off_count: 12,
      cooling_off_until: "2026-08-30T10:00:00Z",
      dry_run: true,
      affected_subscribers_sample: [
        {
          subscriber_id: "s1",
          email: "a@b.com",
          churn_score: 93.5,
          reason: "no opens in 90d",
        },
        { no_email: true },
      ],
    });
    expect(reading).not.toBeNull();
    expect(reading!.churnThreshold).toBe(90);
    expect(reading!.excludedCount).toBe(12);
    expect(reading!.dryRun).toBe(true);
    expect(reading!.sample).toHaveLength(1);
    expect(reading!.sample[0]!.email).toBe("a@b.com");
    expect(reading!.coolingOffUntil).not.toBeNull();
  });

  it("defaults the threshold to the server default when absent", () => {
    expect(readPresendRefine({})!.churnThreshold).toBe(
      REFINE_DEFAULT_THRESHOLD,
    );
  });

  it("null for junk", () => {
    expect(readPresendRefine(null)).toBeNull();
  });
});

describe("refineSummary", () => {
  it("a dry run says WOULD, a commit says ARE", () => {
    const base = {
      churnThreshold: 80,
      coolingOffHours: 24,
      excludedCount: 5,
      coolingOffCount: 5,
      coolingOffUntil: null,
      sample: [],
    };
    expect(refineSummary({ ...base, dryRun: true })).toMatch(/would be held back/);
    expect(refineSummary({ ...base, dryRun: false })).toMatch(/are held back/);
  });
  it("zero exclusions is its own honest sentence", () => {
    const base = {
      churnThreshold: 80,
      coolingOffHours: 24,
      excludedCount: 0,
      coolingOffCount: 0,
      coolingOffUntil: null,
      sample: [],
    };
    expect(refineSummary({ ...base, dryRun: true })).toMatch(/exclude nobody/);
    expect(refineSummary({ ...base, dryRun: false })).toMatch(
      /No churn-risk exclusions/,
    );
  });
});
