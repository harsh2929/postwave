import type {
  SegmentComparator,
  SegmentNode,
  SegmentNutritionFacts,
} from "../lib/api-client";

const NL_AST_MAX_DEPTH = 12;
const NL_AST_MAX_NODES = 128;
const NL_AST_MAX_FANOUT = 32;
const NL_AST_MAX_VALUE_BYTES = 16 * 1024;
const NL_AST_MAX_VALUE_ITEMS = 64;

const NL_ALLOWED_COMPARATORS = new Set([
  "=",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "added_in_last_days",
  "after",
  "before",
  "between",
  "contains",
  "ends_with",
  "eq",
  "equals",
  "ever",
  "exists",
  "gt",
  "gte",
  "in",
  "in_last_days",
  "in_segment",
  "is_not_null",
  "is_null",
  "lt",
  "lte",
  "more_than_days_ago",
  "neq",
  "never",
  "not_contains",
  "not_equals",
  "not_exists",
  "not_in",
  "not_in_segment",
  "removed_in_last_days",
  "starts_with",
]);

export type NLASTValidationResult =
  | { ok: true; ast: SegmentNode; nodeCount: number }
  | { ok: false; error: string };

export interface NLCompileContext {
  status: string;
  query: string;
}

export const NL_DIRECTORY_SEARCH_BLOCKED_MESSAGE =
  "Clear the directory search before building an audience. Directory search spans names, email, tags, groups, and profile fields, so it cannot be converted into one exact audience rule without changing who matches.";

/**
 * Treat the compiler response as untrusted network data. The server validates
 * model output too, but this boundary prevents malformed or oversized trees
 * from reaching React recursion, saved-segment storage, or the preview API.
 */
export function validateNLCompiledAST(value: unknown): NLASTValidationResult {
  const budget = { nodes: 0 };
  try {
    const ast = validateNLNode(value, 0, budget);
    return { ok: true, ast, nodeCount: budget.nodes };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "The compiler returned an invalid audience rule.",
    };
  }
}

function validateNLNode(
  value: unknown,
  depth: number,
  budget: { nodes: number },
): SegmentNode {
  if (depth > NL_AST_MAX_DEPTH) {
    throw new Error("The compiled rule is too deeply nested to review safely.");
  }
  budget.nodes += 1;
  if (budget.nodes > NL_AST_MAX_NODES) {
    throw new Error(
      "The compiled rule contains too many conditions to review safely.",
    );
  }
  if (!isPlainRecord(value)) {
    throw new Error("The compiler returned a malformed audience rule.");
  }

  const operation = typeof value.op === "string" ? value.op.toLowerCase() : "";
  if (operation === "and" || operation === "or") {
    if (!Array.isArray(value.children) || value.child !== undefined) {
      throw new Error(
        `The ${operation.toUpperCase()} group has an invalid shape.`,
      );
    }
    if (value.children.length > NL_AST_MAX_FANOUT) {
      throw new Error(
        `The ${operation.toUpperCase()} group contains too many branches.`,
      );
    }
    return {
      op: operation,
      children: value.children.map((child) =>
        validateNLNode(child, depth + 1, budget),
      ),
    };
  }

  if (operation === "not") {
    const childFromArray = Array.isArray(value.children)
      ? value.children.length === 1
        ? value.children[0]
        : undefined
      : undefined;
    const hasChild = value.child !== undefined;
    if (
      (hasChild && value.children !== undefined) ||
      (!hasChild && childFromArray === undefined)
    ) {
      throw new Error("The NOT group must contain exactly one rule.");
    }
    return {
      op: "not",
      child: validateNLNode(
        hasChild ? value.child : childFromArray,
        depth + 1,
        budget,
      ),
    };
  }

  if (operation !== "condition") {
    throw new Error(
      "The compiler returned an unknown audience-rule operation.",
    );
  }
  if (value.child !== undefined || value.children !== undefined) {
    throw new Error("A condition cannot also contain nested audience rules.");
  }

  const field = typeof value.field === "string" ? value.field.trim() : "";
  const comparator =
    typeof value.comparator === "string"
      ? value.comparator.trim().toLowerCase()
      : "";
  if (!field || field.length > 160 || !/^[\w.:-]+$/u.test(field)) {
    throw new Error("The compiler returned an invalid audience field.");
  }
  if (!NL_ALLOWED_COMPARATORS.has(comparator)) {
    throw new Error(
      "The compiler returned an unsupported audience comparison.",
    );
  }
  validateNLValue(value.value, 0, new Set());
  return {
    op: "condition",
    field,
    comparator: comparator as SegmentComparator,
    value: value.value,
  };
}

