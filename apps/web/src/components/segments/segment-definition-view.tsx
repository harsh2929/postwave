// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import * as React from "react";

import type {
  Comparator,
  SegmentCondition,
  SegmentNode,
} from "@/lib/segments-api";
import { cn } from "@/lib/utils";

import { fieldDefOf, type FieldDef } from "./field-picker";
import {
  DAY_WINDOW_COMPARATORS,
  SEGMENT_REFERENCE_COMPARATORS,
  TAG_WINDOW_COMPARATORS,
  isValuelessComparator,
  parseRelativeDate,
} from "./segment-logic";

const COMPARATOR_LABELS: Record<Comparator, string> = {
  equals: "is",
  not_equals: "is not",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  gt: "is after / greater than",
  gte: "is on/after or ≥",
  lt: "is before / less than",
  lte: "is on/before or ≤",
  in: "is one of",
  not_in: "is not one of",
  is_null: "is not set",
  is_not_null: "is set",
  in_segment: "is in",
  not_in_segment: "is not in",
  in_last_days: "in the last",
  more_than_days_ago: "not in the last",
  ever: "at any time",
  never: "never",
  added_in_last_days: "was added in the last",
  removed_in_last_days: "was removed in the last",
};

// With the field's kind known, ordered comparisons read naturally instead of
// hedging between dates and numbers.
const NUMERIC_LABELS: Partial<Record<Comparator, string>> = {
  gt: "is more than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
};
const DATE_LABELS: Partial<Record<Comparator, string>> = {
  gt: "is after",
  gte: "is on or after",
  lt: "is before",
  lte: "is on or before",
};

function comparatorLabel(node: SegmentCondition, def?: FieldDef): string {
  const numeric =
    def?.kind === "numeric" || def?.valueType === "metric_aggregate";
  const byKind = numeric
    ? NUMERIC_LABELS[node.comparator]
    : def?.kind === "date"
      ? DATE_LABELS[node.comparator]
      : undefined;
  return byKind ?? COMPARATOR_LABELS[node.comparator] ?? node.comparator;
}

/** What the view needs to name fields and referenced segments. */
export interface DefinitionContext {
  /** The field catalogue, so registry fields read by their labels. */
  fields?: FieldDef[];
  /** Segment names by id, for segment-of-segments rules. */
  segmentNames?: ReadonlyMap<string, string>;
}

/** "rfm.segment_key" → "Rfm segment key": never a raw key. */
function humanizeFieldKey(field: string): string {
  const bare = field.startsWith("custom.") ? field.slice(7) : field;
  const words = bare.replace(/[._]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : field;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function days(n: unknown): string {
  return n === 1 ? "1 day" : `${String(n)} days`;
}

function scalarLabel(value: SegmentCondition["value"]): string {
  const rel = parseRelativeDate(value);
  if (rel) {
    return rel.direction === "past"
      ? `${rel.days} days ago`
      : `in ${rel.days} days`;
  }
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "true" : "false";
  if (isRecord(value)) return "";
  return String(value ?? "");
}

/** Human-readable one-line label for a single condition (pure, testable). */
export function conditionLabel(
  node: SegmentCondition,
  context?: DefinitionContext,
): string {
  const def = fieldDefOf(node.field, context?.fields);
  const field = def?.label ?? humanizeFieldKey(node.field);
  const comp = comparatorLabel(node, def);
  const value = node.value as unknown;

  if (isValuelessComparator(node.comparator)) return `${field} ${comp}`;

  if (SEGMENT_REFERENCE_COMPARATORS.includes(node.comparator)) {
    const id = typeof value === "string" ? value : "";
    const name = context?.segmentNames?.get(id);
    const target = name
      ? `"${name}"`
      : context?.segmentNames
        ? "a segment that no longer exists"
        : "another segment";
    return `${field} ${comp} ${target}`;
  }

  if (TAG_WINDOW_COMPARATORS.includes(node.comparator) && isRecord(value)) {
    const tag = typeof value.tag === "string" ? value.tag : "";
    return `${field} "${tag}" ${comp} ${days(value.days)}`;
  }

  if (DAY_WINDOW_COMPARATORS.includes(node.comparator)) {
    const window = isRecord(value)
      ? value.days
      : (parseRelativeDate(value)?.days ?? value);
    return `${field} ${comp} ${days(window)}`;
  }

  // Event counts: { count, days? }.
  if (isRecord(value) && typeof value.count === "number") {
    const within =
      typeof value.days === "number" ? ` in the last ${days(value.days)}` : "";
    return `${field} ${comp} ${value.count}${within}`;
  }

  return `${field} ${comp} ${scalarLabel(node.value)}`.trim();
}

function NodeView({
  node,
  depth = 0,
  context,
}: {
  node: SegmentNode;
  depth?: number;
  context?: DefinitionContext;
}) {
  if (node.op === "condition") {
    return (
      <div className="rounded bg-muted/50 px-2 py-1 text-sm">
        {conditionLabel(node, context)}
      </div>
    );
  }
  if (node.op === "not") {
    return (
      <div className="rounded-md border border-dashed border-destructive/40 p-2">
        <div className="mb-1 text-xs font-medium uppercase text-destructive">
          NOT
        </div>
        <NodeView node={node.child} depth={depth + 1} context={context} />
      </div>
    );
  }
  return (
    <div
      className={cn(
        "space-y-1.5 rounded-md p-2",
        depth === 0 ? "" : "border border-dashed",
      )}
    >
      {node.children.map((child, i) => (
        <React.Fragment key={i}>
          {i > 0 ? (
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {node.op}
            </div>
          ) : null}
          <NodeView node={child} depth={depth + 1} context={context} />
        </React.Fragment>
      ))}
    </div>
  );
}

export function SegmentDefinitionView({
  ast,
  context,
}: {
  ast: SegmentNode;
  context?: DefinitionContext;
}) {
  return <NodeView node={ast} context={context} />;
}
