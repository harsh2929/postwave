/**
 * lib/flowNodeDetail.ts — the one or two facts worth printing under a step.
 *
 * Import-free (node-testable).
 *
 * `FlowGraph.Nodes` is `[]map[string]any` server-side (flowbuilder.go:139), so
 * a node carries whatever the authoring surface put there. The catalog
 * (flowbuilder.go:476-540) declares which fields each node TYPE expects, and
 * this module reads exactly those — nothing is inferred from a key that merely
 * happens to be present.
 *
 * TWO RULES, BOTH LEARNED THE HARD WAY ELSEWHERE IN THIS APP
 *
 *  1. A MISSING REQUIRED FIELD IS ITS OWN FACT, NOT AN EMPTY LINE. The server's
 *     own validator (`missingRequiredFields`) treats a `send_email` with no
 *     `template_id` as a warning that makes the graph NON-executable — that
 *     node will fail for every subscriber who reaches it. Rendering nothing
 *     there would hide the single most useful thing a phone can tell someone
 *     debugging a flow. `incomplete` says so instead.
 *  2. NOTHING IS RENDERED AS ZERO. A `wait` with no `duration_seconds` is not
 *     "0s"; it is a wait whose duration was never set.
 *
 * Durations are formatted here rather than via lib/format's `duration()`
 * because that helper takes milliseconds and reaches for `Intl`; a flow delay
 * is authored in whole seconds and reads better as "3 days" than "3d 0h".
 */
import type { MobileFlowNode } from "@/lib/flowWire";

