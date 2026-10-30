// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure, dependency-free logic for the segment builder: relative-date token
// grammar, save-time validation (name + incomplete rules + match-risk), and
// the duplicate-name helper. Kept side-effect-free so it is synchronously
// unit-testable (see __tests__/segment-logic.test.ts) and shared by the editor
// and the value/comparator inputs without pulling React in.

import type {
  Comparator,
  CreateSegmentInput,
  Segment,
  SegmentCondition,
  SegmentNode,
  SegmentUsageReference,
} from "@/lib/segments-api";

// --- Delete confirmation copy ----------------------------------------------
// The API refuses to delete a segment while a campaign that hasn't started
// sending uses it (409 segment_in_use), because the campaign would otherwise
// fall back to every subscriber. The confirmations say so up front.

/** Campaign statuses that can no longer be retargeted by a delete. */
const DISPATCHED_CAMPAIGN_STATUSES = new Set(["sending", "sent"]);

/**
 * Whether this reference will make the API refuse the delete. The server says
 * so (`blocks_delete`, from the same rule its refusal uses); the status guess
 * only covers an API that predates the flag.
 */
export function blocksSegmentDelete(d: SegmentUsageReference): boolean {
  if (d.kind !== "campaign") return false;
  if (typeof d.blocks_delete === "boolean") return d.blocks_delete;
  return !DISPATCHED_CAMPAIGN_STATUSES.has((d.status ?? "").toLowerCase());
}

function quotedList(items: SegmentUsageReference[], max = 3): string {
  const names = items.slice(0, max).map((d) => `"${d.name}"`);
  const more = items.length - names.length;
  return more > 0 ? `${names.join(", ")} and ${more} more` : names.join(", ");
}

/** Confirmation text for deleting one segment whose usage is known. */
export function segmentDeleteDescription(
  name: string,
  dependents: SegmentUsageReference[],
): string {
  const quoted = `"${name}"`;
  const blocking = dependents.filter(blocksSegmentDelete);
  const others = dependents.filter((d) => d.kind !== "campaign");
  const sentences: string[] = [];
  if (blocking.length > 0) {
    const one = blocking.length === 1;
    sentences.push(
      `${quoted} is the audience of ${one ? "a campaign" : `${blocking.length} campaigns`} that ${one ? "hasn't" : "haven't"} started sending: ${quotedList(blocking)}. It can't be deleted until you move ${one ? "that campaign" : "those campaigns"} to another audience or delete ${one ? "it" : "them"}.`,
    );
  } else {
    sentences.push(
      `${quoted} will be permanently deleted. A short Undo is offered afterwards.`,
    );
  }
  if (others.length > 0) {
    sentences.push(
      `${others.length === 1 ? "1 other item uses" : `${others.length} other items use`} it (${quotedList(others)}) and will need a new audience.`,
    );
  }
  return sentences.join(" ");
}

/** Confirmation text for deleting a segment from a list row. */
export function segmentRowDeleteDescription(name: string): string {
  return `"${name}" will be permanently deleted. If a campaign that hasn't started sending uses it as its audience, the delete is refused and you'll be told which campaign to move. A short Undo is offered afterwards.`;
}

/** Confirmation text for deleting several segments at once. */
export const BULK_DELETE_DESCRIPTION =
  "The selected segments will be permanently deleted. A segment that is the audience of a campaign that hasn't started sending is kept, and you'll be told which campaigns to move.";

/** Longest name we accept — matches the list-cell layout budget. */
export const SEGMENT_NAME_MAX = 120;

/**
 * Comparators that take NO value (they test presence/absence). The backend
 * compiler emits `IS NULL` / `IS NOT NULL` for these, so an empty value input
 * is correct — not an incomplete rule.
 */
export const VALUELESS_COMPARATORS: readonly Comparator[] = [
  "is_null",
  "is_not_null",
  // Engagement presence: compiled to `<column> IS [NOT] NULL`.
  "ever",
  "never",
];

/** Comparators whose value is a positive whole number of days. */
export const DAY_WINDOW_COMPARATORS: readonly Comparator[] = [
  "in_last_days",
  "more_than_days_ago",
];

/** Tag-history comparators, whose value is `{ tag, days }`. */
export const TAG_WINDOW_COMPARATORS: readonly Comparator[] = [
  "added_in_last_days",
  "removed_in_last_days",
];

