import { describe, expect, it } from "vitest";

import {
  branchFunnelStepId,
  funnelMetricSpoken,
  funnelSummary,
  getFunnelMetric,
  topLevelFunnelStepId,
  type SequenceFunnelWire,
} from "./sequenceFunnel";

describe("step id encoding", () => {
  it("converts mobile 0-based positions into the wire's 1-based ids", () => {
    // Desktop passes its own 1-based position straight through; mobile
    // positions are array indices, so the +1 is mandatory. Getting this wrong
    // shows every node the NEXT step's numbers.
    expect(topLevelFunnelStepId(0)).toBe("p1");
    expect(topLevelFunnelStepId(2)).toBe("p3");
  });

  it("encodes branch paths the same way the producer does", () => {
    expect(branchFunnelStepId("p3", "yes", 0)).toBe("p3:yes:p1");
    expect(branchFunnelStepId("p1:yes:p2", "no", 0)).toBe("p1:yes:p2:no:p1");
  });
});

describe("getFunnelMetric", () => {
  const funnel: SequenceFunnelWire = {
    steps: [
      { position: 0, step_id: "p1", reached: 10, opened: 6, clicked: 2 },
      { position: 1, step_id: "p2", reached: 8, opened: 3, clicked: 1 },
      {
        position: 0,
        step_id: "p2:yes:p1",
        reached: 4,
        opened: 2,
        clicked: 1,
      },
    ],
  };

  it("matches on the path-encoded id, including branch steps", () => {
    expect(getFunnelMetric(funnel, "p2", 1)?.reached).toBe(8);
    expect(getFunnelMetric(funnel, "p2:yes:p1", null)?.reached).toBe(4);
  });

  it("never matches a branch step by position", () => {
    // "p9:yes:p1" is absent; position 0 exists twice, and a positional
    // fallback would hand back the top-level step's numbers.
    expect(getFunnelMetric(funnel, "p9:yes:p1", null)).toBeUndefined();
  });

  it("falls back to the legacy 0-indexed position only for step_id-less rows", () => {
    const legacy: SequenceFunnelWire = {
      steps: [
        { position: 0, reached: 10, opened: 5, clicked: 1 },
        { position: 1, reached: 7, opened: 2, clicked: 0 },
      ],
    };
    // Mobile position 1 is the SECOND step; the legacy column is 0-indexed
    // too, so no offset is applied on this side.
    expect(getFunnelMetric(legacy, "p2", 1)?.reached).toBe(7);
    expect(getFunnelMetric(legacy, "p1", 0)?.reached).toBe(10);
  });

  it("prefers an exact id over a positional match", () => {
    const mixed: SequenceFunnelWire = {
      steps: [
        { position: 5, reached: 1, opened: 0, clicked: 0 },
        { position: 99, step_id: "p6", reached: 42, opened: 0, clicked: 0 },
      ],
    };
    expect(getFunnelMetric(mixed, "p6", 5)?.reached).toBe(42);
  });

  it("returns undefined for an absent or malformed report", () => {
    expect(getFunnelMetric(null, "p1", 0)).toBeUndefined();
    expect(getFunnelMetric({}, "p1", 0)).toBeUndefined();
    expect(
      getFunnelMetric({ steps: null as unknown as [] }, "p1", 0),
    ).toBeUndefined();
  });
});

describe("funnelSummary", () => {
  it("reports hasData false for an empty report rather than confident zeros", () => {
    expect(funnelSummary(null).hasData).toBe(false);
    expect(funnelSummary({ steps: [] }).hasData).toBe(false);
  });

  it("takes entered from the FIRST position, not the sum of all rows", () => {
    const summary = funnelSummary({
      steps: [
        { position: 0, reached: 100, opened: 40, clicked: 10 },
        { position: 1, reached: 80, opened: 20, clicked: 5 },
        { position: 2, reached: 60, opened: 10, clicked: 1 },
      ],
    });
    expect(summary.entered).toBe(100);
    expect(summary.opened).toBe(70);
    expect(summary.clicked).toBe(16);
    expect(summary.openRate).toBe(70);
    expect(summary.clickRate).toBe(16);
  });

  it("sums sibling branch rows that share the first position", () => {
    const summary = funnelSummary({
      steps: [
        { position: 0, step_id: "p1", reached: 30, opened: 0, clicked: 0 },
        {
          position: 0,
          step_id: "p2:yes:p1",
          reached: 12,
          opened: 0,
          clicked: 0,
        },
        { position: 1, reached: 5, opened: 0, clicked: 0 },
      ],
    });
    expect(summary.entered).toBe(42);
  });

  it("names the worst drop-off and where it happened", () => {
    const summary = funnelSummary({
      steps: [
        { position: 0, reached: 100, opened: 0, clicked: 0, dropoff_pct: 0 },
        { position: 1, reached: 40, opened: 0, clicked: 0, dropoff_pct: 60 },
        { position: 2, reached: 35, opened: 0, clicked: 0, dropoff_pct: 12.5 },
      ],
    });
    expect(summary.worstDropoffPct).toBe(60);
    expect(summary.worstDropoffPosition).toBe(1);
  });

  it("treats non-numeric counts as zero instead of producing NaN", () => {
    const summary = funnelSummary({
      steps: [
        {
          position: 0,
          reached: "10" as unknown as number,
          opened: Number.NaN,
          clicked: -4,
        },
      ],
    });
    expect(summary.entered).toBe(0);
    expect(summary.opened).toBe(0);
    expect(summary.clicked).toBe(0);
    expect(summary.openRate).toBe(0);
  });
});

describe("funnelMetricSpoken", () => {
  it("attaches nouns to the compacted integers", () => {
    expect(
      funnelMetricSpoken({ position: 0, reached: 10, opened: 1, clicked: 0 }),
    ).toBe("Reached 10 subscribers, 1 open, 0 clicks.");
  });

  it("singularises one subscriber", () => {
    expect(
      funnelMetricSpoken({ position: 0, reached: 1, opened: 2, clicked: 3 }),
    ).toBe("Reached 1 subscriber, 2 opens, 3 clicks.");
  });
});
