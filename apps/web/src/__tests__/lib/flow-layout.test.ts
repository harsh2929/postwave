// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import {
  computeFlowLayout,
  MAX_CANVAS_COORDINATE,
  deriveEdges,
  edgePath,
  snapToGrid,
  type LayoutNode,
} from "@/lib/flow-layout";
import type { FlowEdge, FlowNode } from "@/lib/flows-api";

const n = (
  id: string,
  type = "send_email",
  extra: Partial<FlowNode> = {},
): FlowNode => ({
  id,
  type,
  ...extra,
});

describe("deriveEdges", () => {
  it("includes linear edges and labels branch legs", () => {
    const nodes = [
      n("t"),
      n("b", "branch", { true_next: "yes", false_next: "no" }),
      n("yes"),
      n("no"),
    ];
    const edges: FlowEdge[] = [{ from: "t", to: "b" }];
    const out = deriveEdges(nodes, edges);
    expect(out).toContainEqual({ from: "t", to: "b", label: undefined });
    expect(out).toContainEqual({ from: "b", to: "yes", label: "Yes" });
    expect(out).toContainEqual({ from: "b", to: "no", label: "No" });
  });

  it("drops edges pointing at non-existent nodes", () => {
    const nodes = [n("a")];
    const out = deriveEdges(nodes, [{ from: "a", to: "ghost" }]);
    expect(out).toHaveLength(0);
  });

  it("dedupes identical edges", () => {
    const nodes = [n("a"), n("b")];
    const out = deriveEdges(nodes, [
      { from: "a", to: "b" },
      { from: "a", to: "b" },
    ]);
    expect(out).toHaveLength(1);
  });
});

describe("computeFlowLayout", () => {
  it("layers a linear chain by depth with increasing y", () => {
    const nodes = [n("a"), n("b"), n("c")];
    const edges: FlowEdge[] = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ];
    const layout = computeFlowLayout(nodes, edges, "a");
    expect(layout.nodes.get("a")?.depth).toBe(0);
    expect(layout.nodes.get("b")?.depth).toBe(1);
    expect(layout.nodes.get("c")?.depth).toBe(2);
    const ya = layout.nodes.get("a")!.y;
    const yc = layout.nodes.get("c")!.y;
    expect(yc).toBeGreaterThan(ya);
  });

  it("places both branch successors one depth below the branch", () => {
    const nodes = [
      n("b", "branch", { true_next: "yes", false_next: "no" }),
      n("yes"),
      n("no"),
    ];
    const layout = computeFlowLayout(nodes, [], "b");
    expect(layout.nodes.get("b")?.depth).toBe(0);
    expect(layout.nodes.get("yes")?.depth).toBe(1);
    expect(layout.nodes.get("no")?.depth).toBe(1);
    // Same depth → different columns → different x.
    expect(layout.nodes.get("yes")?.x).not.toBe(layout.nodes.get("no")?.x);
  });

  it("parks an unconnected orphan node below the reachable graph", () => {
    const nodes = [n("a"), n("b"), n("orphan")];
    const layout = computeFlowLayout(nodes, [{ from: "a", to: "b" }], "a");
    expect(layout.nodes.has("orphan")).toBe(true);
    expect(layout.nodes.get("orphan")!.depth).toBeGreaterThan(
      layout.nodes.get("b")!.depth,
    );
  });

  it("terminates on a cycle without hanging", () => {
    const nodes = [n("a"), n("b")];
    const layout = computeFlowLayout(
      nodes,
      [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
      "a",
    );
    expect(layout.nodes.get("a")?.depth).toBe(0);
    expect(layout.nodes.get("b")?.depth).toBe(1);
  });

  it("handles an empty graph", () => {
    const layout = computeFlowLayout([], [], undefined);
    expect(layout.nodes.size).toBe(0);
    expect(layout.width).toBeGreaterThan(0);
  });
});

