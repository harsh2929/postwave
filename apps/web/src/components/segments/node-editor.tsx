// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import * as React from "react";
import { Ban, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type {
  Comparator,
  SegmentAnd,
  SegmentCondition,
  SegmentNode,
  SegmentNot,
  SegmentOr,
} from "@/lib/segments-api";

import { ComparatorPicker, comparatorOptionsFor } from "./comparator-picker";
import { FieldPicker, fieldDefOf, type FieldDef } from "./field-picker";
import { retargetValue } from "./segment-catalogue";
import { isIncompleteCondition } from "./segment-logic";
import { ValueInput, type SegmentChoices } from "./value-input";

export interface NodeEditorProps {
  node: SegmentNode;
  onChange: (n: SegmentNode) => void;
  onRemove?: () => void;
  depth?: number;
  /** The field catalogue (registry-derived); the built-ins when absent. */
  fields?: FieldDef[];
  /**
   * `fields` is the reduced fallback because the registry failed, so a stored
   * field missing from it may well exist; it is labelled as such.
   */
  catalogueDegraded?: boolean;
  /** Segments a segment-of-segments rule may refer to. */
  segments?: SegmentChoices;
}

const MAX_DEPTH = 4;
const MAX_DEPTH_HINT = "Maximum nesting depth reached";

// Subtle enter transition, globally reduced-motion-safe (SEG-048).
const ROW_ENTER = "mw-row-enter motion-reduce:animate-none";

export function emptyCondition(): SegmentCondition {
  return { op: "condition", field: "email", comparator: "equals", value: "" };
}

export function emptyGroup(op: "and" | "or"): SegmentAnd | SegmentOr {
  return { op, children: [emptyCondition()] };
}

export function emptyNot(): SegmentNot {
  return { op: "not", child: emptyCondition() };
}

export function NodeEditor({
  node,
  onChange,
  onRemove,
  depth = 0,
  fields,
  catalogueDegraded,
  segments,
}: NodeEditorProps) {
  if (node.op === "and" || node.op === "or") {
    return (
      <GroupEditor
        node={node}
        onChange={onChange}
        onRemove={onRemove}
        depth={depth}
        fields={fields}
        catalogueDegraded={catalogueDegraded}
        segments={segments}
      />
    );
  }
  if (node.op === "not") {
    return (
      <div className="rounded-md border border-dashed border-destructive/40 p-3 space-y-2">
        <div className="flex items-center gap-2 text-xs font-medium text-destructive">
          <Ban className="h-3.5 w-3.5" aria-hidden />
          NOT (exclude)
          {onRemove && (
            <Button
              variant="ghost"
              size="icon"
              type="button"
              aria-label="Remove NOT group"
              onClick={onRemove}
              className="ml-auto h-7 w-7"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
        <NodeEditor
          node={node.child}
          onChange={(c) => onChange({ op: "not", child: c })}
          depth={depth + 1}
          fields={fields}
          catalogueDegraded={catalogueDegraded}
          segments={segments}
        />
      </div>
    );
  }
  return (
    <ConditionEditor
      node={node}
      onChange={onChange}
      onRemove={onRemove}
      fields={fields}
      catalogueDegraded={catalogueDegraded}
      segments={segments}
    />
  );
}

/** AND/OR selector — a proper 2-option radiogroup with arrow-key roving. */
function OperatorToggle({
  op,
  onChange,
}: {
  op: "and" | "or";
  onChange: (op: "and" | "or") => void;
}) {
  const move = (e: React.KeyboardEvent) => {
    if (["ArrowLeft", "ArrowUp"].includes(e.key)) {
      e.preventDefault();
      onChange("and");
    } else if (["ArrowRight", "ArrowDown"].includes(e.key)) {
      e.preventDefault();
      onChange("or");
    } else if (e.key === "Home") {
      e.preventDefault();
      onChange("and");
    } else if (e.key === "End") {
      e.preventDefault();
      onChange("or");
    }
  };
  return (
    <div
      role="radiogroup"
      aria-label="Match operator"
      className="inline-flex rounded-md border bg-background p-0.5"
      onKeyDown={move}
    >
      {(["and", "or"] as const).map((value) => {
        const selected = op === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            // Roving tabindex: only the selected radio is in the tab order.
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(value)}
            className={cn(
              "px-2.5 py-1 text-xs font-medium rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
              selected
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {value.toUpperCase()}
          </button>
        );
      })}
    </div>
  );
}

function GroupEditor({
  node,
  onChange,
  onRemove,
  depth = 0,
  fields,
  catalogueDegraded,
  segments,
}: {
  node: SegmentAnd | SegmentOr;
  onChange: (n: SegmentNode) => void;
  onRemove?: () => void;
  depth: number;
  fields?: FieldDef[];
  catalogueDegraded?: boolean;
  segments?: SegmentChoices;
}) {
  function setChild(idx: number, child: SegmentNode) {
    const next = [...node.children];
    next[idx] = child;
    onChange({ ...node, children: next });
  }
  function removeChild(idx: number) {
    const next = node.children.filter((_, i) => i !== idx);
    // A group with zero children is meaningless; collapse to a fresh
    // condition so the UI never gets stuck in a zero-rule state.
    if (next.length === 0) {
      onChange({ ...node, children: [emptyCondition()] });
      return;
    }
    onChange({ ...node, children: next });
  }
  function addCondition() {
    onChange({ ...node, children: [...node.children, emptyCondition()] });
  }
  function addGroup() {
    onChange({
      ...node,
      children: [...node.children, emptyGroup(node.op === "and" ? "or" : "and")],
    });
  }
  function addNot() {
    onChange({ ...node, children: [...node.children, emptyNot()] });
  }
  function flipOp(op: "and" | "or") {
    if (node.op === op) return;
    onChange(op === "and"
      ? { op: "and", children: node.children }
      : { op: "or", children: node.children });
  }

  const canNest = depth < MAX_DEPTH;

  return (
    <div
      className={cn(
        "rounded-md border bg-card p-3 space-y-3",
        depth === 0 ? "border-border" : "border-dashed",
      )}
    >
      <div className="flex items-center gap-2">
        <OperatorToggle op={node.op} onChange={flipOp} />
        <span className="text-xs text-muted-foreground">
          {node.children.length} rule{node.children.length === 1 ? "" : "s"}
        </span>
        {onRemove && depth > 0 && (
          <Button
            variant="ghost"
            size="icon"
            type="button"
            aria-label="Remove group"
            onClick={onRemove}
            className="ml-auto h-7 w-7"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <div className="space-y-2">
        {node.children.map((c, i) => (
          <div key={i} className={ROW_ENTER}>
            <NodeEditor
              node={c}
              onChange={(n) => setChild(i, n)}
              onRemove={() => removeChild(i)}
              depth={depth + 1}
              fields={fields}
              catalogueDegraded={catalogueDegraded}
              segments={segments}
            />
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addCondition}
          className="h-8"
        >
          <Plus className="h-3.5 w-3.5" />
          Add condition
        </Button>
        {canNest ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addGroup}
              className="h-8"
            >
              <Plus className="h-3.5 w-3.5" />
              Add group
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addNot}
              className="h-8"
            >
              <Ban className="h-3.5 w-3.5" />
              Add exclusion (NOT)
            </Button>
          </>
        ) : (
          // Show WHY nesting stopped instead of silently dropping the button.
          <Tooltip label={MAX_DEPTH_HINT}>
            {/* aria-disabled (not `disabled`) keeps the control focus/hover-able
                so the explanatory tooltip can actually appear (SEG-045). */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 cursor-not-allowed opacity-50"
              aria-disabled
              onClick={(e) => e.preventDefault()}
            >
              <Plus className="h-3.5 w-3.5" />
              Add group
            </Button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

function ConditionEditor({
  node,
  onChange,
  onRemove,
  fields,
  catalogueDegraded,
  segments,
}: {
  node: SegmentCondition;
  onChange: (n: SegmentNode) => void;
  onRemove?: () => void;
  fields?: FieldDef[];
  catalogueDegraded?: boolean;
  segments?: SegmentChoices;
}) {
  // Resolve the field against the catalogue so a `custom.<key>` / registry
  // condition gets its own comparators and value control.
  const def = fieldDefOf(node.field, fields);
  const kind = def?.kind ?? "string";
  // Render exactly what is stored. This previously substituted the first valid
  // comparator for the field kind when the stored one did not fit, but only for
  // DISPLAY — the AST kept the original, so saving re-persisted an operator the
  // user was never shown. Substituting here is not safe either: the catalogue
  // arrives from a query, so a valid comparator can look invalid on every
  // load. ComparatorPicker carries an out-of-list value as an option instead.
  const comparator: Comparator = node.comparator;
  const incomplete = isIncompleteCondition(node);

  // A different field or comparator can need a differently shaped value (a
  // segment id, a day count, { tag, days }). Keep the value when it still
  // fits; otherwise start from that comparator's empty value, so the row never
  // shows "[object Object]" or saves a value the compiler refuses.
  const retarget = (field: string, nextComparator: Comparator) => {
    const nextDef = fieldDefOf(field, fields);
    const value = retargetValue(nextComparator, node.value, nextDef);
    onChange({ ...node, field, comparator: nextComparator, value });
  };

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-md bg-muted/40 p-2",
        incomplete && "ring-1 ring-warning/50",
      )}
    >
      <FieldPicker
        value={node.field}
        fields={fields}
        catalogueDegraded={catalogueDegraded}
        onChange={(field) => {
          const nextDef = fieldDefOf(field, fields);
          const valid = comparatorOptionsFor(
            nextDef?.kind ?? "string",
            nextDef?.comparators,
          );
          const nextComparator = valid.some((c) => c.value === node.comparator)
            ? node.comparator
            : valid[0]!.value;
          retarget(field, nextComparator);
        }}
      />
      <ComparatorPicker
        kind={kind}
        allowed={def?.comparators}
        value={comparator}
        onChange={(c) => retarget(node.field, c)}
      />
      {/* Let the value input shrink with the row on mobile; cap min width from sm up. */}
      <div className="min-w-0 sm:min-w-[200px] flex-1">
        <ValueInput
          kind={kind}
          comparator={comparator}
          value={node.value}
          onChange={(v) => onChange({ ...node, value: v })}
          options={def?.options}
          valueType={def?.valueType}
          eventName={def?.eventName}
          segments={segments}
        />
      </div>
      {incomplete ? (
        <span className="text-xs text-warning-emphasis">Needs a value</span>
      ) : null}
      {onRemove && (
        <Button
          variant="ghost"
          size="icon"
          type="button"
          aria-label="Remove condition"
          onClick={onRemove}
          className="h-8 w-8"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}
