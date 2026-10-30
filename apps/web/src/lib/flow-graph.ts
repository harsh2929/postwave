// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure, DOM-free presentation + logic helpers for the visual flow-builder.
// Kept side-effect-free so the graph-editing rules (labels, summaries, dirty
// detection, validation-to-node mapping, review/trigger gating) unit-test in
// node without a browser — correctness of graph editing is the thing that
// matters most on this surface.

import type {
  CatalogItem,
  ConditionFieldSpec,
  FlowGraph,
  FlowNode,
  ReEnrollment,
} from "./flows-api";

/** Badge variants the shared `Badge` primitive understands (kept local so this
 *  module stays free of a JSX import). */
export type FlowBadgeVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "outline"
  | "success"
  | "warning"
  | "info";

/**
 * FLOW-014: map a flow status to a *semantic* badge variant. `default` is
 * brand-red (--primary #C8102E) and reads as an error, so an active/live flow
 * must never use it; paused/draft/archived must be distinguishable.
 */
export function flowStatusBadgeVariant(status: string): FlowBadgeVariant {
  switch (status) {
    case "active":
      return "success";
    case "paused":
      return "warning";
    case "archived":
      return "outline";
    default:
      return "secondary"; // draft (and any unknown)
  }
}

/** Human comparator labels for condition summaries. */
const COMPARATOR_LABELS: Record<string, string> = {
  eq: "is",
  neq: "is not",
  contains: "contains",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  exists: "exists",
};

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function humanizeDuration(seconds: number): string {
  if (seconds % 86400 === 0) return `Wait ${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `Wait ${seconds / 3600}h`;
  if (seconds % 60 === 0) return `Wait ${seconds / 60}m`;
  return `Wait ${seconds}s`;
}

/** The catalog label for a node's type, falling back to the raw type. */
export function nodeTypeLabel(node: FlowNode, catalog: CatalogItem[]): string {
  return catalog.find((c) => c.key === node.type)?.label ?? node.type;
}

/**
 * FLOW-016: render a branch/goal condition with the human *field label* (from
 * the catalog) rather than the dotted key, e.g. "Predicted churn risk > 0.5"
 * instead of "custom.predicted_churn_risk gt 0.5".
 */
export function describeCondition(
  condition: unknown,
  conditionFields: ConditionFieldSpec[] = [],
): string {
  if (!condition || typeof condition !== "object") return "No condition set";
  const c = condition as Record<string, unknown>;
  const fieldKey = typeof c.field === "string" ? c.field : "";
  if (!fieldKey) return "No condition set";
  const label =
    conditionFields.find((f) => f.key === fieldKey)?.label ?? fieldKey;
  const comparator = typeof c.comparator === "string" ? c.comparator : "";
  const compLabel = COMPARATOR_LABELS[comparator] ?? comparator;
  if (comparator === "exists") return `${label} exists`.trim();
  const value = c.value == null ? "" : String(c.value);
  return `${label} ${compLabel} ${value}`.trim();
}

function actionSummary(action: unknown): string {
  if (!action || typeof action !== "object") return "No action set";
  const kind = (action as Record<string, unknown>).kind;
  if (typeof kind !== "string" || !kind) return "No action set";
  return kind.replace(/_/g, " ");
}

export interface NodeSummaryOptions {
  conditionFields?: ConditionFieldSpec[];
  /** Resolve a template id to its human name (FLOW-016). Absent → show the id. */
  resolveTemplateName?: (id: string) => string | undefined;
}

/**
 * FLOW-016: a one-line, human-readable summary of what a node does — the
 * template *name* (when resolvable), the SMS preview, the wait duration, or the
 * condition described with catalog labels.
 */
export function nodeSummary(
  node: FlowNode,
  opts: NodeSummaryOptions = {},
): string {
  switch (node.type) {
    case "send_email": {
      const id = typeof node.template_id === "string" ? node.template_id : "";
      if (!id) return "No template set";
      const name = opts.resolveTemplateName?.(id);
      return name ? name : `Template ${id}`;
    }
    case "send_sms":
      return typeof node.sms_body === "string" && node.sms_body
        ? truncate(node.sms_body, 32)
        : "No message set";
    case "wait":
      return typeof node.duration_seconds === "number"
        ? humanizeDuration(node.duration_seconds)
        : "No delay set";
    case "branch":
      return describeCondition(node.condition, opts.conditionFields);
    case "goal":
      return describeCondition(node.goal, opts.conditionFields);
    case "action":
      return actionSummary(node.action);
    default:
      return "";
  }
}

const UNSET_SUMMARY = /^No .+ set$/;

/**
 * FLOW-015: label for a node in a connection dropdown — the human catalog label
 * plus a summary, so three `send_email` steps read as
 * "Email — Welcome" / "Email — Day 3" rather than three identical
 * "send_email (n_ab12cd)". Falls back to the id only when the node is
 * unconfigured (still distinguishable, still human-led).
 */
export function nodeOptionLabel(
  node: FlowNode,
  catalog: CatalogItem[],
  opts: NodeSummaryOptions = {},
): string {
  const label = nodeTypeLabel(node, catalog);
  const summary = nodeSummary(node, opts);
  if (summary && !UNSET_SUMMARY.test(summary)) return `${label} — ${summary}`;
  return `${label} · ${node.id}`;
}

/** FLOW-019: does the graph have at least one usable trigger? */
export function hasTrigger(graph: FlowGraph): boolean {
  return (graph.triggers ?? []).some(
    (t) => typeof t.type === "string" && t.type.length > 0,
  );
}

/** Remove a step and every route into it, including split variants. */
export function removeFlowNode(graph: FlowGraph, id: string): FlowGraph {
  const nodes = graph.nodes
    .filter((node) => node.id !== id)
    .map((node) => {
      const next = { ...node };
      if (next.true_next === id) delete next.true_next;
      if (next.false_next === id) delete next.false_next;
      if (Array.isArray(next.variants)) {
        next.variants = next.variants.map((variant: Record<string, unknown>) =>
          variant.next === id ? { ...variant, next: "" } : variant,
        );
      }
      return next;
    });
  return {
    ...graph,
    nodes,
    edges: (graph.edges ?? []).filter(
      (edge) => edge.from !== id && edge.to !== id,
    ),
    entry_id: graph.entry_id === id ? nodes[0]?.id : graph.entry_id,
  };
}

/** FLOW-022: short summary of what starts a flow, for the list card. */
export function triggerSummary(
  graph: FlowGraph,
  triggerCatalog: CatalogItem[],
): string {
  const triggers = (graph.triggers ?? []).filter(
    (t) => typeof t.type === "string" && t.type,
  );
  if (triggers.length === 0) return "No trigger";
  const first =
    triggerCatalog.find((c) => c.key === triggers[0].type)?.label ??
    String(triggers[0].type);
  return triggers.length === 1
    ? first
    : `${first} +${triggers.length - 1} more`;
}

/** FLOW-027: nodes whose catalog entry is marked `requires_review`. */
export function nodeRequiresReview(
  node: FlowNode,
  catalog: CatalogItem[],
): boolean {
  return catalog.find((c) => c.key === node.type)?.requires_review === true;
}

export function nodesRequiringReview(
  nodes: FlowNode[],
  catalog: CatalogItem[],
): FlowNode[] {
  return nodes.filter((n) => nodeRequiresReview(n, catalog));
}

/**
 * FLOW-023: map a set of validation error strings to the node ids they refer
 * to, so the canvas can flag exactly those nodes. Errors phrase ids as
 * `node "x": duplicate id`; we also match a bare id token appearing anywhere.
 */
export function errorNodeIds(
  errors: string[] | undefined,
  nodes: FlowNode[],
): Set<string> {
  const ids = new Set(nodes.map((n) => n.id));
  const out = new Set<string>();
  for (const err of errors ?? []) {
    for (const m of err.matchAll(/["'`]([^"'`]+)["'`]/g)) {
      if (ids.has(m[1])) out.add(m[1]);
    }
    for (const id of ids) {
      // Word-boundaryish: avoid matching an id that is a substring of another.
      if (new RegExp(`(^|[^\\w-])${escapeRegExp(id)}([^\\w-]|$)`).test(err)) {
        out.add(id);
      }
    }
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface FlowEditableState {
  name: string;
  reEnrollment: ReEnrollment;
  cooldownHours: number;
  graph: FlowGraph;
}

/**
 * FLOW-002 / FLOW-012: a canonical serialization of the editable flow state
 * used to detect unsaved changes. Cooldown hours only participate when the
 * policy is "cooldown" (so toggling hours while on "once" is not "dirty").
 * Same-shaped states produce identical strings because every state passes
 * through the editor's own construction, keeping key order stable.
 */
export function serializeFlowState(state: FlowEditableState): string {
  return JSON.stringify({
    name: state.name.trim(),
    reEnrollment: state.reEnrollment,
    cooldownHours:
      state.reEnrollment === "cooldown" ? state.cooldownHours : null,
    graph: {
      entry_id: state.graph.entry_id ?? null,
      triggers: state.graph.triggers ?? [],
      nodes: state.graph.nodes ?? [],
      edges: state.graph.edges ?? [],
      goals: state.graph.goals ?? [],
    },
  });
}
