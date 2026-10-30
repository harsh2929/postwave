import { describe, expect, it } from "vitest";

import { getFunnelMetric } from "../../components/sequence/funnel-metrics";
import type { SequenceFunnel } from "../../lib/api-client";

/**
 * Regression coverage for D07-templates-seq-automations#4: legacy
 * NULL-step_id funnel rows carry a 0-indexed `position`, but canvas steps
 * pass their 1-based position — the legacy branch must subtract 1 or every
 * node overlays the NEXT step's numbers.
 */
function funnel(
  steps: Array<{ position: number; step_id?: string }>,
): SequenceFunnel {
  return { steps } as unknown as SequenceFunnel;
}

describe("getFunnelMetric", () => {
  it("maps a 1-based canvas position to the 0-indexed legacy row", () => {
    const f = funnel([{ position: 0 }, { position: 1 }, { position: 2 }]);
    expect(getFunnelMetric(f, "p1", 1)?.position).toBe(0);
    expect(getFunnelMetric(f, "p2", 2)?.position).toBe(1);
    expect(getFunnelMetric(f, "p3", 3)?.position).toBe(2);
  });

  it("prefers an exact step_id match over the legacy position", () => {
    const f = funnel([
      { position: 0, step_id: "p2" },
      { position: 5 },
    ]);
    expect(getFunnelMetric(f, "p2", 2)?.position).toBe(0);
  });

  it("does not fall back to position for branch steps (null legacyPosition)", () => {
    const f = funnel([{ position: 0 }]);
    expect(getFunnelMetric(f, "p1:yes:p1", null)).toBeUndefined();
  });

  it("returns undefined when no legacy row matches", () => {
    const f = funnel([{ position: 0 }]);
    // Canvas position 5 → legacy position 4, which does not exist.
    expect(getFunnelMetric(f, "p5", 5)).toBeUndefined();
  });
});
