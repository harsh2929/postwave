/**
 * segmentAst — render a segment's stored rule tree as bounded, readable
 * lines.
 *
 * The AST is untrusted network data (part of it can be LLM-authored, via
 * POST /api/v1/segments/compile-from-text). Recursing over it unbounded to
 * build React nodes is how you turn a malformed tree into a blank screen or
 * a stack overflow, so this walk is depth-, node- and fanout-capped in the
 * same spirit as desktop's `validateNLCompiledAST` — but it never throws:
 * a segment you can't fully describe should still show its name and size.
 *
 * Node shape (apps/api/internal/segments/ast_validation.go):
 *   { op: "and" | "or", children: Node[] }
 *   { op: "not", child: Node }
 *   { op: "condition", field, comparator, value }
 *
 * Pure + RN-free.
 */
import { pathLabel } from "./direction";


export const AST_MAX_DEPTH = 8;
export const AST_MAX_NODES = 60;

export interface AstLine {
  /** Indent level for rendering. */
  depth: number;
  text: string;
}

const COMPARATOR_WORDS: Record<string, string> = {
  "=": "is",
  eq: "is",
  equals: "is",
  "!=": "is not",
  neq: "is not",
  not_equals: "is not",
  ">": "is more than",
  gt: "is more than",
  ">=": "is at least",
  gte: "is at least",
  "<": "is less than",
  lt: "is less than",
  "<=": "is at most",
  lte: "is at most",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  in: "is one of",
  not_in: "is not one of",
  is_null: "is empty",
  not_exists: "is empty",
  is_not_null: "is set",
  exists: "is set",
  before: "is before",
  after: "is after",
  between: "is between",
  in_last_days: "happened in the last (days)",
  added_in_last_days: "was added in the last (days)",
  removed_in_last_days: "was removed in the last (days)",
  more_than_days_ago: "was more than (days) ago",
  ever: "ever happened",
  never: "never happened",
  in_segment: "is in segment",
  not_in_segment: "is not in segment",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Field paths are dotted (`predictive.churn_risk`); humanise them lightly. */
export function humaniseField(field: string): string {
  return pathLabel(
    field.split(".").map((part) => part.replace(/_/g, " ")),
  );
}

/** Render a comparison value without ever dumping an unbounded blob. */
export function describeValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    return value.length > 60 ? `${value.slice(0, 57)}…` : value;
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, 5).map(describeValue).filter(Boolean);
    const more = value.length - head.length;
    return more > 0 ? `${head.join(", ")} +${more} more` : head.join(", ");
  }
  return "…";
}

function describeCondition(node: Record<string, unknown>): string {
  const field = typeof node.field === "string" ? node.field : "";
  const comparator =
    typeof node.comparator === "string" ? node.comparator.toLowerCase() : "";
  const word = COMPARATOR_WORDS[comparator] ?? comparator.replace(/_/g, " ");
  const value = describeValue(node.value);
  return [humaniseField(field) || "(field)", word, value]
    .filter(Boolean)
    .join(" ")
    .trim();
}

/**
 * Flatten the tree into indented lines. Always returns something: an
 * unreadable node becomes "(unreadable rule)" rather than nothing at all,
 * and the walk stops cleanly at the caps with a "…and more" marker.
 */
export function describeSegmentAst(ast: unknown): AstLine[] {
  const lines: AstLine[] = [];
  let nodes = 0;
  let truncated = false;

  function walk(value: unknown, depth: number): void {
    if (truncated) return;
    if (depth > AST_MAX_DEPTH || nodes >= AST_MAX_NODES) {
      truncated = true;
      return;
    }
    nodes += 1;
    if (!isRecord(value)) {
      lines.push({ depth, text: "(unreadable rule)" });
      return;
    }
    const op = typeof value.op === "string" ? value.op.toLowerCase() : "";
    if (op === "and" || op === "or") {
      const children = Array.isArray(value.children) ? value.children : [];
      lines.push({
        depth,
        text: op === "and" ? "All of:" : "Any of:",
      });
      for (const child of children) {
        walk(child, depth + 1);
        if (truncated) return;
      }
      return;
    }
    if (op === "not") {
      lines.push({ depth, text: "Not:" });
      walk(value.child ?? (Array.isArray(value.children) ? value.children[0] : null), depth + 1);
      return;
    }
    if (op === "condition" || (!op && typeof value.field === "string")) {
      lines.push({ depth, text: describeCondition(value) });
      return;
    }
    lines.push({ depth, text: op ? `${op.replace(/_/g, " ")}` : "(unreadable rule)" });
  }

  walk(ast, 0);
  if (truncated) {
    lines.push({ depth: 0, text: "…and more (open on desktop to see it all)" });
  }
  return lines;
}

/** A one-line summary for a row: "3 conditions" / "1 condition". */
export function countAstConditions(ast: unknown): number {
  let count = 0;
  let nodes = 0;
  function walk(value: unknown, depth: number): void {
    if (depth > AST_MAX_DEPTH || nodes >= AST_MAX_NODES) return;
    nodes += 1;
    if (!isRecord(value)) return;
    const op = typeof value.op === "string" ? value.op.toLowerCase() : "";
    if (op === "and" || op === "or") {
      const children = Array.isArray(value.children) ? value.children : [];
      for (const child of children) walk(child, depth + 1);
      return;
    }
    if (op === "not") {
      walk(value.child ?? (Array.isArray(value.children) ? value.children[0] : null), depth + 1);
      return;
    }
    count += 1;
  }
  walk(ast, 0);
  return count;
}