describe("edgePath", () => {
  it("emits a cubic bezier from source bottom to target top", () => {
    const from: LayoutNode = { id: "a", x: 0, y: 0, depth: 0, col: 0 };
    const to: LayoutNode = { id: "b", x: 0, y: 200, depth: 1, col: 0 };
    const d = edgePath(from, to);
    expect(d.startsWith("M ")).toBe(true);
    expect(d).toContain("C");
  });
});

// The canvas could not be positioned. flow-layout derived coordinates by BFS on
// every render — its own header noted "the flow AST carries no coordinates
// (it's an engine artifact)" — and flow-canvas.tsx had zero drag handlers.
// Klaviyo and Braze both ship a positioned drag-drop journey canvas.
//
// Nodes may now carry an OPTIONAL position. Auto-layout stays the default (a
// freshly-built flow arranges itself); a stored position is an override.
describe("manual node positions", () => {
  it("uses a stored position instead of the derived one", () => {
    const nodes: FlowNode[] = [
      { id: "a", type: "send_email", position: { x: 500, y: 300 } },
      { id: "b", type: "exit" },
    ];
    const layout = computeFlowLayout(nodes, [{ from: "a", to: "b" }], "a");

    const a = layout.nodes.get("a")!;
    expect(a.x).toBe(500);
    expect(a.y).toBe(300);
    expect(a.pinned).toBe(true);
  });

  it("still auto-lays-out nodes that have no stored position", () => {
    const nodes: FlowNode[] = [
      { id: "a", type: "send_email", position: { x: 500, y: 300 } },
      { id: "b", type: "exit" }, // unpositioned
    ];
    const layout = computeFlowLayout(nodes, [{ from: "a", to: "b" }], "a");

    const b = layout.nodes.get("b")!;
    expect(b.pinned).toBe(false);
    // b keeps its BFS slot (depth 1), NOT (0,0) and NOT glued to a.
    expect(b.y).toBeGreaterThan(0);
  });

  it("grows the canvas to contain a node dragged beyond the derived bounds", () => {
    const nodes: FlowNode[] = [
      { id: "a", type: "send_email" },
      { id: "b", type: "exit", position: { x: 2000, y: 1500 } },
    ];
    const layout = computeFlowLayout(nodes, [{ from: "a", to: "b" }], "a");

    // Without this the node is unreachable: it renders outside the scroll area.
    expect(layout.width).toBeGreaterThan(2000);
    expect(layout.height).toBeGreaterThan(1500);
  });

  it("ignores a malformed position rather than pinning the node at NaN", () => {
    const nodes: FlowNode[] = [
      // a hand-edited / older graph could carry junk here
      { id: "a", type: "exit", position: { x: "nope", y: null } as never },
    ];
    const layout = computeFlowLayout(nodes, [], "a");
    const a = layout.nodes.get("a")!;
    expect(Number.isFinite(a.x)).toBe(true);
    expect(Number.isFinite(a.y)).toBe(true);
    expect(a.pinned).toBe(false);
  });

  it("clamps hostile stored coordinates to the finite canvas boundary", () => {
    const nodes: FlowNode[] = [
      { id: "a", type: "exit", position: { x: -500, y: 1_000_000_000 } },
    ];
    const layout = computeFlowLayout(nodes, [], "a");
    const a = layout.nodes.get("a")!;

    expect(a.x).toBe(0);
    expect(a.y).toBe(MAX_CANVAS_COORDINATE);
    expect(layout.height).toBeLessThanOrEqual(MAX_CANVAS_COORDINATE + 200);
  });
});

describe("snapToGrid", () => {
  it("snaps to the grid so dragged nodes stay visually aligned", () => {
    expect(snapToGrid(103)).toBe(104); // GRID = 8
    expect(snapToGrid(100)).toBe(104);
    expect(snapToGrid(99)).toBe(96);
  });

  it("never returns a negative coordinate", () => {
    expect(snapToGrid(-50)).toBe(0);
  });

  it("never returns a coordinate above the canvas ceiling", () => {
    expect(snapToGrid(Number.MAX_SAFE_INTEGER)).toBe(MAX_CANVAS_COORDINATE);
  });
});
