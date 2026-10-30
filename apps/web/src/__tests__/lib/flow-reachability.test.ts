// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import { reachableNodeIds } from "@/lib/flow-layout";
import type { FlowNode } from "@/lib/flows-api";

const n = (id: string, type = "send_email", extra: Partial<FlowNode> = {}): FlowNode => ({
  id,
  type,
  ...extra,
});

describe("reachableNodeIds", () => {
  it("follows linear edges and branch legs from the entry", () => {
    const nodes = [
      n("start"),
      n("branch", "branch", { true_next: "yes", false_next: "no" }),
      n("yes"),
      n("no"),
      n("orphan"), // disconnected
    ];
    const edges = [{ from: "start", to: "branch" }];
    const reach = reachableNodeIds(nodes, edges, "start");
    expect(reach.has("start")).toBe(true);
    expect(reach.has("branch")).toBe(true);
    expect(reach.has("yes")).toBe(true);
    expect(reach.has("no")).toBe(true);
    expect(reach.has("orphan")).toBe(false);
  });

  it("returns an empty set for an empty graph", () => {
    expect(reachableNodeIds([], [], undefined).size).toBe(0);
  });
});
