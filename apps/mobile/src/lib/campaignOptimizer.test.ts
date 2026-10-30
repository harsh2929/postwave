/**
 * The content-optimizer readers. readOptimizerPreview refuses a body with no
 * recommended_arms outright — an "allocation" with no arms is not a preview.
 */
import { describe, expect, it } from "vitest";

import { readOptimizerPreview, readOptimizerRun } from "./campaignOptimizer";

const wireArm = {
  key: "arm-a",
  subject: "Subject A",
  allocation_percent: 62.5,
  score: 0.7,
  reason: "leading opens",
};

describe("readOptimizerPreview", () => {
  it("reads method, metric and arms", () => {
    const reading = readOptimizerPreview({
      method: "thompson",
      primary_metric: "open_rate",
      recommended_arms: [wireArm, { no_key: true }],
    });
    expect(reading).not.toBeNull();
    expect(reading!.method).toBe("thompson");
    expect(reading!.arms).toHaveLength(1);
    expect(reading!.arms[0]).toEqual({
      key: "arm-a",
      subject: "Subject A",
      allocationPercent: 62.5,
      score: 0.7,
      reason: "leading opens",
    });
  });
  it("null when recommended_arms is missing — not an empty preview", () => {
    expect(readOptimizerPreview({ method: "thompson" })).toBeNull();
    expect(readOptimizerPreview(null)).toBeNull();
  });
});

describe("readOptimizerRun", () => {
  it("reads the persisted run with its embedded preview", () => {
    const run = readOptimizerRun({
      id: "run-1",
      status: "recorded",
      preview: { recommended_arms: [wireArm] },
    });
    expect(run).not.toBeNull();
    expect(run!.id).toBe("run-1");
    expect(run!.preview?.arms).toHaveLength(1);
  });
  it("null without an id", () => {
    expect(readOptimizerRun({ status: "recorded" })).toBeNull();
  });
});