function validateNLValue(
  value: unknown,
  depth: number,
  seen: Set<object>,
): void {
  if (depth > 8)
    throw new Error("A compiled condition value is too deeply nested.");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    if (
      typeof value === "string" &&
      new TextEncoder().encode(value).byteLength > NL_AST_MAX_VALUE_BYTES
    ) {
      throw new Error("A compiled condition value is too large.");
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("A compiled condition contains a non-finite number.");
    }
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) {
    throw new Error("A compiled condition contains an invalid value.");
  }
  seen.add(value);
  const items = Array.isArray(value) ? value : Object.values(value);
  if (items.length > NL_AST_MAX_VALUE_ITEMS) {
    throw new Error("A compiled condition value contains too many items.");
  }
  for (const item of items) validateNLValue(item, depth + 1, seen);
  seen.delete(value);
  let encoded = "";
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error("A compiled condition value cannot be reviewed safely.");
  }
  if (new TextEncoder().encode(encoded).byteLength > NL_AST_MAX_VALUE_BYTES) {
    throw new Error("A compiled condition value is too large.");
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Freeze the page filters into the same AST the operator reviews. This closes
 * the historic split-brain where the UI persisted filters beside the tree but
 * the server intentionally evaluated only `predicate_json.ast`.
 */
export function composeNLCompiledAST(
  compiled: SegmentNode,
  context: NLCompileContext,
): SegmentNode {
  if (context.query.trim()) {
    throw new Error(NL_DIRECTORY_SEARCH_BLOCKED_MESSAGE);
  }
  const children: SegmentNode[] = [];
  if (!isEmptyBooleanGroup(compiled)) children.push(compiled);

  const normalizedStatus = normalizeNLStatusCondition(context.status);
  // This page status is mandatory compile context. Always append it as a
  // positive top-level AND constraint: an identical-looking condition inside
  // an OR or NOT branch does not prove that the expression requires it.
  if (normalizedStatus) {
    children.push({
      op: "condition",
      field: normalizedStatus.field,
      comparator: "equals",
      value: normalizedStatus.value,
    });
  }
  if (children.length === 0) return { op: "and", children: [] };
  if (children.length === 1) return children[0] as SegmentNode;
  return { op: "and", children };
}

export function deriveNLSavedFilters(
  ast: SegmentNode,
  context: NLCompileContext,
): { status?: string } {
  const filters: { status?: string } = {};
  const normalizedStatus = normalizeNLStatusCondition(context.status);
  if (
    normalizedStatus &&
    containsNLCondition(
      ast,
      normalizedStatus.field,
      "equals",
      normalizedStatus.value,
    )
  ) {
    filters.status = context.status;
  }
  return filters;
}

export function normalizeNLStatus(status: string): string {
  return normalizeNLStatusCondition(status)?.value ?? "";
}

export function normalizeNLStatusCondition(
  status: string,
): { field: "status" | "mailchimp_status"; value: string } | null {
  switch (status.trim().toLowerCase()) {
    case "":
    case "all":
      return null;
    case "active":
      return { field: "status", value: "enabled" };
    case "bounced":
      return { field: "mailchimp_status", value: "cleaned" };
    case "subscribed":
    case "unsubscribed":
    case "non_subscribed":
    case "pending":
    case "transactional":
    case "cleaned":
    case "archived":
    case "deleted":
      return {
        field: "mailchimp_status",
        value: status.trim().toLowerCase(),
      };
    case "enabled":
    case "disabled":
    case "blocklisted":
    case "unconfirmed":
      return { field: "status", value: status.trim().toLowerCase() };
    default:
      return null;
  }
}

function isEmptyBooleanGroup(node: SegmentNode): boolean {
  return (node.op === "and" || node.op === "or") && node.children.length === 0;
}

function containsNLCondition(
  node: SegmentNode,
  field: string,
  comparator: string,
  value: unknown,
): boolean {
  if (node.op === "condition") {
    return (
      node.field === field &&
      node.comparator === comparator &&
      JSON.stringify(node.value) === JSON.stringify(value)
    );
  }
  if (node.op === "not") {
    const child = node.child ?? node.children?.[0];
    return child ? containsNLCondition(child, field, comparator, value) : false;
  }
  return node.children.some((child) =>
    containsNLCondition(child, field, comparator, value),
  );
}

export interface NLChip {
  label: string;
  path: number[];
  negated: boolean;
}

export function flattenNLChips(
  node: unknown,
  path: number[] = [],
  negated = false,
): NLChip[] {
  if (!node || typeof node !== "object") return [];
  const candidate = node as {
    op?: string;
    children?: unknown[];
    child?: unknown;
    field?: string;
    comparator?: string;
    value?: unknown;
  };
  const operation = (candidate.op ?? "").toLowerCase();
  if (operation === "condition") {
    return [{ label: formatNLConditionLabel(candidate), path, negated }];
  }
  if (operation === "and" || operation === "or") {
    const chips: NLChip[] = [];
    (candidate.children ?? []).forEach((child, index) => {
      chips.push(...flattenNLChips(child, [...path, index], negated));
    });
    return chips;
  }
  if (operation === "not") {
    if (candidate.child) {
      return flattenNLChips(candidate.child, [...path, -1], !negated);
    }
    if (candidate.children?.[0]) {
      return flattenNLChips(candidate.children[0], [...path, 0], !negated);
    }
  }
  return [];
}

export function formatNLConditionLabel(candidate: {
  field?: string;
  comparator?: string;
  value?: unknown;
}): string {
  const field = candidate.field ?? "?";
  const comparator = (candidate.comparator ?? "=").replace(/_/g, " ");
  const value = candidate.value;
  let formattedValue: string;
  if (value == null) formattedValue = "";
  else if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    formattedValue = String(value);
  } else {
    formattedValue = JSON.stringify(value);
  }
  return formattedValue
    ? `${field} ${comparator} ${formattedValue}`
    : `${field} ${comparator}`;
}

