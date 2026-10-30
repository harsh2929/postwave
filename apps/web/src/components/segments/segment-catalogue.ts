// SPDX-License-Identifier: AGPL-3.0-only
//
// The segment builder's field catalogue, built from the predicate registry.
//
// The builder used to merge two overlapping sources: the tenant's custom fields
// (GET /custom-fields, under "Custom fields") and the predicate registry, whose
// predicates already include every custom field as `custom.<key>` plus the
// `custom.*` descriptor, grouped under raw category tokens ("custom_field",
// "profile", …). Every custom field appeared twice, the descriptor appeared as
// a pickable "Custom field" that matches nothing, and built-ins appeared a
// third time in a hard-coded "Built-in" group. The registry is now the only
// catalogue; the custom-fields list is used only when the registry cannot be
// loaded.

import type {
  Comparator,
  CustomField,
  EventCountValue,
  PredicateDefinition,
  SegmentCondition,
} from "@/lib/segments-api";

import { editableComparators } from "./comparator-picker";
import { BUILTIN_FIELDS, type FieldDef, type FieldKind } from "./field-picker";
import {
  DAY_WINDOW_COMPARATORS,
  SEGMENT_REFERENCE_COMPARATORS,
  TAG_WINDOW_COMPARATORS,
  isValuelessComparator,
} from "./segment-logic";
import { EVENT_COUNT_VALUE_TYPE } from "./value-input";

/** Registry value types the builder edits with a dedicated control. */
const DEDICATED_VALUE_TYPES = new Set([
  "segment",
  "engagement_date",
  "tag",
  EVENT_COUNT_VALUE_TYPE,
]);

const NUMERIC_VALUE_TYPES = new Set([
  "number",
  "integer",
  "float",
  "decimal",
  "score",
  "money",
]);

// Engagement dates are timestamps too: a rule saved before the rolling-window
// comparators ("on or after now-30d") still edits as a date.
const DATE_VALUE_TYPES = new Set([
  "date",
  "datetime",
  "timestamp",
  "timestamptz",
  "engagement_date",
]);

export function registryValueKind(valueType: string): FieldKind {
  const v = valueType.toLowerCase();
  if (NUMERIC_VALUE_TYPES.has(v)) return "numeric";
  if (DATE_VALUE_TYPES.has(v)) return "date";
  if (["boolean", "bool"].includes(v)) return "boolean";
  return "string";
}

/** "custom_object" → "Custom object": never show a raw category token. */
export function humanizeCategory(category: string): string {
  const words = category
    .trim()
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "Other";
  const [first, ...rest] = words;
  return [first!.charAt(0).toUpperCase() + first!.slice(1), ...rest].join(" ");
}

/**
 * Maps registry predicates to builder fields. Leaves out descriptors (keys
 * with "*"), predicates the compiler cannot evaluate yet ("planned",
 * "unsupported"), and repeats; groups under the registry's own heading.
 */
export function registryToFieldDefs(
  predicates: PredicateDefinition[],
): FieldDef[] {
  const seen = new Set<string>();
  const out: FieldDef[] = [];
  for (const p of predicates) {
    if (!p.key || p.key.includes("*")) continue;
    if (
      p.compiler_status === "planned" ||
      p.compiler_status === "unsupported"
    ) {
      continue;
    }
    if (seen.has(p.key)) continue;
    seen.add(p.key);
    const comparators = editableComparators(p.comparators);
    const valueType = p.value_type?.toLowerCase();
    out.push({
      value: p.key,
      label: p.label || p.key,
      kind: registryValueKind(p.value_type ?? ""),
      options: p.options && p.options.length > 0 ? p.options : undefined,
      group:
        p.category_label?.trim() || humanizeCategory(p.category || "other"),
      comparators: comparators.length > 0 ? comparators : undefined,
      valueType:
        valueType && DEDICATED_VALUE_TYPES.has(valueType)
          ? valueType
          : undefined,
      eventName:
        valueType === EVENT_COUNT_VALUE_TYPE && p.source_ref?.trim()
          ? p.source_ref.trim()
          : undefined,
    });
  }
  return out;
}

