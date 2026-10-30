// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import * as React from "react";

import type { Comparator } from "@/lib/segments-api";
import { cn } from "@/lib/utils";

// Field catalogue. The editor builds it from the predicate registry (see
// segment-catalogue.ts), which already lists every built-in and every custom
// field once, under a heading people read. BUILTIN_FIELDS is only the fallback
// when the registry cannot be loaded.
export type FieldKind = "string" | "date" | "numeric" | "boolean";

export interface FieldDef {
  value: string;
  label: string;
  kind: FieldKind;
  /** Known allowed values for enum-typed fields (value suggestions). */
  options?: string[];
  /** optgroup heading, e.g. "Profile", "Predictive & RFM", "Custom fields". */
  group?: string;
  /**
   * The comparators this field supports, straight from the registry. When
   * absent the comparator picker falls back to the list for `kind`.
   */
  comparators?: Comparator[];
  /**
   * The registry's value type ("segment", "engagement_date", "tag",
   * "metric_aggregate", …) where the value needs a dedicated control.
   */
  valueType?: string;
  /**
   * For an event-count field, the event as tracked (the registry's
   * `source_ref`). Its key only carries the event's slug, so rules name it.
   */
  eventName?: string;
}

export const BUILTIN_FIELDS: FieldDef[] = [
  { value: "email", label: "Email", kind: "string", group: "Profile" },
  { value: "status", label: "Status", kind: "string", group: "Profile" },
  { value: "tag", label: "Tag", kind: "string", group: "Profile" },
  {
    value: "consent_source",
    label: "Consent source",
    kind: "string",
    group: "Consent",
  },
  {
    value: "consent_timestamp",
    label: "Consent date",
    kind: "date",
    group: "Consent",
  },
  {
    value: "last_opened_at",
    label: "Last opened",
    kind: "date",
    group: "Engagement",
  },
  {
    value: "last_clicked_at",
    label: "Last clicked",
    kind: "date",
    group: "Engagement",
  },
  {
    value: "last_event_at",
    label: "Last engagement (any)",
    kind: "date",
    group: "Engagement",
  },
];

/**
 * Field keys the compiler treats as the same field. Older rules were saved
 * with the builder's `tag`; the registry names it `tags`.
 */
const FIELD_ALIASES: Record<string, string> = { tag: "tags", tags: "tag" };

/** The catalogue a picker shows: the supplied one, or the built-ins. */
export function catalogueOf(fields?: FieldDef[]): FieldDef[] {
  return fields && fields.length > 0 ? fields : BUILTIN_FIELDS;
}

/** The catalogue entry for a stored field key, honouring aliases. */
export function fieldDefOf(
  field: string,
  fields?: FieldDef[],
): FieldDef | undefined {
  const all = catalogueOf(fields);
  const exact = all.find((f) => f.value === field);
  if (exact) return exact;
  const alias = FIELD_ALIASES[field];
  return alias ? all.find((f) => f.value === alias) : undefined;
}

export function fieldKindOf(field: string, fields?: FieldDef[]): FieldKind {
  return fieldDefOf(field, fields)?.kind ?? "string";
}

/** Known enum values for the given field, if any (for value suggestions). */
export function fieldOptionsOf(
  field: string,
  fields?: FieldDef[],
): string[] | undefined {
  const opts = fieldDefOf(field, fields)?.options;
  return opts && opts.length ? opts : undefined;
}

/**
 * Label for a stored field the catalogue doesn't offer. When the catalogue is
 * only the fallback (the registry failed), the field may well exist, so the
 * label says the list couldn't load rather than that the field is gone.
 */
export function unavailableFieldLabel(
  field: string,
  catalogueDegraded = false,
): string {
  const name = field.startsWith("custom.")
    ? field.slice("custom.".length)
    : field;
  if (catalogueDegraded) {
    return `${name} (can't show this field until the field list loads)`;
  }
  return field.startsWith("custom.")
    ? `${name} (custom field no longer defined)`
    : `${name} (no longer available)`;
}

export interface FieldPickerProps {
  value: string;
  onChange: (field: string) => void;
  /** The catalogue to offer; the built-ins when absent or empty. */
  fields?: FieldDef[];
  /** `fields` is the fallback because the registry failed. */
  catalogueDegraded?: boolean;
  className?: string;
}

export function FieldPicker({
  value,
  onChange,
  fields,
  catalogueDegraded = false,
  className,
}: FieldPickerProps) {
  const all = catalogueOf(fields);
  // Group in catalogue order so headings appear in the order the registry
  // lists its categories.
  const grouped = React.useMemo(() => {
    const map = new Map<string, FieldDef[]>();
    for (const f of all) {
      const key = f.group ?? "Other";
      const list = map.get(key) ?? [];
      list.push(f);
      map.set(key, list);
    }
    return Array.from(map.entries());
  }, [all]);

  const current = fieldDefOf(value, all);
  // Show the catalogue's own entry for an aliased key (a rule saved as `tag`
  // selects "Tag"); both compile to the same predicate.
  const selected = current?.value ?? value;

  return (
    <select
      className={cn(
        "h-9 max-w-[14rem] rounded-md border border-input bg-background px-3 text-sm",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      value={selected}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Field"
    >
      {grouped.map(([group, list]) => (
        <optgroup key={group} label={group}>
          {list.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </optgroup>
      ))}
      {!current && (
        <option value={value}>
          {unavailableFieldLabel(value, catalogueDegraded)}
        </option>
      )}
    </select>
  );
}
