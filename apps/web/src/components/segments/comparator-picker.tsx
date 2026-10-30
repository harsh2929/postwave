// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { cn } from "@/lib/utils";
import type { Comparator } from "@/lib/segments-api";

import type { FieldKind } from "./field-picker";

const STRING_COMPARATORS: Array<{ value: Comparator; label: string }> = [
  { value: "equals", label: "equals" },
  { value: "not_equals", label: "does not equal" },
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "does not contain" },
  { value: "starts_with", label: "starts with" },
  { value: "ends_with", label: "ends with" },
  { value: "in", label: "is one of" },
  { value: "not_in", label: "is not one of" },
];

const ORDERED_COMPARATORS: Array<{ value: Comparator; label: string }> = [
  { value: "gt", label: ">" },
  { value: "gte", label: ">=" },
  { value: "lt", label: "<" },
  { value: "lte", label: "<=" },
  { value: "equals", label: "=" },
  { value: "not_equals", label: "!=" },
];

// Date fields get an ergonomic vocabulary: absolute comparisons PLUS the
// presence operators (is set / is not set). The rolling "in the last N days"
// affordance is expressed by pairing an ordered comparator with a relative
// `now-Nd` value in ValueInput, so it stays correct over time (SEG-008).
const DATE_COMPARATORS: Array<{ value: Comparator; label: string }> = [
  { value: "gte", label: "on or after" },
  { value: "gt", label: "after" },
  { value: "lte", label: "on or before" },
  { value: "lt", label: "before" },
  { value: "equals", label: "is exactly" },
  { value: "not_equals", label: "is not" },
  { value: "is_not_null", label: "is set" },
  { value: "is_null", label: "is not set" },
];

const BOOLEAN_COMPARATORS: Array<{ value: Comparator; label: string }> = [
  { value: "equals", label: "is" },
  { value: "not_equals", label: "is not" },
];

// Comparators that only some registry predicates offer. Each reads as the
// middle of a sentence: "Member of segment | is in | VIPs", "Last opened | in
// the last | 30 days", "Tag | was added in the last | vip · 30 days".
const PREDICATE_COMPARATORS: Array<{ value: Comparator; label: string }> = [
  { value: "in_segment", label: "is in" },
  { value: "not_in_segment", label: "is not in" },
  { value: "in_last_days", label: "in the last" },
  { value: "more_than_days_ago", label: "not in the last" },
  { value: "ever", label: "at any time" },
  { value: "never", label: "never" },
  { value: "added_in_last_days", label: "was added in the last" },
  { value: "removed_in_last_days", label: "was removed in the last" },
];

export function comparatorsFor(kind: FieldKind) {
  switch (kind) {
    case "date":
      return DATE_COMPARATORS;
    case "numeric":
      return ORDERED_COMPARATORS;
    case "boolean":
      return BOOLEAN_COMPARATORS;
    case "string":
    default:
      return STRING_COMPARATORS;
  }
}

/**
 * The comparators to offer for a field: the registry's own list when it gave
 * one (labelled for the field's kind where the kind has a label, so a date
 * reads "on or after" and a number ">="), otherwise the list for the kind.
 * Comparators the builder has no control for are left out rather than
 * offered and then refused on save.
 */
export function comparatorOptionsFor(
  kind: FieldKind,
  allowed?: readonly Comparator[],
): Array<{ value: Comparator; label: string }> {
  if (!allowed || allowed.length === 0) return comparatorsFor(kind);
  const kindLabels = new Map(
    comparatorsFor(kind).map((c) => [c.value, c.label]),
  );
  const out: Array<{ value: Comparator; label: string }> = [];
  for (const value of allowed) {
    const label = kindLabels.get(value) ?? COMPARATOR_LABELS[value];
    if (label) out.push({ value, label });
  }
  return out.length > 0 ? out : comparatorsFor(kind);
}

export interface ComparatorPickerProps {
  kind: FieldKind;
  value: Comparator;
  onChange: (c: Comparator) => void;
  /** The field's own comparators, from the predicate registry. */
  allowed?: readonly Comparator[];
  className?: string;
}

/** Every comparator's label, regardless of which kind normally offers it. */
export const COMPARATOR_LABELS: Partial<Record<Comparator, string>> =
  Object.fromEntries(
    [
      ...STRING_COMPARATORS,
      ...ORDERED_COMPARATORS,
      ...DATE_COMPARATORS,
      ...BOOLEAN_COMPARATORS,
      ...PREDICATE_COMPARATORS,
    ].map((c) => [c.value, c.label]),
  );

/** Narrows registry comparator strings to the ones the builder can edit. */
export function editableComparators(
  comparators: readonly string[] | undefined,
): Comparator[] {
  return (comparators ?? []).filter((c): c is Comparator =>
    Object.prototype.hasOwnProperty.call(COMPARATOR_LABELS, c),
  );
}

export function ComparatorPicker({
  kind,
  value,
  onChange,
  allowed,
  className,
}: ComparatorPickerProps) {
  const forField = comparatorOptionsFor(kind, allowed);
  // A stored comparator can legitimately sit outside this field's list: field
  // kinds resolve asynchronously (the catalogue arrives from a query, and
  // `fieldKindOf` falls back to "string" until then) and a custom field's
  // type can change after a segment was built. Carry it as an option instead of
  // letting the <select> display a DIFFERENT operator than the one that will be
  // saved — the caller cannot rewrite it safely, because during the loading
  // window "invalid" is indistinguishable from "not resolved yet".
  const opts = forField.some((c) => c.value === value)
    ? forField
    : [...forField, { value, label: COMPARATOR_LABELS[value] ?? value }];
  return (
    <select
      className={cn(
        "h-9 rounded-md border border-input bg-background px-3 text-sm",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      value={value}
      onChange={(e) => onChange(e.target.value as Comparator)}
      aria-label="Comparator"
    >
      {opts.map((c) => (
        <option key={c.value} value={c.value}>
          {c.label}
        </option>
      ))}
    </select>
  );
}
