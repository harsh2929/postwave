/**
 * visual-segment-ast — pure build/validate logic for the visual segment
 * builder (Klaviyo-parity KLV-06). No React here; the UI in
 * VisualSegmentBuilder.tsx drives a plain editor tree through these
 * helpers, and the unit tests in src/__tests__/visual-segment-ast.test.ts
 * pin the AST shape so it stays in lockstep with the backend compiler
 * (apps/api/internal/segments/compile.go).
 *
 * The query AST node schema we emit (VERIFIED against compile.go):
 *   - Boolean group: { op: "and", children: Node[] }  |  { op: "or", … }
 *   - Negation:      { op: "not", child: Node }
 *   - Condition leaf:{ op: "condition", field, comparator, value }
 *
 * Value encoding (compile.go decodeScalar / decodeList /
 * predicates.ParseLifecycleValue):
 *   - number value_type   → number
 *   - boolean value_type  → boolean
 *   - in / not_in         → string[] (comma-separated input is split)
 *   - added_in_last_days /
 *     removed_in_last_days → { tag, days }  (BOTH a tag name and a day
 *                            count are required; a bare number is NOT
 *                            accepted by the lifecycle parser)
 *   - metric_aggregate value_type (SUB-028, event-count predicates):
 *       · numeric comparators (equals/gt/gte/lt/lte/not_equals)
 *                            → { count, days? }  (count required; days is
 *                              an optional rolling window — omit for
 *                              all-time)
 *       · in_last_days /
 *         more_than_days_ago → { days }  (the time window; the count
 *                              threshold is forced server-side — ≥1 for
 *                              "happened", =0 for "has NOT happened")
 *   - segment value_type (SUB-032, segment-of-segments):
 *       · in_segment / not_in_segment → string (the referenced canonical
 *                              segment id; the compiler resolves +
 *                              depth-checks the reference at compile time)
 *   - everything else     → string
 */

import type { PredicateDefinition } from "./segmentsClient";

/* ─── Editor tree (UI-facing, mutable) ─────────────────────────────── */

/** A single rule row in the editor. */
export interface ConditionRow {
  id: string;
  kind: "condition";
  /** Predicate key (PredicateDefinition.key). Empty until picked. */
  field: string;
  /** One of the picked predicate's comparators. Empty until picked. */
  comparator: string;
  /** Raw text the user typed (always a string in the editor state). */
  value: string;
  /**
   * Second input used only by the lifecycle comparators
   * (added_in_last_days / removed_in_last_days), which need a tag name
   * AND a day count. For those, `value` holds the tag and `days` holds
   * the window. Empty otherwise.
   */
  days?: string;
  /** Wrap this single row in a NOT. */
  negated?: boolean;
}

/** A boolean group: AND/OR over child rows and nested groups. */
export interface GroupNode {
  id: string;
  kind: "group";
  op: "and" | "or";
  children: EditorNode[];
  /** Wrap the whole group in a NOT. */
  negated?: boolean;
}

export type EditorNode = ConditionRow | GroupNode;

/* ─── Compiled AST (backend-facing) ────────────────────────────────── */

export type AstValue =
  | string
  | number
  | boolean
  | string[]
  | number[]
  | { tag: string; days: number }
  // SUB-028 metric aggregate: a threshold count over an optional rolling
  // window, OR (for the time-window comparators) just the window.
  | { count: number; days?: number }
  | { days: number };

export type AstNode =
  | { op: "and"; children: AstNode[] }
  | { op: "or"; children: AstNode[] }
  | { op: "not"; child: AstNode }
  | { op: "condition"; field: string; comparator: string; value: AstValue };

/* ─── Comparator classification ────────────────────────────────────── */

const LIST_COMPARATORS = new Set(["in", "not_in"]);
const LIFECYCLE_COMPARATORS = new Set([
  "added_in_last_days",
  "removed_in_last_days",
]);
// SUB-028 — the time-window comparators that metric.* aggregate
// predicates expose alongside the numeric ones. For these, the user only
// supplies the window (days); the count threshold is forced server-side
// (≥1 for "happened in last N days", =0 for "has NOT happened in N days").
const METRIC_WINDOW_COMPARATORS = new Set([
  "in_last_days",
  "more_than_days_ago",
]);

// SUB-028 — the registry value_type that flags a metric aggregate. These
// rows render a dual-input (count + optional days) control rather than a
// single scalar, mirroring the tag-lifecycle {tag, days} pattern.
const METRIC_AGGREGATE_VALUE_TYPE = "metric_aggregate";

// SUB-032 — the segment-of-segments comparators. The `segment_id`
// predicate (value_type "segment") matches subscribers who are (or are
// NOT) members of another canonical segment; the `value` carries the
// referenced segment id as a plain string. These rows render a
// segment-picker dropdown rather than a free-text input.
const SEGMENT_REF_COMPARATORS = new Set(["in_segment", "not_in_segment"]);

