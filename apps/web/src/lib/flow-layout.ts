// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure, deterministic layered layout for the visual flow-builder.
//
// Nodes MAY carry an optional `position: {x, y}`. Auto-layout is the default —
// a freshly-built flow arranges itself, and a node you never touch keeps doing
// so — while a stored position is an explicit override ("pinned"). That split
// matters: previously the AST carried no coordinates at all, so the canvas
// re-derived them by BFS on every render and dragging a node was impossible.
//
// Auto-layout: BFS from the entry node assigns each node a depth (row); nodes at
// the same depth are spread across columns in discovery order. Branch successors
// (true_next / false_next) and linear edges both feed the adjacency, and the
// branch legs are surfaced as labelled display edges.
//
// The engine ignores `position` entirely — it is presentation, not semantics —
// and FlowGraph.Nodes is []map[string]any on the Go side, so it round-trips
// through save/load with no migration (pinned by a Go test).
//
// Kept dependency-free and side-effect-free so it unit-tests in node without a
// DOM and never reaches for a layout library (dagre/elk) the bundle would have
// to ship.

import type { FlowEdge, FlowNode } from "./flows-api";

export const NODE_W = 208;
export const NODE_H = 96;
export const GAP_X = 48;
export const GAP_Y = 72;
export const MARGIN = 40;
/** Drag snapping. Keeps hand-placed nodes visually aligned with auto-laid ones. */
export const GRID = 8;
/**
 * Hard ceiling for persisted coordinates. Keeping the canvas below this bound
 * prevents hostile/hand-edited graphs from allocating an enormous scroll and
 * SVG surface. Must match maxFlowCanvasCoordinate in the Go flow builder.
 */
export const MAX_CANVAS_COORDINATE = 16_384;

export function clampCanvasCoordinate(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(MAX_CANVAS_COORDINATE, Math.max(0, v));
}

/**
 * snapToGrid rounds a dragged coordinate onto the grid and clamps it to the
 * canvas: a negative coordinate would render the node outside the scroll area
 * where it cannot be grabbed again.
 */
export function snapToGrid(v: number): number {
  return clampCanvasCoordinate(Math.round(v / GRID) * GRID);
}

/**
 * readPosition extracts a usable {x, y} from a node, or null when the node has
 * none — or carries junk. A hand-edited or older graph can hold anything here,
 * and pinning a node at NaN would render it off-canvas forever.
 */
export function readPosition(node: FlowNode): { x: number; y: number } | null {
  const raw = (node as { position?: unknown }).position;
  if (!raw || typeof raw !== "object") return null;
  const { x, y } = raw as { x?: unknown; y?: unknown };
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: clampCanvasCoordinate(x), y: clampCanvasCoordinate(y) };
}

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  depth: number;
  col: number;
  /** True when the coordinates came from the node's stored position rather than
   *  from auto-layout. The canvas uses this to show a "pinned" affordance and to
   *  decide what "Auto-arrange" resets. Optional so callers that hand-build a
   *  LayoutNode (edgePath in tests) need not care. */
  pinned?: boolean;
}

export interface LayoutEdge {
  from: string;
  to: string;
  label?: string;
}

export interface FlowLayout {
  nodes: Map<string, LayoutNode>;
  edges: LayoutEdge[];
  width: number;
  height: number;
}

/**
 * deriveEdges builds the set of display edges from the linear `edges` array
 * plus each branch node's true_next / false_next legs. Dangling targets (an id
 * with no matching node) are dropped so the canvas never draws into the void.
 */
