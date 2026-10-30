// SPDX-License-Identifier: AGPL-3.0-only
//
// FLOW-010 — deterministic structural walk of a stored flow graph. It describes
// configured nodes, message references, branches, and order; it is not live
// subscriber execution. Pure + unit-tested so the preview cannot drift from
// what a simple graph reader would conclude while activation remains held.

import type { FlowGraph, FlowNode } from "@/lib/flows-api";

export interface JourneyStep {
  nodeId: string;
  type: string;
  /** Human label for the node kind (from the catalog when available). */
  label: string;
  /** Secondary description — template ref, wait duration, condition, etc. */
  detail: string;
  /** send_email template id, so the UI can offer a message preview. */
  templateId?: string;
  /** Indentation level; branch legs are nested under their fork. */
  depth: number;
  /** "Yes" / "No" / "Variant 2" … when this step is on a branch leg. */
  branchLabel?: string;
  /** Terminal annotation: loops back, dead-end, or missing target. */
  note?: string;
}

/** Resolves a send_email template id to the template's name, when known. */
export type TemplateNameResolver = (id: string) => string | undefined;

/** Whether a template's name is still being fetched (not known to be missing). */
export type TemplateNamePending = (id: string) => boolean;

// Guardrails so a malformed / cyclic graph can't run the walk away.
const MAX_STEPS = 200;

function continuationsOf(
  node: FlowNode,
  edges: FlowGraph["edges"],
): Array<{ to: string; label?: string }> {
  // Explicit condition legs win — a branch node routes via true_next/false_next.
  if (node.true_next != null || node.false_next != null) {
    const out: Array<{ to: string; label?: string }> = [];
    if (node.true_next) out.push({ to: node.true_next, label: "Yes" });
    if (node.false_next) out.push({ to: node.false_next, label: "No" });
    return out;
  }
  const outgoing = (edges ?? []).filter((e) => e.from === node.id);
  if (outgoing.length <= 1) {
    return outgoing.map((e) => ({ to: e.to }));
  }
  // A fan-out (percentage_split / ab_test / multi-edge) — label each leg.
  return outgoing.map((e, i) => ({ to: e.to, label: `Path ${i + 1}` }));
}

/**
 * Produce the ordered list of steps a subscriber traverses, depth-first,
 * expanding branch legs inline. `labelForType` maps a node type to its catalog
 * label; `templateName` names the templates send_email steps use.
 */
export function buildJourneySteps(
  graph: FlowGraph,
  labelForType: (type: string) => string,
  templateName?: TemplateNameResolver,
  templateNamePending?: TemplateNamePending,
): JourneyStep[] {
  const byId = new Map<string, FlowNode>();
  for (const n of graph.nodes ?? []) byId.set(n.id, n);

  const start =
    graph.entry_id && byId.has(graph.entry_id)
      ? graph.entry_id
      : (graph.nodes?.[0]?.id ?? "");

  const steps: JourneyStep[] = [];

  const walk = (
    nodeId: string,
    depth: number,
    branchLabel: string | undefined,
    onPath: Set<string>,
  ): void => {
    if (steps.length >= MAX_STEPS) return;
    if (!nodeId) return;
    const node = byId.get(nodeId);
    if (!node) {
      steps.push({
        nodeId,
        type: "missing",
        label: "Missing step",
        detail: `No node with id "${nodeId}"`,
        depth,
        branchLabel,
        note: "dead-end",
      });
      return;
    }
    if (onPath.has(nodeId)) {
      steps.push({
        nodeId,
        type: node.type,
        label: labelForType(node.type),
        detail: "",
        depth,
        branchLabel,
        note: `loops back to an earlier step`,
      });
      return;
    }

    steps.push({
      nodeId,
      type: node.type,
      label: labelForType(node.type),
      detail: describeNode(node, templateName, templateNamePending),
      templateId:
        node.type === "send_email" && typeof node.template_id === "string"
          ? node.template_id
          : undefined,
      depth,
      branchLabel,
    });

    const conts = continuationsOf(node, graph.edges);
    if (conts.length === 0) return; // natural end of this path
    const nextPath = new Set(onPath).add(nodeId);
    const branching = conts.length > 1;
    for (const c of conts) {
      walk(c.to, branching ? depth + 1 : depth, c.label, nextPath);
    }
  };

  walk(start, 0, undefined, new Set());
  return steps;
}

/**
 * describeNode renders the honest per-step detail from the authored fields.
 * A template is named, never identified by its id: the id means nothing to a
 * reader, and the step's "Preview email" action already carries it.
 */
export function describeNode(
  node: FlowNode,
  templateName?: TemplateNameResolver,
  templateNamePending?: TemplateNamePending,
): string {
  switch (node.type) {
    case "send_email": {
      if (!node.template_id) return "Sends an email (no template selected yet)";
      const id = String(node.template_id);
      const name = templateName?.(id)?.trim();
      if (name) return `Sends “${name}”`;
      // Until the lookup settles, an unknown name is not yet a failure.
      if (templateNamePending?.(id)) {
        return "Sends an email (loading the template name…)";
      }
      return "Sends an email from a template that couldn’t be loaded";
    }
    case "send_sms":
      return node.sms_body
        ? `Sends an SMS: “${truncate(String(node.sms_body), 60)}”`
        : "Sends an SMS";
    case "wait":
    case "delay":
      return typeof node.duration_seconds === "number"
        ? `Waits ${humanizeSeconds(node.duration_seconds)}`
        : "Waits";
    case "wait_until_trigger":
      return "Waits until a trigger fires";
    case "branch":
      return "Forks the journey on a condition";
    case "percentage_split":
    case "ab_test":
      return "Splits the audience across paths";
    case "goal":
      return "Marks a goal — subscribers who reach it may exit early";
    case "exit":
      return "Ends the journey";
    case "action":
      return "Runs an action";
    case "coupon_assign":
      return "Assigns a coupon";
    default:
      return "";
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function humanizeSeconds(sec: number): string {
  if (sec <= 0) return "no time";
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const parts: string[] = [];
  if (days) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (mins && !days) parts.push(`${mins} min`);
  return parts.length ? parts.join(" ") : `${sec}s`;
}
