/**
 * lib/flowTopology.ts — turning a flow GRAPH into a readable vertical list,
 * and saying out loud which rule produced the order.
 *
 * Import-free (node-testable). Companion to lib/flowWire.ts, which parses.
 *
 * WHY MOBILE DOES NOT DRAW A CANVAS. apps/web ships a real 2-D flow editor
 * (flow-editor.tsx + flow-layout.ts, BFS layout with draggable pinned
 * coordinates). Reproducing that on a 390pt viewport produces a diagram you
 * navigate rather than read. app/(tabs)/sequences/[id].tsx already settled
 * this question for the older journey subsystem: a vertical tile column,
 * read-only, indented for branch legs. This module is the same answer for
 * flows, with one addition that matters more here than it did there —
 *
 * THE ORDER IS AN ADMISSION, NOT A GUESS. Three different things can be true
 * of a stored flow, and they are NOT interchangeable:
 *
 *   "entry"       — `graph.entry_id` names a node that exists. The walk starts
 *                   exactly where the engine would start. This is the only
 *                   case where the rendered order is the EXECUTION order.
 *   "roots"       — no usable entry_id, but the graph has nodes nothing points
 *                   at. Those are the only defensible starting points, and the
 *                   result is a plausible reading order, not the engine's.
 *   "declaration" — no entry, no roots (every node has an inbound edge: a ring,
 *                   or a graph wired entirely by hand). Nothing can be inferred,
 *                   so the stored array order is shown UNCHANGED.
 *
 * `FlowTopology.origin` carries which one happened so the UI can say it. A
 * screen that silently renders case 3 as if it were case 1 is asserting an
 * execution order the server never claimed — the exact class of fabrication
 * the "absence is not zero" rule exists to prevent.
 *
 * UNREACHABLE NODES ARE SHOWN, NOT DROPPED. A node the walk never visits is
 * still stored, still counted by the server's own validator, and is usually
 * the whole reason someone opened the flow on their phone ("why did this stop
 * firing?"). They are appended, flagged, and counted.
 *
 * Labels mirror flowbuilder.go's `Catalog()` (:476-540) key-for-key. Unknown
 * keys fall back to the raw key rather than to "Unknown step": a graph written
 * by a newer server must not be described by an older phone as broken.
 */
import type { MobileFlow, MobileFlowNode } from "@/lib/flowWire";

/* ------------------------------------------------------------------ */
/* labels — mirror of flowbuilder.go Catalog()                         */
/* ------------------------------------------------------------------ */

const NODE_LABELS: Readonly<Record<string, string>> = {
  wait: "Time delay",
  wait_until: "Wait until date",
  wait_until_trigger: "Wait until event",
  send_email: "Email message",
  send_sms: "SMS message",
  branch: "Conditional split",
  percentage_split: "Percentage split",
  ab_test: "A/B test",
  webhook: "Webhook",
  action: "Profile/list action",
  goal: "Goal",
  manual_review: "Manual review",
  coupon_assign: "Assign coupon",
  exit: "Exit",
};

const TRIGGER_LABELS: Readonly<Record<string, string>> = {
  list_joined: "Joined list",
  tag_added: "Tag added",
  tag_removed: "Tag removed",
  segment_joined: "Entered segment",
  product_event: "Product event",
  subscriber_opened_email: "Opened email",
  subscriber_clicked_link: "Clicked link",
  subscriber_delivered_email: "Delivered email",
  subscriber_did_not_open: "Did not open",
  inbound_webhook: "Inbound webhook",
  email_reply: "Email reply",
  date_field: "Profile date",
};

/** Human key → label, falling back to the raw key (never to "Unknown"). */
export function flowNodeLabel(type: string): string {
  return NODE_LABELS[type] ?? (type || "Step");
}

export function flowTriggerLabel(type: string): string {
  return TRIGGER_LABELS[type] ?? (type || "Trigger");
}

/**
 * Nodes whose whole job is to pause. Worth a distinct affordance because a
 * reader scanning "why is nobody getting this email" is looking for exactly
 * these.
 */
const WAIT_TYPES = new Set(["wait", "wait_until", "wait_until_trigger"]);
/** Nodes that send something to a human. */
const MESSAGE_TYPES = new Set(["send_email", "send_sms"]);
/** Nodes with more than one outgoing leg. */
const SPLIT_TYPES = new Set(["branch", "percentage_split", "ab_test"]);

export type FlowNodeKind = "wait" | "message" | "split" | "control" | "action";

export function flowNodeKind(type: string): FlowNodeKind {
  if (WAIT_TYPES.has(type)) return "wait";
  if (MESSAGE_TYPES.has(type)) return "message";
  if (SPLIT_TYPES.has(type)) return "split";
  if (type === "exit" || type === "manual_review" || type === "goal") {
    return "control";
  }
  return "action";
}