export function deriveEdges(
  nodes: FlowNode[],
  edges: FlowEdge[],
): LayoutEdge[] {
  const ids = new Set(nodes.map((n) => n.id));
  const seen = new Set<string>();
  const out: LayoutEdge[] = [];
  const push = (from: string, to: string, label?: string) => {
    if (!ids.has(from) || !ids.has(to)) return;
    const key = `${from}->${to}:${label ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ from, to, label });
  };
  for (const e of edges) push(e.from, e.to);
  for (const n of nodes) {
    if (n.type === "branch") {
      if (typeof n.true_next === "string" && n.true_next)
        push(n.id, n.true_next, "Yes");
      if (typeof n.false_next === "string" && n.false_next)
        push(n.id, n.false_next, "No");
    }
  }
  return out;
}

/**
 * computeFlowLayout positions nodes in a top-down layered graph. Depth is the
 * shortest hop count from the entry node (so cycles terminate); unreachable
 * nodes ("orphans" — e.g. a freshly-added node not yet connected) are parked in
 * a trailing row so they stay visible and editable.
 */
export function computeFlowLayout(
  nodes: FlowNode[],
  edges: FlowEdge[],
  entryId?: string,
): FlowLayout {
  const displayEdges = deriveEdges(nodes, edges);
  const adjacency = new Map<string, string[]>();
  for (const n of nodes) adjacency.set(n.id, []);
  for (const e of displayEdges) adjacency.get(e.from)?.push(e.to);

  const depth = new Map<string, number>();
  const root =
    entryId && nodes.some((n) => n.id === entryId) ? entryId : nodes[0]?.id;

  // BFS layering from the entry. Shortest-path depth keeps cycles bounded.
  if (root) {
    const queue: string[] = [root];
    depth.set(root, 0);
    while (queue.length) {
      const cur = queue.shift() as string;
      const d = depth.get(cur) ?? 0;
      for (const next of adjacency.get(cur) ?? []) {
        if (!depth.has(next)) {
          depth.set(next, d + 1);
          queue.push(next);
        }
      }
    }
  }

  // Park unreachable nodes one row below the deepest reachable node.
  let maxDepth = 0;
  for (const d of depth.values()) maxDepth = Math.max(maxDepth, d);
  const orphanDepth = depth.size > 0 ? maxDepth + 1 : 0;
  for (const n of nodes) {
    if (!depth.has(n.id)) depth.set(n.id, orphanDepth);
  }

  // Group by depth, preserving node insertion order for stable columns.
  const byDepth = new Map<number, string[]>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    const row = byDepth.get(d) ?? [];
    row.push(n.id);
    byDepth.set(d, row);
  }

  const layoutNodes = new Map<string, LayoutNode>();
  let maxCols = 0;
  let usedDepth = 0;
  for (const [d, row] of byDepth) {
    maxCols = Math.max(maxCols, row.length);
    usedDepth = Math.max(usedDepth, d);
    row.forEach((id, col) => {
      layoutNodes.set(id, {
        id,
        col,
        depth: d,
        x: MARGIN + col * (NODE_W + GAP_X),
        y: MARGIN + d * (NODE_H + GAP_Y),
        pinned: false,
      });
    });
  }

  // A stored position overrides the derived slot. The node keeps its depth/col
  // (edges still route from its layer) but renders where the operator put it.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const [id, ln] of layoutNodes) {
    const node = byId.get(id);
    if (!node) continue;
    const pos = readPosition(node);
    if (!pos) continue;
    ln.x = pos.x;
    ln.y = pos.y;
    ln.pinned = true;
  }

  let width =
    MARGIN * 2 +
    Math.max(1, maxCols) * NODE_W +
    Math.max(0, maxCols - 1) * GAP_X;
  let height = MARGIN * 2 + (usedDepth + 1) * NODE_H + usedDepth * GAP_Y;

  // Grow the canvas to contain hand-placed nodes. Without this, a node dragged
  // past the derived bounds renders outside the scroll area and can never be
  // grabbed again.
  for (const ln of layoutNodes.values()) {
    width = Math.max(width, ln.x + NODE_W + MARGIN);
    height = Math.max(height, ln.y + NODE_H + MARGIN);
  }

  return { nodes: layoutNodes, edges: displayEdges, width, height };
}

/**
 * reachableNodeIds returns the set of node ids reachable from the entry by
 * following display edges (linear + branch legs). Nodes NOT in this set are
 * orphans — they render but never execute — so the canvas can flag them
 * (FLOW-038). Mirrors the BFS in computeFlowLayout but exposes just membership.
 */
export function reachableNodeIds(
  nodes: FlowNode[],
  edges: FlowEdge[],
  entryId?: string,
): Set<string> {
  const displayEdges = deriveEdges(nodes, edges);
  const adjacency = new Map<string, string[]>();
  for (const n of nodes) adjacency.set(n.id, []);
  for (const e of displayEdges) adjacency.get(e.from)?.push(e.to);

  const root =
    entryId && nodes.some((n) => n.id === entryId) ? entryId : nodes[0]?.id;
  const seen = new Set<string>();
  if (!root) return seen;
  const queue: string[] = [root];
  seen.add(root);
  while (queue.length) {
    const cur = queue.shift() as string;
    for (const next of adjacency.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * edgePath returns an SVG cubic-bezier path between two laid-out nodes, exiting
 * the source's bottom-centre and entering the target's top-centre.
 */
export function edgePath(from: LayoutNode, to: LayoutNode): string {
  const sx = from.x + NODE_W / 2;
  const sy = from.y + NODE_H;
  const tx = to.x + NODE_W / 2;
  const ty = to.y;
  const midY = (sy + ty) / 2;
  return `M ${sx} ${sy} C ${sx} ${midY}, ${tx} ${midY}, ${tx} ${ty}`;
}
