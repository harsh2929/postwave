/**
 * The holdout reader + the sentence the setup card leads with. The decided
 * flag matters: a holdout already applied at send time must not be offered
 * for reconfiguration as if the send had not happened.
 */
import { describe, expect, it } from "vitest";

import {
  clampHoldoutPercent,
  holdoutSummary,
  readHoldout,
} from "./campaignHoldout";

describe("readHoldout", () => {
  it("reads the configured row", () => {
    const reading = readHoldout({
      percent: 10,
      held_out_count: 120,
      sent_count: 1080,
      outcome_metric: "conversion",
      decided_at: "2026-08-20T10:00:00Z",
    });
    expect(reading).toEqual({
      percent: 10,
      heldOutCount: 120,
      sentCount: 1080,
      outcomeMetric: "conversion",
      decided: true,
    });
  });
  it("null when there is no numeric percent (404 body, junk)", () => {
    expect(readHoldout(null)).toBeNull();
    expect(readHoldout({ percent: "ten" })).toBeNull();
  });
});

describe("holdoutSummary", () => {
  it("no config → the invitation sentence", () => {
    expect(holdoutSummary(null)).toMatch(/Set one before the send/);
  });
  it("pending config names the percent and the metric", () => {
    expect(
      holdoutSummary({
        percent: 10,
        heldOutCount: 0,
        sentCount: 0,
        outcomeMetric: "conversion",
        decided: false,
      }),
    ).toMatch(/10% of the audience will be held out/);
  });
  it("a decided holdout points at the lift card instead", () => {
    expect(
      holdoutSummary({
        percent: 5,
        heldOutCount: 50,
        sentCount: 950,
        outcomeMetric: "",
        decided: true,
      }),
    ).toMatch(/was applied at send time/);
  });
});

describe("clampHoldoutPercent mirrors the server's 0..50", () => {
  it("clamps", () => {
    expect(clampHoldoutPercent(75)).toBe(50);
    expect(clampHoldoutPercent(-5)).toBe(0);
    expect(clampHoldoutPercent(Number.NaN)).toBe(0);
    expect(clampHoldoutPercent(10)).toBe(10);
  });
});
