// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import { FLOW_STARTERS, getFlowStarter } from "@/lib/flow-starters";

describe("flow-starters", () => {
  it("includes a blank plus the common journeys", () => {
    const keys = FLOW_STARTERS.map((s) => s.key);
    expect(keys).toContain("blank");
    expect(keys).toContain("welcome");
    expect(keys).toContain("winback");
    expect(keys).toContain("abandoned_cart");
  });

  it("every starter builds a valid draft graph with a wired chain", () => {
    for (const starter of FLOW_STARTERS) {
      const input = starter.build();
      expect(input.status).toBe("draft");
      expect(input.nodes && input.nodes.length).toBeGreaterThan(0);
      // entry_id points at a real node
      expect(input.nodes?.some((n) => n.id === input.entry_id)).toBe(true);
      // every edge references existing nodes
      const ids = new Set(input.nodes?.map((n) => n.id));
      for (const e of input.edges ?? []) {
        expect(ids.has(e.from)).toBe(true);
        expect(ids.has(e.to)).toBe(true);
      }
    }
  });

  it("generates fresh ids per build so two flows don't collide", () => {
    const a = getFlowStarter("welcome")!.build();
    const b = getFlowStarter("welcome")!.build();
    expect(a.entry_id).not.toBe(b.entry_id);
  });

  it("win-back re-enrolls on a cooldown; abandoned-cart re-enrolls always", () => {
    expect(getFlowStarter("winback")!.build().re_enrollment).toBe("cooldown");
    expect(getFlowStarter("abandoned_cart")!.build().re_enrollment).toBe(
      "always",
    );
  });
});