/** Segment-of-segments comparators, whose value is a segment id. */
export const SEGMENT_REFERENCE_COMPARATORS: readonly Comparator[] = [
  "in_segment",
  "not_in_segment",
];

/** A whole number of days the compiler accepts (1 to 36,500). */
export function isValidDayCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 36_500
  );
}

export function isValuelessComparator(c: Comparator): boolean {
  return VALUELESS_COMPARATORS.includes(c);
}

/**
 * Every comparator the compiler defines, as runtime data.
 *
 * Declared as a total `Record<Comparator, true>` rather than an array so adding
 * a member to the `Comparator` union without listing it here is a COMPILE
 * error. A hand-maintained array would silently fall out of sync, which is
 * exactly the failure this guard exists to prevent.
 */
const COMPARATOR_SET: Record<Comparator, true> = {
  equals: true,
  not_equals: true,
  contains: true,
  not_contains: true,
  starts_with: true,
  ends_with: true,
  gt: true,
  gte: true,
  lt: true,
  lte: true,
  in: true,
  not_in: true,
  is_null: true,
  is_not_null: true,
  in_segment: true,
  not_in_segment: true,
  in_last_days: true,
  more_than_days_ago: true,
  ever: true,
  never: true,
  added_in_last_days: true,
  removed_in_last_days: true,
};

export const COMPARATORS = Object.keys(COMPARATOR_SET) as readonly Comparator[];

export function isComparator(value: unknown): value is Comparator {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(COMPARATOR_SET, value)
  );
}

/**
 * Build the pre-applied rule carried by an insight deep-link
 * (`?seedField=&seedComparator=&seedValue=`), or null when the link does not
 * describe a usable rule.
 *
 * The comparator MUST be validated here: it arrives from the URL, and the
 * editor previously cast it (`as Comparator`) straight into the AST. Nothing
 * downstream catches it — `isIncompleteCondition` only asks whether a value is
 * present — so a stale or hand-edited link persisted a segment whose operator
 * the compiler has never defined, while the comparator dropdown rendered blank
 * because no <option> matched.
 */
export function seedConditionFromParams(
  params: URLSearchParams,
): SegmentNode | null {
  const field = params.get("seedField")?.trim() ?? "";
  const comparator = params.get("seedComparator")?.trim() ?? "";
  if (!field || !isComparator(comparator)) return null;
  return {
    op: "and",
    children: [
      {
        op: "condition",
        field,
        comparator,
        value: params.get("seedValue") ?? "",
      },
    ],
  };
}

// --- Relative-date token grammar ------------------------------------------
// The compiler understands `now-Nd` / `now+Nd` tokens as a rolling window for
// ordered comparators on built-in date columns (compile.go relativeDay
// comparison), so a "within the last 30 days" rule stays correct over time
// instead of freezing to an absolute timestamp.

export interface RelativeDate {
  days: number;
  direction: "past" | "future";
}

const RELATIVE_TOKEN = /^now([-+])(\d+)d$/i;

export function parseRelativeDate(value: unknown): RelativeDate | null {
  if (typeof value !== "string") return null;
  const m = RELATIVE_TOKEN.exec(value.trim().toLowerCase());
  if (!m) return null;
  const days = Number(m[2]);
  if (!Number.isInteger(days) || days <= 0 || days > 36500) return null;
  return { days, direction: m[1] === "+" ? "future" : "past" };
}

export function isRelativeDate(value: unknown): boolean {
  return parseRelativeDate(value) !== null;
}

export function formatRelativeDate(
  days: number,
  direction: "past" | "future" = "past",
): string {
  const clamped = Math.min(36500, Math.max(1, Math.floor(days || 0)));
  return `now${direction === "future" ? "+" : "-"}${clamped}d`;
}

// --- Validation -----------------------------------------------------------

export function validateName(
  name: string,
  max = SEGMENT_NAME_MAX,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Name is required";
  if (trimmed.length > max) return `Name must be ${max} characters or fewer`;
  return null;
}