function customFieldKind(type: CustomField["type"]): FieldKind {
  switch (type) {
    case "number":
      return "numeric";
    case "boolean":
      return "boolean";
    case "date":
      return "date";
    default:
      return "string";
  }
}

/**
 * The catalogue when the registry is unavailable: the built-ins, then the
 * tenant's custom fields if that list loaded.
 */
export function fallbackFieldDefs(custom: CustomField[] | null): FieldDef[] {
  const seen = new Set(BUILTIN_FIELDS.map((f) => f.value));
  const out = [...BUILTIN_FIELDS];
  for (const f of custom ?? []) {
    const value = `custom.${f.key}`;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push({
      value,
      label: f.label || f.key,
      kind: customFieldKind(f.type),
      group: "Custom fields",
    });
  }
  return out;
}

/** Does value have the shape comparator (on this field) needs? */
export function valueFits(
  comparator: Comparator,
  value: SegmentCondition["value"],
  def?: FieldDef,
): boolean {
  if (isValuelessComparator(comparator)) return true;
  const isObject =
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (TAG_WINDOW_COMPARATORS.includes(comparator)) {
    return isObject && "tag" in value;
  }
  if (def?.valueType === EVENT_COUNT_VALUE_TYPE) {
    // Both shapes compile, but a bare number means a count threshold under a
    // count comparator and a window under a window comparator; only the
    // object form keeps its meaning when the comparator changes family.
    return DAY_WINDOW_COMPARATORS.includes(comparator)
      ? isObject && "days" in value
      : isObject || typeof value === "number";
  }
  if (DAY_WINDOW_COMPARATORS.includes(comparator)) {
    return typeof value === "number";
  }
  if (SEGMENT_REFERENCE_COMPARATORS.includes(comparator)) {
    return typeof value === "string";
  }
  if (comparator === "in" || comparator === "not_in") {
    return Array.isArray(value);
  }
  return !isObject && !Array.isArray(value);
}

/** The empty value a freshly chosen comparator starts from. */
export function emptyValueFor(
  comparator: Comparator,
  def?: FieldDef,
): SegmentCondition["value"] {
  if (TAG_WINDOW_COMPARATORS.includes(comparator)) return { tag: "", days: 30 };
  if (def?.valueType === EVENT_COUNT_VALUE_TYPE) {
    return withEventName(
      DAY_WINDOW_COMPARATORS.includes(comparator) ? { days: 30 } : {},
      def,
    );
  }
  if (DAY_WINDOW_COMPARATORS.includes(comparator)) return 30;
  if (comparator === "in" || comparator === "not_in") return [];
  if (def?.kind === "boolean") return true;
  return "";
}

/**
 * The value a condition keeps when its field or comparator changes: the old
 * value where it still fits, otherwise the new comparator's empty value. An
 * event count is re-pointed at the field's own event, so a count carried from
 * another event's field never keeps counting that event.
 */
export function retargetValue(
  comparator: Comparator,
  value: SegmentCondition["value"],
  def?: FieldDef,
): SegmentCondition["value"] {
  if (!valueFits(comparator, value, def)) return emptyValueFor(comparator, def);
  if (def?.valueType !== EVENT_COUNT_VALUE_TYPE) return value;
  if (typeof value === "number") {
    // A bare threshold carries no event name; give it the object form so the
    // rule names the event it counts.
    return def.eventName ? withEventName({ count: value }, def) : value;
  }
  return withEventName(value as EventCountValue, def);
}

/** value naming def's event (or no event, when the field has none). */
export function withEventName(
  value: EventCountValue,
  def?: FieldDef,
): EventCountValue {
  const rest: EventCountValue = { ...value };
  delete rest.event_name;
  return def?.eventName ? { ...rest, event_name: def.eventName } : rest;
}