/* ------------------------------------------------------------------ */
/* status                                                              */
/* ------------------------------------------------------------------ */

export type FlowStatusTone = "neutral" | "success" | "warning" | "info";

export interface FlowStatusPresentation {
  label: string;
  tone: FlowStatusTone;
  /** The exact sentence a screen reader receives. State is never colour-alone. */
  spoken: string;
}

/**
 * THE STATUS PILL TAKES THE RUNTIME AS AN ARGUMENT, AND THAT IS THE WHOLE
 * POINT OF THIS FUNCTION.
 *
 * `status` is a column. Whether anything is EXECUTING is a completely separate
 * fact carried by the server's own runtime descriptor, and today it is always
 * false: `flowbuilder.go:27` declares `flowRuntimeQualified = false`,
 * `ActivateFlow` (:468) does nothing but 503, `CreateFlow` refuses any status
 * but draft, and `UpdateFlow` 503s the moment the target status is "active".
 * A flow row reading "active" is therefore a HISTORICAL label on something
 * that is not running and through which no subscriber is moving.
 *
 * Painting that as a green "Active" pill is the single most damaging claim
 * this screen could make — it is the exact failure
 * __tests__/sequences-runtime-truth.native.test.tsx pins for the older
 * journey subsystem, where the fix was to say "Legacy active label" out loud.
 * Passing `executing` in keeps the honest wording impossible to forget, and
 * keeps the pill truthful on the day the runtime is finally enabled.
 */
export function flowStatusPresentation(
  status: string,
  executing: boolean,
): FlowStatusPresentation {
  switch (status.trim().toLowerCase()) {
    case "active":
      return executing
        ? {
            label: "Active",
            tone: "success",
            spoken: "Active, and the flow runtime is running it.",
          }
        : {
            label: "Legacy active",
            tone: "warning",
            spoken:
              "Labelled active, but the flow runtime is unavailable, so it is not running and no subscriber is moving through it.",
          };
    case "paused":
      return {
        label: "Paused",
        tone: "warning",
        spoken: executing
          ? "Paused. Subscribers already inside stay where they are."
          : "Paused. The flow runtime is unavailable in any case, so nothing is executing.",
      };
    case "draft":
      return {
        label: "Draft",
        tone: "info",
        spoken: "Draft. It has never been published.",
      };
    case "archived":
      return {
        label: "Archived",
        tone: "neutral",
        spoken: "Archived. It is kept for the record only.",
      };
    default:
      // Never guess. An unrecognised status is shown verbatim so an operator
      // can report exactly what their workspace returned.
      return {
        label: status.trim() || "Unknown",
        tone: "neutral",
        spoken: `Status ${status.trim() || "unknown"}, which this app does not recognise.`,
      };
  }
}

/**
 * Whether ANY claim about execution is permitted on this surface. Absent
 * descriptor → contained, because the failure mode of guessing wrong in the
 * other direction is a screen telling an operator their abandoned-cart flow
 * is live when nothing has run in a year.
 */
export function flowRuntimeExecuting(
  runtime: { executionEnabled: boolean } | null,
): boolean {
  return runtime?.executionEnabled === true;
}

/** re_enrollment is a free string column; only three values are meaningful. */
export function reEnrollmentLabel(
  policy: string,
  cooldownHours: number | null,
): string {
  switch (policy.trim().toLowerCase()) {
    case "always":
      return "Can re-enter any time";
    case "cooldown":
      return cooldownHours === null
        ? "Can re-enter after a cooldown"
        : `Can re-enter after ${cooldownHours}h`;
    case "once":
      return "Enters once";
    case "":
      // The column has a server-side default of "once", but a row written
      // before that default existed can still be blank — and inventing
      // "Enters once" for it would state a policy nobody set.
      return "Re-entry policy not set";
    default:
      return policy.trim();
  }
}

/* ------------------------------------------------------------------ */
/* topology                                                            */
/* ------------------------------------------------------------------ */

export type FlowTopologyOrigin = "entry" | "roots" | "declaration";

export interface FlowTopologyRow {
  node: MobileFlowNode;
  /** Indent level; 0 for a start node. */
  depth: number;
  /** Which branch leg reached this node, when it was a branch. */
  leg: "true" | "false" | null;
  /** Node ids this node hands off to, in walk order. */
  nextIds: readonly string[];
  /** True when nothing in the graph leads here. */
  unreachable: boolean;
}

export interface FlowTopology {
  rows: readonly FlowTopologyRow[];
  origin: FlowTopologyOrigin;
  /** The entry node id ONLY when it resolved to a real node. */
  entryId: string | null;
  unreachableCount: number;
}

/** Max indent the vertical list will render; deeper legs stay at this depth. */
export const FLOW_TOPOLOGY_MAX_DEPTH = 6;

interface Successor {
  id: string;
  leg: "true" | "false" | null;
}