/** True when a condition is missing a value it needs to be meaningful. */
export function isIncompleteCondition(node: SegmentCondition): boolean {
  if (isValuelessComparator(node.comparator)) return false;
  const v = node.value as unknown;
  if (TAG_WINDOW_COMPARATORS.includes(node.comparator)) {
    if (!isRecord(v)) return true;
    return (
      typeof v.tag !== "string" ||
      v.tag.trim() === "" ||
      !isValidDayCount(v.days)
    );
  }
  if (DAY_WINDOW_COMPARATORS.includes(node.comparator)) {
    // A day count on engagement dates; { days } on event counts.
    return !(isValidDayCount(v) || (isRecord(v) && isValidDayCount(v.days)));
  }
  if (isRecord(v)) {
    // Event count: a count is required, a window is optional but must be valid.
    const count = v.count;
    if (typeof count !== "number" || !Number.isFinite(count)) return true;
    return v.days !== undefined && !isValidDayCount(v.days);
  }
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "string") return v.trim() === "";
  if (v === null || v === undefined) return true;
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Count conditions across the AST that are missing a required value. */
export function countIncompleteConditions(node: SegmentNode): number {
  switch (node.op) {
    case "condition":
      return isIncompleteCondition(node) ? 1 : 0;
    case "not":
      return countIncompleteConditions(node.child);
    case "and":
    case "or":
      return node.children.reduce(
        (sum, child) => sum + countIncompleteConditions(child),
        0,
      );
  }
}

/** Total number of leaf conditions in the AST. */
export function countConditions(node: SegmentNode): number {
  switch (node.op) {
    case "condition":
      return 1;
    case "not":
      return countConditions(node.child);
    case "and":
    case "or":
      return node.children.reduce(
        (sum, child) => sum + countConditions(child),
        0,
      );
  }
}

export interface SegmentValidation {
  nameError: string | null;
  incompleteCount: number;
  /** Non-blocking heuristic: the definition looks like it matches nobody. */
  matchNoneWarning: boolean;
  /**
   * Non-blocking heuristic: the definition has no active constraint, so it
   * would match the ENTIRE audience — an easy footgun to catch before a send
   * accidentally targets everyone (audit SEG-030).
   */
  matchAllWarning: boolean;
  /** OK to save (name valid + every condition complete). */
  valid: boolean;
}

export function validateSegment(
  name: string,
  ast: SegmentNode,
): SegmentValidation {
  const nameError = validateName(name);
  const incompleteCount = countIncompleteConditions(ast);
  const total = countConditions(ast);
  // If every condition is incomplete, the compiled predicate collapses to
  // empty-string / FALSE comparisons that match no one — worth warning about.
  const matchNoneWarning = total > 0 && incompleteCount === total;
  // Zero leaf conditions compiles to an unconstrained predicate that selects
  // every contact in scope. Saveable, but the user should know.
  const matchAllWarning = total === 0;
  return {
    nameError,
    incompleteCount,
    matchNoneWarning,
    matchAllWarning,
    valid: nameError === null && incompleteCount === 0,
  };
}

// --- Duplicate helper -----------------------------------------------------

/**
 * The definition fields a clone or restore must carry.
 *
 * `includeArchived` decides whether archived contacts are in scope, so leaving
 * it out does not produce "the same segment with a default" — it produces a
 * DIFFERENT audience. It is optional on CreateSegmentInput, so omitting it
 * type-checks silently; these builders exist so the two call sites cannot drift
 * apart from what onSave persists.
 */
export function restoreSegmentInput(
  source: Pick<
    Segment,
    "name" | "description" | "queryAst" | "includeArchived"
  >,
): CreateSegmentInput {
  return {
    name: source.name,
    description: source.description,
    queryAst: source.queryAst,
    includeArchived: source.includeArchived ?? false,
  };
}

/**
 * Input for "Duplicate": the copy keeps the source's archive scope but takes
 * the editor's current description/rules, so duplicating after an unsaved tweak
 * clones what is on screen rather than what is stored.
 */
export function duplicateSegmentInput(
  source: Pick<Segment, "name" | "includeArchived">,
  edits: { description: string; queryAst: SegmentNode },
  existingNames: string[] = [],
): CreateSegmentInput {
  return {
    name: duplicateName(source.name, existingNames),
    description: edits.description,
    queryAst: edits.queryAst,
    includeArchived: source.includeArchived ?? false,
  };
}

/**
 * Derive a distinct name for a cloned segment: "VIPs" -> "VIPs (copy)",
 * "VIPs (copy)" -> "VIPs (copy 2)", etc., so a duplicate never collides.
 */
export function duplicateName(name: string, existing: string[] = []): string {
  const taken = new Set(existing.map((n) => n.trim().toLowerCase()));
  const base = name.replace(/\s*\(copy(?:\s+\d+)?\)\s*$/i, "").trim() || name;
  const first = `${base} (copy)`;
  if (!taken.has(first.toLowerCase())) return first;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} (copy ${i})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return first;
}
