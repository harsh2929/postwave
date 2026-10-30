// Funnel-row ↔ canvas-step matching (desktop audit task: branch-step
// funnel metrics). Funnel rows now carry a path-encoded `step_id`
// (migration 0367) so branch steps — which share their branch-local
// position with top-level steps — can be matched exactly. Legacy rows
// (no step_id) must keep working for top-level steps and must NEVER
// surface on branch steps.

import { describe, expect, it } from "vitest";

import {
  type FunnelStepRow,
  branchFunnelStepId,
  findStepByFunnelId,
  getFunnelMetric,
  topLevelFunnelStepId,
} from "../../components/sequence/funnel-metrics";
import type { CanvasStep } from "../../components/sequence/types";
import type { SequenceFunnel } from "../../lib/api-client";

function row(partial: Partial<FunnelStepRow> & { position: number }): FunnelStepRow {
  return {
    reached: 0,
    opened: 0,
    clicked: 0,
    open_rate: 0,
    click_rate: 0,
    dropoff_pct: 0,
    ...partial,
  };
}

function funnelOf(rows: FunnelStepRow[]): SequenceFunnel {
  return { sequence_id: "seq_1", steps: rows };
}

describe("funnel step ids", () => {
  it("encodes top-level and branch paths the way migration 0367 documents", () => {
    expect(topLevelFunnelStepId(3)).toBe("p3");
    expect(branchFunnelStepId("p3", "yes", 1)).toBe("p3:yes:p1");
    expect(branchFunnelStepId("p1:yes:p2", "no", 1)).toBe("p1:yes:p2:no:p1");
  });
});

describe("getFunnelMetric", () => {
  const stepAware = funnelOf([
    row({ position: 1, step_id: "p1", reached: 100 }),
    row({ position: 2, step_id: "p2", reached: 80 }),
    // Branch row sharing position 2 with the top-level row above.
    row({ position: 2, step_id: "p1:yes:p2", reached: 25 }),
  ]);

  it("matches by exact step_id first (top-level)", () => {
    expect(getFunnelMetric(stepAware, "p2", 2)?.reached).toBe(80);
  });

  it("matches branch steps by their path id, not by colliding position", () => {
    expect(getFunnelMetric(stepAware, "p1:yes:p2", null)?.reached).toBe(25);
  });

  it("returns undefined for branch steps against legacy rows (no fallback)", () => {
    const legacy = funnelOf([
      row({ position: 1, reached: 100 }),
      row({ position: 2, reached: 60 }),
    ]);
    expect(getFunnelMetric(legacy, "p1:yes:p2", null)).toBeUndefined();
  });

  it("falls back to legacy position rows for top-level steps", () => {
    // D07#4: legacy NULL-step_id rows carry a 0-indexed `position`, while
    // the canvas step's legacyPosition is 1-based — so the 2nd step (p2,
    // legacyPosition 2) matches the wire row at position 1.
    const legacy = funnelOf([
      row({ position: 0, reached: 100 }),
      row({ position: 1, reached: 60 }),
    ]);
    expect(getFunnelMetric(legacy, "p2", 2)?.reached).toBe(60);
  });

  it("never matches a step-aware branch row through the legacy fallback", () => {
    // Only the branch row exists at position 2; a top-level lookup must
    // not surface it via the position fallback (it has a step_id).
    const branchOnly = funnelOf([
      row({ position: 2, step_id: "p1:yes:p2", reached: 25 }),
    ]);
    expect(getFunnelMetric(branchOnly, "p2", 2)).toBeUndefined();
  });

  it("returns undefined for a null funnel", () => {
    expect(getFunnelMetric(null, "p1", 1)).toBeUndefined();
  });
});

describe("findStepByFunnelId", () => {
  const email = (position: number, id: string): CanvasStep => ({
    id,
    type: "email",
    position,
    subject: `s${position}`,
  });
  const steps: CanvasStep[] = [
    email(1, "a"),
    {
      id: "cond",
      type: "condition",
      position: 2,
      condition_type: "opened",
      yes_branch: [
        email(1, "y1"),
        {
          id: "nested",
          type: "condition",
          position: 2,
          condition_type: "clicked",
          yes_branch: [email(1, "ny1")],
          no_branch: [],
        },
      ],
      no_branch: [email(1, "n1")],
    },
  ];

  it("resolves top-level ids", () => {
    expect(findStepByFunnelId(steps, "p1")?.id).toBe("a");
    expect(findStepByFunnelId(steps, "p2")?.id).toBe("cond");
  });

  it("resolves branch and nested-branch ids", () => {
    expect(findStepByFunnelId(steps, "p2:yes:p1")?.id).toBe("y1");
    expect(findStepByFunnelId(steps, "p2:no:p1")?.id).toBe("n1");
    expect(findStepByFunnelId(steps, "p2:yes:p2:yes:p1")?.id).toBe("ny1");
  });

  it("returns null for missing paths and malformed ids", () => {
    expect(findStepByFunnelId(steps, "p9")).toBeNull();
    expect(findStepByFunnelId(steps, "p1:yes:p1")).toBeNull(); // not a condition
    expect(findStepByFunnelId(steps, "p2:maybe:p1")).toBeNull();
    expect(findStepByFunnelId(steps, "bogus")).toBeNull();
  });
});