// SUB-032 — the registry value_type that flags a segment reference. A
// row with this value_type renders a segment-picker dropdown (the value
// is the referenced segment id).
const SEGMENT_VALUE_TYPE = "segment";

/**
 * Registry aliases that have a verified compiler equivalent. `between` is
 * deliberately omitted: the current compiler has no two-bound scalar shape,
 * so presenting it would let an operator build an audience that cannot run.
 */
const COMPILER_COMPARATOR_ALIASES: Record<string, string> = {
  before: "lt",
  after: "gt",
};
const UNSUPPORTED_REGISTRY_COMPARATORS = new Set(["between"]);

export function isListComparator(comparator: string): boolean {
  return LIST_COMPARATORS.has((comparator ?? "").toLowerCase());
}

export function isLifecycleComparator(comparator: string): boolean {
  return LIFECYCLE_COMPARATORS.has((comparator ?? "").toLowerCase());
}

/**
 * SUB-028 — the time-window comparators (in_last_days / more_than_days_ago)
 * a metric aggregate predicate exposes. These need only a day count; the
 * count threshold is supplied by the server.
 */
export function isMetricWindowComparator(comparator: string): boolean {
  return METRIC_WINDOW_COMPARATORS.has((comparator ?? "").toLowerCase());
}

/**
 * SUB-028 — true when a predicate's value_type is the metric aggregate
 * type, i.e. it wants a dual-input (count + optional window) value
 * control rather than a single scalar.
 */
export function isMetricAggregateValueType(valueType: string): boolean {
  return (valueType ?? "").toLowerCase() === METRIC_AGGREGATE_VALUE_TYPE;
}

/**
 * SUB-032 — the segment-of-segments comparators (in_segment /
 * not_in_segment). The value carries the referenced canonical segment id.
 */
export function isSegmentRefComparator(comparator: string): boolean {
  return SEGMENT_REF_COMPARATORS.has((comparator ?? "").toLowerCase());
}

/**
 * SUB-032 — true when a predicate's value_type is the segment-reference
 * type, i.e. it wants a segment-picker dropdown rather than a free-text
 * input. The chosen value is the referenced segment id.
 */
export function isSegmentValueType(valueType: string): boolean {
  return (valueType ?? "").toLowerCase() === SEGMENT_VALUE_TYPE;
}

/** Predicates the compiler can actually evaluate today. */
export function isSupportedPredicate(
  p: PredicateDefinition | undefined,
): boolean {
  return (p?.compiler_status ?? "").toLowerCase() === "supported";
}

/** The comparators usable for a predicate, defensively normalised. */
export function comparatorsFor(p: PredicateDefinition | undefined): string[] {
  return Array.isArray(p?.comparators)
    ? p.comparators.filter(
        (comparator) =>
          !UNSUPPORTED_REGISTRY_COMPARATORS.has(comparator.toLowerCase()),
      )
    : [];
}

export function compilerComparator(comparator: string): string {
  const normalized = comparator.toLowerCase();
  return COMPILER_COMPARATOR_ALIASES[normalized] ?? normalized;
}

/* ─── Value coercion ───────────────────────────────────────────────── */

/**
 * Split a comma-separated string into a trimmed, non-empty string list.
 * Mirrors compile.go decodeList's string-tolerance path so the editor and
 * server agree on the parse.
 */
export function splitList(raw: string): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Coerce a row's raw string value into the JSON shape the compiler
 * expects. Comparator wins over value_type for the special comparators
 * (lists + lifecycle); otherwise value_type drives the cast.
 *
 * Returns `null` when the value is unusable (empty, or a lifecycle row
 * missing its tag/days). Callers treat null as "incomplete".
 */
