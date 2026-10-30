// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure structural diff between two flow graphs (FLOW-024 / FLOW-045). Used to
// show what a version restore would change before it overwrites the working
// draft, and to compare two version snapshots. DOM-free for node unit tests.

import type { FlowGraph, FlowNode } from "./flows-api";

export interface GraphDiff {
  /** node ids present in `next` but not in `base`. */
  addedNodes: string[];
  /** node ids present in `base` but not in `next`. */
  removedNodes: string[];
  /** node ids present in both but whose serialized body differs. */
  changedNodes: string[];
  nodeCountDelta: number;
  triggerCountDelta: number;
  entryChanged: boolean;
  /** True when nothing structural differs. */
  identical: boolean;
}

function indexNodes(nodes: FlowNode[] | undefined): Map<string, FlowNode> {
  const m = new Map<string, FlowNode>();
  for (const n of nodes ?? []) m.set(n.id, n);
  return m;
}

/**
 * Diff `next` against `base` (e.g. a version snapshot against the current
 * draft). Node bodies are compared by canonical-key JSON so field edits are
 * detected regardless of key insertion order.
 */
export function diffGraphs(base: FlowGraph, next: FlowGraph): GraphDiff {
  const baseNodes = indexNodes(base.nodes);
  const nextNodes = indexNodes(next.nodes);

  const addedNodes: string[] = [];
  const removedNodes: string[] = [];
  const changedNodes: string[] = [];

  for (const [id, node] of nextNodes) {
    const prev = baseNodes.get(id);
    if (!prev) {
      addedNodes.push(id);
    } else if (stableStringify(node) !== stableStringify(prev)) {
      changedNodes.push(id);
    }
  }
  for (const id of baseNodes.keys()) {
    if (!nextNodes.has(id)) removedNodes.push(id);
  }

  const nodeCountDelta = (next.nodes?.length ?? 0) - (base.nodes?.length ?? 0);
  const triggerCountDelta =
    (next.triggers?.length ?? 0) - (base.triggers?.length ?? 0);
  const entryChanged = (base.entry_id ?? "") !== (next.entry_id ?? "");

  return {
    addedNodes,
    removedNodes,
    changedNodes,
    nodeCountDelta,
    triggerCountDelta,
    entryChanged,
    identical:
      addedNodes.length === 0 &&
      removedNodes.length === 0 &&
      changedNodes.length === 0 &&
      triggerCountDelta === 0 &&
      !entryChanged,
  };
}

/** JSON with object keys sorted recursively, so equal values stringify equally
 *  regardless of key order. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Short human summary of a diff for a one-line label. */
export function summarizeDiff(diff: GraphDiff): string {
  if (diff.identical) return "No changes";
  const parts: string[] = [];
  if (diff.addedNodes.length) parts.push(`+${diff.addedNodes.length} added`);
  if (diff.removedNodes.length)
    parts.push(`-${diff.removedNodes.length} removed`);
  if (diff.changedNodes.length)
    parts.push(`${diff.changedNodes.length} changed`);
  if (diff.triggerCountDelta !== 0) {
    parts.push(
      `${diff.triggerCountDelta > 0 ? "+" : ""}${diff.triggerCountDelta} trigger${
        Math.abs(diff.triggerCountDelta) === 1 ? "" : "s"
      }`,
    );
  }
  return parts.join(" · ") || "Structure changed";
}