export interface FlowNodeFact {
  label: string;
  value: string;
  /** True when this fact is a required field the node is MISSING. */
  incomplete?: boolean;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A number, or null — and CRUCIALLY not "0 via coercion".
 *
 * The obvious one-liner (`Number(value)` guarded by `Number.isFinite`) turns
 * `null`, `undefined`, `""`, `[]` and `false` ALL into a perfectly finite 0.
 * For `duration_seconds` that renders a step whose delay nobody ever set as
 * "No delay" — a confident claim that the flow proceeds immediately — which is
 * precisely the "absence is not zero" failure rule 2 in this file's header
 * exists to ban. A numeric STRING is still tolerated, because an int64 is
 * sometimes stringified in transit, but only when it actually contains one.
 */
function finite(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const SECOND = 1;
const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;

/**
 * Whole-unit delay copy: "45 minutes", "3 days", "1 hour 30 minutes".
 * Returns null for a non-finite or negative input rather than "0 seconds",
 * because a delay that was never set is not a zero-length delay.
 */
export function flowDelayLabel(seconds: unknown): string | null {
  const total = finite(seconds);
  if (total === null || total < 0) return null;
  if (total === 0) return "No delay";
  const parts: string[] = [];
  const units: readonly [number, string][] = [
    [DAY, "day"],
    [HOUR, "hour"],
    [MINUTE, "minute"],
    [SECOND, "second"],
  ];
  let remaining = Math.round(total);
  for (const [size, noun] of units) {
    const count = Math.floor(remaining / size);
    if (count <= 0) continue;
    remaining -= count * size;
    parts.push(`${count} ${noun}${count === 1 ? "" : "s"}`);
    if (parts.length === 2) break;
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

function missing(label: string): FlowNodeFact {
  return { label, value: "not set", incomplete: true };
}

/**
 * Reads a `segment_condition`-shaped field. The engine's condition object is
 * free-form, so this reports its SHAPE ("2 rules") rather than pretending to
 * render a predicate a phone cannot safely paraphrase.
 */
function conditionFact(label: string, raw: unknown): FlowNodeFact {
  if (!isRecord(raw)) return missing(label);
  const rules = raw["rules"] ?? raw["conditions"] ?? raw["all"] ?? raw["any"];
  if (Array.isArray(rules)) {
    const count = rules.length;
    return { label, value: `${count} rule${count === 1 ? "" : "s"}` };
  }
  const field = text(raw["field"]) || text(raw["key"]);
  return field ? { label, value: field } : { label, value: "configured" };
}

/** Raw node payload — the engine's free-form step object. */
type RawNode = Record<string, unknown>;

/**
 * One extractor per node type.
 *
 * This was a single switch whose cyclomatic complexity ran past the budget as
 * the flow catalog grew — and a switch is the wrong shape for it: every arm is
 * independent, so the branching was accidental rather than meaningful. A table
 * makes each node type a small named function that can be read (and, when it
 * earns a test, tested) on its own, and adding the next node type costs one
 * entry instead of one more branch through a function nobody can hold in head.
 *
 * A type absent from this table contributes NO facts — which is the honest
 * answer for a step this build does not understand, and is what keeps an
 * unknown node rendering as a plain titled row rather than as broken.
 */
const NODE_FACTS: Record<string, (raw: RawNode) => FlowNodeFact[]> = {
  wait: (raw) => {
    const label = flowDelayLabel(raw["duration_seconds"]);
    const facts = [label ? { label: "Waits", value: label } : missing("Waits")];
    // Send-time optimisation changes WHEN this fires, so it belongs beside the
    // delay rather than a tap away.
    if (text(raw["delay_strategy"]) === "optimized") {
      facts.push({ label: "Timing", value: "Send-time optimised" });
    }
    return facts;
  },
  wait_until: (raw) => {
    const until = text(raw["wait_until"]);
    return [until ? { label: "Until", value: until } : missing("Until")];
  },
  wait_until_trigger: (raw) => {
    const trigger = isRecord(raw["wait_trigger"])
      ? text(raw["wait_trigger"]["type"])
      : "";
    return [
      trigger ? { label: "Waits for", value: trigger } : missing("Waits for"),
    ];
  },
  send_email: (raw) => {
    const template = text(raw["template_id"]);
    return [
      template ? { label: "Template", value: template } : missing("Template"),
    ];
  },
  send_sms: (raw) => {
    const body = text(raw["sms_body"]);
    return [body ? { label: "Message", value: body } : missing("Message")];
  },
  branch: (raw) => [conditionFact("Condition", raw["condition"])],
  goal: (raw) => [conditionFact("Goal", raw["goal"])],
  percentage_split: (raw) => variantFacts(raw),
  ab_test: (raw) => variantFacts(raw),
  webhook: (raw) => {
    const url = text(raw["webhook_url"]);
    const facts = [
      url ? { label: "Posts to", value: url } : missing("Posts to"),
    ];
    const method = text(raw["webhook_method"]);
    if (method) facts.push({ label: "Method", value: method.toUpperCase() });
    return facts;
  },
  action: (raw) => {
    const kind = isRecord(raw["action"]) ? text(raw["action"]["kind"]) : "";
    return [kind ? { label: "Does", value: kind } : missing("Does")];
  },
  coupon_assign: (raw) => {
    const pool = isRecord(raw["metadata"])
      ? text(raw["metadata"]["coupon_pool_id"])
      : "";
    return [pool ? { label: "Pool", value: pool } : missing("Pool")];
  },
};

/** Shared by percentage_split and ab_test — the same shape, two names. */
function variantFacts(raw: RawNode): FlowNodeFact[] {
  const variants = Array.isArray(raw["variants"]) ? raw["variants"] : null;
  if (!variants) return [missing("Variants")];
  return [
    {
      label: "Variants",
      value: `${variants.length} variant${variants.length === 1 ? "" : "s"}`,
    },
  ];
}

/**
 * The facts worth showing under one step, at most two.
 *
 * Two is the ceiling on purpose: this list is scanned, not studied, and a
 * third line pushes the next step below the fold on a small phone. The full
 * node object stays one tap away on desktop, which is where a flow is edited.
 */
export function flowNodeFacts(node: MobileFlowNode): readonly FlowNodeFact[] {
  return NODE_FACTS[node.type]?.(node.raw) ?? [];
}

/** True when any required field this node's catalog entry declares is absent. */
export function flowNodeIncomplete(node: MobileFlowNode): boolean {
  return flowNodeFacts(node).some((fact) => fact.incomplete === true);
}