export function coerceValue(
  row: Pick<ConditionRow, "value" | "days" | "comparator">,
  valueType: string,
): AstValue | null {
  const comparator = (row.comparator ?? "").toLowerCase();
  const raw = row.value ?? "";

  if (isLifecycleComparator(comparator)) {
    const tag = raw.trim();
    const daysStr = (row.days ?? "").trim();
    if (!tag || daysStr === "") return null;
    const days = Number(daysStr);
    // Reject 0/negative: the backend turns days into `now() - 'N days'`, so
    // a negative N becomes a FUTURE window no historical row can match — a
    // silent permanently-empty segment. Make the row incomplete instead.
    if (!Number.isInteger(days) || days <= 0) return null;
    return { tag, days };
  }

  if (isListComparator(comparator)) {
    const list = splitList(raw);
    return list.length > 0 ? list : null;
  }

  const vt = (valueType ?? "").toLowerCase();

  // SUB-028 — metric aggregate (event count over an optional window).
  if (vt === METRIC_AGGREGATE_VALUE_TYPE) {
    const daysStr = (row.days ?? "").trim();
    // Parse the window when present; reject 0/negative/fractional — the
    // backend turns days into `now() - 'N days'`, so a non-positive N
    // becomes a future/empty window that silently matches nothing.
    let days: number | undefined;
    if (daysStr !== "") {
      const d = Number(daysStr);
      if (!Number.isInteger(d) || d <= 0) return null;
      days = d;
    }

    // Time-window comparators take ONLY the window; the count threshold
    // is forced server-side. Days is required for these.
    if (isMetricWindowComparator(comparator)) {
      if (days === undefined) return null;
      return { days };
    }

    // Numeric comparators: a required count threshold + an optional window.
    if (raw.trim() === "") return null;
    const count = Number(raw);
    if (!Number.isFinite(count)) return null;
    return days === undefined ? { count } : { count, days };
  }

  // SUB-032 — segment reference: the value is the referenced canonical
  // segment id (a plain string). An empty pick is incomplete.
  if (vt === SEGMENT_VALUE_TYPE) {
    const refId = raw.trim();
    return refId === "" ? null : refId;
  }

  if (vt === "number") {
    if (raw.trim() === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (vt === "boolean") {
    // The checkbox always yields "true"/"false"; treat anything else as
    // unset rather than guessing.
    if (raw === "true") return true;
    if (raw === "false") return false;
    return null;
  }

  // string / date / unknown → pass the trimmed text through.
  const s = raw.trim();
  return s === "" ? null : s;
}

/* ─── Completeness checks ──────────────────────────────────────────── */

/** Look up a predicate definition by key. */
function findPredicate(
  predicates: PredicateDefinition[],
  field: string,
): PredicateDefinition | undefined {
  if (!Array.isArray(predicates)) return undefined;
  return predicates.find((p) => p.key === field);
}

/** True when a single row has a field, a valid comparator, and a value. */
export function isRowComplete(
  row: ConditionRow,
  predicates: PredicateDefinition[],
): boolean {
  if (!row.field || !row.comparator) return false;
  const pred = findPredicate(predicates, row.field);
  if (!pred) return false;
  // The comparator must belong to this predicate.
  if (!comparatorsFor(pred).includes(row.comparator)) return false;
  return coerceValue(row, pred.value_type) !== null;
}

/**
 * True when every condition in the tree is complete and the tree has at
 * least one condition. An empty group (or a tree of only empty groups)
 * is NOT complete.
 */
export function isComplete(
  node: EditorNode,
  predicates: PredicateDefinition[],
): boolean {
  if (node.kind === "condition") {
    return isRowComplete(node, predicates);
  }
  const children = Array.isArray(node.children) ? node.children : [];
  if (children.length === 0) return false;
  return children.every((c) => isComplete(c, predicates));
}

/* ─── AST assembly ─────────────────────────────────────────────────── */

function wrapNot<T extends AstNode>(
  node: T,
  negated: boolean | undefined,
): AstNode {
  return negated ? { op: "not", child: node } : node;
}

/**
 * Build one node's AST, or null when it's empty/invalid. Incomplete
 * condition rows are dropped; an empty group collapses to null. A group
 * with a single surviving child unwraps to that child (but still honours
 * its own NOT wrapper).
 */
function buildNode(
  node: EditorNode,
  predicates: PredicateDefinition[],
): AstNode | null {
  if (node.kind === "condition") {
    if (!isRowComplete(node, predicates)) return null;
    const pred = findPredicate(predicates, node.field);
    if (!pred) return null;
    const value = coerceValue(node, pred.value_type);
    if (value === null) return null;
    const leaf: AstNode = {
      op: "condition",
      field: node.field,
      comparator: compilerComparator(node.comparator),
      value,
    };
    return wrapNot(leaf, node.negated);
  }

  const children = Array.isArray(node.children) ? node.children : [];
  const built = children
    .map((c) => buildNode(c, predicates))
    .filter((n): n is AstNode => n !== null);

  if (built.length === 0) return null;
  if (built.length === 1) {
    // Don't emit a degenerate single-child group; unwrap it but keep
    // this group's own NOT.
    return wrapNot(built[0]!, node.negated);
  }
  const group: AstNode = {
    op: node.op === "or" ? "or" : "and",
    children: built,
  };
  return wrapNot(group, node.negated);
}

/**
 * Build the final query AST from the editor tree, or null when the tree
 * is empty/invalid. This is what the modal sends to previewCount and
 * create.
 */
export function buildAst(
  root: EditorNode,
  predicates: PredicateDefinition[],
): AstNode | null {
  return buildNode(root, predicates);
}

/* ─── ID generation ────────────────────────────────────────────────── */

let idCounter = 0;

/** Stable, unique row/group id — never an array index (rows reorder). */
export function newId(prefix = "n"): string {
  idCounter += 1;
  return `${prefix}-${idCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A fresh, empty condition row. */
export function emptyRow(): ConditionRow {
  return {
    id: newId("row"),
    kind: "condition",
    field: "",
    comparator: "",
    value: "",
  };
}

/** A fresh, empty AND group. */
export function emptyGroup(op: "and" | "or" = "and"): GroupNode {
  return { id: newId("grp"), kind: "group", op, children: [] };
}