export function removeNLNodeAtPath(
  node: SegmentNode,
  path: number[],
): SegmentNode | null {
  if (path.length === 0) return null;
  return walkRemove(node, path) as SegmentNode | null;
}

function walkRemove(node: unknown, path: number[]): unknown {
  if (path.length === 0) return null;
  if (!node || typeof node !== "object") return node;
  const candidate = { ...(node as Record<string, unknown>) };
  const operation = (candidate.op as string | undefined)?.toLowerCase() ?? "";
  const [head, ...rest] = path;
  if (head === undefined) return candidate;

  if (operation === "not") {
    if (head === -1 || head === 0) {
      const child =
        candidate.child ?? (candidate.children as unknown[] | undefined)?.[0];
      const nextChild = walkRemove(child, rest);
      if (!nextChild) return null;
      return { op: "not", child: nextChild };
    }
    return candidate;
  }
  if (operation === "and" || operation === "or") {
    const children = (
      (candidate.children as unknown[] | undefined) ?? []
    ).slice();
    if (head < 0 || head >= children.length) return candidate;
    if (rest.length === 0) {
      children.splice(head, 1);
    } else {
      const nextChild = walkRemove(children[head], rest);
      if (nextChild == null) children.splice(head, 1);
      else children[head] = nextChild;
    }
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    return { ...candidate, children };
  }
  return null;
}

function collectASTFields(node: unknown, fields: Set<string>): void {
  if (!node || typeof node !== "object") return;
  const candidate = node as {
    op?: string;
    field?: string;
    children?: unknown[];
    child?: unknown;
  };
  const operation = (candidate.op ?? "").toLowerCase();
  if (operation === "condition") {
    if (candidate.field) fields.add(candidate.field);
    return;
  }
  if (candidate.child) collectASTFields(candidate.child, fields);
  for (const child of candidate.children ?? []) {
    collectASTFields(child, fields);
  }
}

function looksLikeTimeWindow(value: string): boolean {
  return /^now[+-]\d+[a-z]+$/i.test(value) || /^\d{4}-\d{2}-\d{2}/.test(value);
}

function collectASTTimeWindows(node: unknown, windows: Set<string>): void {
  if (!node || typeof node !== "object") return;
  const candidate = node as {
    op?: string;
    value?: unknown;
    children?: unknown[];
    child?: unknown;
  };
  const operation = (candidate.op ?? "").toLowerCase();
  if (operation === "condition") {
    if (
      typeof candidate.value === "string" &&
      looksLikeTimeWindow(candidate.value)
    ) {
      windows.add(candidate.value);
    }
    return;
  }
  if (candidate.child) collectASTTimeWindows(candidate.child, windows);
  for (const child of candidate.children ?? []) {
    collectASTTimeWindows(child, windows);
  }
}

export function pruneNLFacts(
  previous: SegmentNutritionFacts | null,
  ast: SegmentNode | null,
): SegmentNutritionFacts | null {
  if (!previous) return null;
  if (!ast) return { ...previous, predicates: [], time_windows: [] };
  const liveFields = new Set<string>();
  collectASTFields(ast, liveFields);
  const liveWindows = new Set<string>();
  collectASTTimeWindows(ast, liveWindows);
  return {
    ...previous,
    predicates: previous.predicates.filter((predicate) =>
      liveFields.has(predicate),
    ),
    time_windows: previous.time_windows.filter((window) =>
      liveWindows.has(window),
    ),
  };
}