function successorsOf(
  node: MobileFlowNode,
  edgesByFrom: ReadonlyMap<string, readonly string[]>,
): readonly Successor[] {
  const out: Successor[] = [];
  const seen = new Set<string>();
  const push = (id: string | null, leg: "true" | "false" | null): void => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, leg });
  };
  // Branch legs first and in a fixed order: "true" above "false" is how the
  // condition reads in prose, and a stable order keeps the rendered column
  // identical across refetches.
  push(node.trueNext, "true");
  push(node.falseNext, "false");
  for (const to of edgesByFrom.get(node.id) ?? []) push(to, null);
  return out;
}

/**
 * Depth-first pre-order, so a branch's consequences sit directly under it —
 * the reading order a person uses when tracing "and then what happened".
 * Breadth-first would interleave the two legs of a split, which is exactly
 * the question the reader is trying to answer.
 */
export function buildFlowTopology(flow: MobileFlow | null): FlowTopology {
  const nodes = flow?.nodes ?? [];
  if (nodes.length === 0) {
    return { rows: [], origin: "declaration", entryId: null, unreachableCount: 0 };
  }
  const byId = new Map(nodes.map((node) => [node.id, node] as const));

  const edgesByFrom = new Map<string, string[]>();
  const inbound = new Set<string>();
  for (const edge of flow?.edges ?? []) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    const bucket = edgesByFrom.get(edge.from);
    if (bucket) bucket.push(edge.to);
    else edgesByFrom.set(edge.from, [edge.to]);
    inbound.add(edge.to);
  }
  for (const node of nodes) {
    for (const leg of [node.trueNext, node.falseNext]) {
      if (leg && byId.has(leg)) inbound.add(leg);
    }
  }

  const entryId =
    flow?.entryId && byId.has(flow.entryId) ? flow.entryId : null;
  const roots = nodes.filter((node) => !inbound.has(node.id));

  let origin: FlowTopologyOrigin;
  let starts: readonly MobileFlowNode[];
  if (entryId) {
    origin = "entry";
    starts = [byId.get(entryId)!];
  } else if (roots.length > 0) {
    origin = "roots";
    starts = roots;
  } else {
    origin = "declaration";
    starts = [];
  }

  const rows: FlowTopologyRow[] = [];
  const visited = new Set<string>();

  // An EXPLICIT stack, not recursion. `Validate` bounds neither node count nor
  // chain length, and a flow generated by the AI drafting routines can be a
  // long single chain — deep enough to exhaust the JS call stack and take the
  // whole screen down with a RangeError. Popping from a stack and pushing
  // successors in reverse reproduces recursive pre-order EXACTLY, so a branch's
  // consequences still sit directly under it and the "true" leg still prints
  // above the "false" one.
  const stack: {
    node: MobileFlowNode;
    depth: number;
    leg: "true" | "false" | null;
  }[] = [];
  for (let i = starts.length - 1; i >= 0; i -= 1) {
    stack.push({ node: starts[i]!, depth: 0, leg: null });
  }

  while (stack.length > 0) {
    const frame = stack.pop()!;
    // A cycle is legal in a stored graph (nothing rejects one) and must not
    // hang the render; visiting once is also what makes each node exactly one
    // row, which is what a list can key on.
    if (visited.has(frame.node.id)) continue;
    visited.add(frame.node.id);
    const successors = successorsOf(frame.node, edgesByFrom);
    rows.push({
      node: frame.node,
      depth: Math.min(frame.depth, FLOW_TOPOLOGY_MAX_DEPTH),
      leg: frame.leg,
      nextIds: successors.map((s) => s.id),
      unreachable: false,
    });
    for (let i = successors.length - 1; i >= 0; i -= 1) {
      const successor = successors[i]!;
      const next = byId.get(successor.id);
      if (next) {
        stack.push({ node: next, depth: frame.depth + 1, leg: successor.leg });
      }
    }
  }

  // Everything the walk could not reach, in the order the server stored it.
  const orphans = nodes.filter((node) => !visited.has(node.id));
  for (const node of orphans) {
    rows.push({
      node,
      depth: 0,
      leg: null,
      nextIds: successorsOf(node, edgesByFrom).map((s) => s.id),
      // In the "declaration" case NOTHING was walked, so calling every node
      // unreachable would be a false alarm about a perfectly ordinary graph.
      unreachable: origin !== "declaration",
    });
  }

  return {
    rows,
    origin,
    entryId,
    unreachableCount: rows.filter((row) => row.unreachable).length,
  };
}

/** One sentence explaining what the vertical order actually is. */
export function flowTopologyOrderNote(topology: FlowTopology): string {
  switch (topology.origin) {
    case "entry":
      return "Ordered from the flow's entry step, following each branch.";
    case "roots":
      return "This flow names no entry step, so the order starts from the steps nothing points at.";
    case "declaration":
      return "This flow names no entry step and every step has something pointing at it, so these are shown in stored order — not execution order.";
  }
}
