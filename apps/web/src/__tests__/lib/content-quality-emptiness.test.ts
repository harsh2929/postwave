// SPDX-License-Identifier: AGPL-3.0-only
//
// Empty is not one state. These pin the distinction between "there was
// nothing to analyse" and "we analysed and found nothing", because only the
// second says anything about the content.

import { describe, expect, it } from "vitest";

import {
  subjectEmptiness,
  type SubjectBuckets,
} from "@/lib/content-quality-api";

const buckets = (o: Partial<SubjectBuckets> = {}): SubjectBuckets => ({
  buckets: [],
  campaigns_total: 0,
  window_days: 180,
  ...o,
});

describe("subject analyser emptiness", () => {
  it("blames the absent campaigns when there were none to analyse", () => {
    // The live state. Reporting "no patterns" here would be a verdict on copy
    // that was never examined.
    expect(subjectEmptiness(buckets())).toBe("no-campaigns");
  });

  it("reports no patterns only when campaigns existed to analyse", () => {
    expect(subjectEmptiness(buckets({ campaigns_total: 40 }))).toBe(
      "no-patterns",
    );
  });

  it("reports buckets when there are any", () => {
    expect(
      subjectEmptiness(buckets({ buckets: [{}], campaigns_total: 40 })),
    ).toBe("has-buckets");
  });

  it("prefers buckets over the campaign count if both are present", () => {
    // A non-empty bucket list is direct evidence; the campaign count is not
    // needed to explain it.
    expect(subjectEmptiness(buckets({ buckets: [{}] }))).toBe("has-buckets");
  });
});
