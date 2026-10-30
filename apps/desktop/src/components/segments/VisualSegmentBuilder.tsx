/**
 * VisualSegmentBuilder — a structured rule-row editor that constructs a
 * segment query AST from the predicate registry (Klaviyo-parity KLV-06),
 * the visual sibling of the natural-language "Describe" flow.
 *
 * Shape: a root boolean group (AND/OR) holding condition rows and one
 * level of nested sub-groups. Each row picks a predicate (grouped by
 * category), then a comparator limited to that predicate's set, then a
 * value input typed by value_type / comparator. An optional NOT wraps any
 * row or group.
 *
 * Honest-UI:
 *  - Only `supported` predicates are shown, so an operator can never build a
 *    condition the compiler can't evaluate.
 *  - The live count comes from POST /preview-count against the AST the
 *    user actually built (debounced); a `capped` result is surfaced as
 *    "≥ N (evaluation capped)" rather than a clamped lie.
 *  - An empty/invalid tree shows "Add a condition to preview"; a registry
 *    load failure degrades gracefully.
 *
 * The component is controlled-by-callback: it lifts the freshly-built AST
 * to the parent modal via `onAstChange`, so the modal's existing Save path
 * (name + segmentsClient.create) persists the visual AST unchanged.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { useRemoteResource } from "../../hooks/useRemoteResource";
import { useSingleFlightOperation } from "../../hooks/useSettingsDraftLifecycle";
import {
  hasVerifiedRemoteData,
  remoteFailureFromError,
  type RemoteFailure,
} from "../../lib/remote-resource";
import { ChoiceGroup } from "../ChoiceGroup";
import { RemoteDataNotice } from "../RemoteDataNotice";
import {
  type PredicateDefinition,
  type PredicateRegistry,
  type Segment,
  segmentsClient,
} from "./segmentsClient";
import {
  type ConditionRow,
  type EditorNode,
  type GroupNode,
  buildAst,
  comparatorsFor,
  emptyGroup,
  emptyRow,
  isLifecycleComparator,
  isListComparator,
  isMetricAggregateValueType,
  isMetricWindowComparator,
  isSegmentValueType,
  isSupportedPredicate,
} from "./visual-segment-ast";

interface Props {
  /** Lifts the current built AST (or null when empty/invalid) to the parent. */
  onAstChange: (ast: unknown | null) => void;
  /**
   * Reports edits even while an incomplete row cannot produce an AST. The
   * parent modal is the sole lifecycle owner for this aggregate builder.
   */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * SUB-032 — the id of the segment currently being edited, if any, so
   * the segment-of-segments picker can exclude it (a segment can't
   * reference itself). Undefined when building a brand-new segment (the
   * common case), where there's no id to self-reference yet. The backend
   * is the authoritative cycle/depth guard at compile time.
   */
  currentSegmentId?: string;
}

/* Group supported predicates by category, preserving order. */
function groupByCategory(
  preds: PredicateDefinition[],
): Array<{ category: string; items: PredicateDefinition[] }> {
  const order: string[] = [];
  const map = new Map<string, PredicateDefinition[]>();
  for (const p of preds) {
    const cat = p.category || "Other";
    if (!map.has(cat)) {
      map.set(cat, []);
      order.push(cat);
    }
    map.get(cat)!.push(p);
  }
  return order.map((category) => ({ category, items: map.get(category)! }));
}

/* Friendly comparator labels — fall back to the raw key when unknown so
 * we never hide a comparator the server offers. */
const COMPARATOR_LABELS: Record<string, string> = {
  equals: "equals",
  not_equals: "does not equal",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  gt: "is greater than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  in: "is any of",
  not_in: "is none of",
  before: "is before",
  after: "is after",
  between: "is between",
  added_in_last_days: "tag added in last N days",
  removed_in_last_days: "tag removed in last N days",
  // SUB-028 — metric aggregate time-window comparators.
  in_last_days: "happened in last N days",
  more_than_days_ago: "has not happened in last N days",
  // SUB-032 — segment-of-segments comparators.
  in_segment: "is in segment",
  not_in_segment: "is not in segment",
};

function comparatorLabel(c: string): string {
  return COMPARATOR_LABELS[c] ?? c;
}

/* ─── Value input — typed by comparator (lists/lifecycle) then value_type ── */

function ValueInput({
  row,
  predicate,
  onChange,
  savedSegments,
  savedSegmentsLoading,
  currentSegmentId,
}: {
  row: ConditionRow;
  predicate: PredicateDefinition | undefined;
  onChange: (patch: Partial<ConditionRow>) => void;
  /** SUB-032 — canonical segments for the segment-of-segments picker. */
  savedSegments: Segment[];
  savedSegmentsLoading: boolean;
  /** SUB-032 — exclude this id from the picker (self-reference guard). */
  currentSegmentId?: string;
}): ReactElement | null {
  const comparator = row.comparator ?? "";
  const valueType = (predicate?.value_type ?? "string").toLowerCase();
  const segmentStateId = useId();

  if (!comparator) return null;

  // SUB-032 — segment-of-segments: a dropdown of OTHER canonical segments.
  // Self-references are filtered out here; the backend is the
  // authoritative depth-2 / cycle guard at compile time.
  if (isSegmentValueType(valueType)) {
    const candidates = savedSegments
      .filter((s) => s.id !== currentSegmentId)
      .slice()
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      );
    const empty = !savedSegmentsLoading && candidates.length === 0;
    return (
      <span className="visual-segment-value-stack">
        <select
          className="input pw-discoverable-unavailable"
          style={{ flex: 1, minWidth: 180 }}
          value={row.value ?? ""}
          aria-label="Referenced segment"
          aria-disabled={savedSegmentsLoading || empty || undefined}
          aria-describedby={segmentStateId}
          onChange={(event) => {
            if (!savedSegmentsLoading && !empty) {
              onChange({ value: event.target.value });
            }
          }}
        >
          <option value="">
            {savedSegmentsLoading
              ? "Loading segments…"
              : empty
                ? "No other segments to reference"
                : "Pick a segment…"}
          </option>
          {candidates.map((segment) => (
            <option key={segment.id} value={segment.id}>
              {segment.name}
            </option>
          ))}
        </select>
        <small id={segmentStateId} className="pw-action-status">
          {savedSegmentsLoading
            ? "Verifying canonical segments. This choice is temporarily unavailable."
            : empty
              ? "No other verified segment can be referenced from this rule."
              : `${candidates.length.toLocaleString()} verified segment${candidates.length === 1 ? "" : "s"} available; the current segment is excluded.`}
        </small>
      </span>
    );
  }

  // Lifecycle: needs BOTH a tag name and a day count ({tag, days}).
  if (isLifecycleComparator(comparator)) {
    return (
      <>
        <input
          className="input"
          style={{ width: 120 }}
          placeholder="tag name"
          value={row.value ?? ""}
          aria-label="Tag name"
          onChange={(e) => onChange({ value: e.target.value })}
        />
        <input
          className="input"
          style={{ width: 80 }}
          type="number"
          min={1}
          placeholder="days"
          value={row.days ?? ""}
          aria-label="Number of days"
          onChange={(e) => onChange({ days: e.target.value })}
        />
        <span className="muted" style={{ fontSize: 11 }}>
          days
        </span>
      </>
    );
  }

  // in / not_in: comma-separated list.
  if (isListComparator(comparator)) {
    return (
      <input
        className="input"
        style={{ flex: 1, minWidth: 160 }}
        placeholder="value1, value2, value3"
        value={row.value ?? ""}
        aria-label="Comma-separated values"
        onChange={(e) => onChange({ value: e.target.value })}
      />
    );
  }

  // SUB-028 — metric aggregate: a dual-input matching the tag-lifecycle
  // pattern. `value` holds the threshold count, `days` the rolling
  // window. The time-window comparators (in_last_days /
  // more_than_days_ago) need ONLY the window — the count is forced
  // server-side — so the count input is hidden for those.
  if (isMetricAggregateValueType(valueType)) {
    const windowOnly = isMetricWindowComparator(comparator);
    return (
      <>
        {windowOnly ? null : (
          <input
            className="input"
            style={{ width: 100 }}
            type="number"
            min={0}
            placeholder="count"
            value={row.value ?? ""}
            aria-label="Event count threshold"
            onChange={(e) => onChange({ value: e.target.value })}
          />
        )}
        <input
          className="input"
          style={{ width: 90 }}
          type="number"
          min={1}
          placeholder={windowOnly ? "days" : "days (optional)"}
          value={row.days ?? ""}
          aria-label="Time window in days"
          onChange={(e) => onChange({ days: e.target.value })}
        />
        <span className="muted" style={{ fontSize: 11 }}>
          {windowOnly ? "days" : "in last N days (blank = all time)"}
        </span>
      </>
    );
  }

  if (valueType === "boolean") {
    return (
      <label
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12,
        }}
      >
        <input
          type="checkbox"
          checked={row.value === "true"}
          onChange={(e) =>
            onChange({ value: e.target.checked ? "true" : "false" })
          }
        />
        <span className="muted">{row.value === "true" ? "true" : "false"}</span>
      </label>
    );
  }

  if (valueType === "number") {
    return (
      <input
        className="input"
        style={{ width: 140 }}
        type="number"
        placeholder="0"
        value={row.value ?? ""}
        aria-label="Number value"
        onChange={(e) => onChange({ value: e.target.value })}
      />
    );
  }

  if (valueType === "date") {
    return (
      <input
        className="input"
        style={{ width: 170 }}
        type="date"
        value={row.value ?? ""}
        aria-label="Date value"
        onChange={(e) => onChange({ value: e.target.value })}
      />
    );
  }

  // string / unknown
  return (
    <input
      className="input"
      style={{ flex: 1, minWidth: 160 }}
      placeholder="value"
      value={row.value ?? ""}
      aria-label="Value"
      onChange={(e) => onChange({ value: e.target.value })}
    />
  );
}

/* ─── Condition row ────────────────────────────────────────────────── */

function ConditionRowView({
  row,
  predicates,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  savedSegments,
  savedSegmentsLoading,
  currentSegmentId,
}: {
  row: ConditionRow;
  predicates: PredicateDefinition[];
  onChange: (patch: Partial<ConditionRow>) => void;
  onRemove: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  savedSegments: Segment[];
  savedSegmentsLoading: boolean;
  currentSegmentId?: string;
}): ReactElement {
  const fieldHelpId = useId();
  const comparatorHelpId = useId();
  const orderHelpId = useId();
  const supported = useMemo(
    () =>
      Array.isArray(predicates) ? predicates.filter(isSupportedPredicate) : [],
    [predicates],
  );
  const grouped = useMemo(() => groupByCategory(supported), [supported]);

  const predicate = useMemo(
    () =>
      Array.isArray(predicates)
        ? predicates.find((p) => p.key === row.field)
        : undefined,
    [predicates, row.field],
  );
  const comps = comparatorsFor(predicate);

  return (
    <fieldset className="visual-segment-condition">
      <legend>Condition</legend>
      <label className="visual-segment-negation">
        <input
          type="checkbox"
          checked={!!row.negated}
          onChange={(event) => onChange({ negated: event.target.checked })}
        />
        <span>Exclude matches for this condition</span>
      </label>

      <div className="visual-segment-condition-fields">
        <label className="visual-segment-control-label">
          <span>Field</span>
          <select
            className="input"
            value={row.field ?? ""}
            aria-describedby={predicate?.help ? fieldHelpId : undefined}
            onChange={(event) =>
              onChange({
                field: event.target.value,
                comparator: "",
                value: "",
                days: "",
              })
            }
          >
            <option value="">Select a field…</option>
            {grouped.map((group) => (
              <optgroup key={group.category} label={group.category}>
                {group.items.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label || item.key}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <label className="visual-segment-control-label">
          <span>Comparison</span>
          <select
            className="input pw-discoverable-unavailable"
            value={row.comparator ?? ""}
            aria-disabled={!row.field || undefined}
            aria-describedby={!row.field ? comparatorHelpId : undefined}
            onChange={(event) => {
              if (row.field) {
                onChange({
                  comparator: event.target.value,
                  value: "",
                  days: "",
                });
              }
            }}
          >
            <option value="">
              {row.field ? "Select a comparison…" : "Choose a field first"}
            </option>
            {(Array.isArray(comps) ? comps : []).map((comparator) => (
              <option key={comparator} value={comparator}>
                {comparatorLabel(comparator)}
              </option>
            ))}
          </select>
          {!row.field ? (
            <small id={comparatorHelpId} className="pw-action-status">
              Choose a field to make comparisons available.
            </small>
          ) : null}
        </label>

        <div className="visual-segment-value-field">
          <span>Value</span>
          <ValueInput
            row={row}
            predicate={predicate}
            onChange={onChange}
            savedSegments={savedSegments}
            savedSegmentsLoading={savedSegmentsLoading}
            currentSegmentId={currentSegmentId}
          />
          {!row.comparator ? (
            <small className="pw-action-status">
              Choose a comparison to enter a value.
            </small>
          ) : null}
        </div>
      </div>

      {predicate?.help ? (
        <p id={fieldHelpId} className="visual-segment-field-help">
          <strong>{predicate.label || predicate.key}:</strong> {predicate.help}
        </p>
      ) : null}

      <div className="visual-segment-row-actions">
        <span id={orderHelpId} className="pw-action-status">
          Rule order changes readability, not the selected AND/OR logic.
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-sm btn-ghost pw-discoverable-unavailable"
          onClick={() => onMoveUp?.()}
          aria-disabled={!onMoveUp || undefined}
          aria-describedby={orderHelpId}
        >
          Move up
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost pw-discoverable-unavailable"
          onClick={() => onMoveDown?.()}
          aria-disabled={!onMoveDown || undefined}
          aria-describedby={orderHelpId}
        >
          Move down
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={onRemove}
          aria-label="Remove this condition"
        >
          Remove condition
        </button>
      </div>
    </fieldset>
  );
}

/* ─── Group ────────────────────────────────────────────────────────── */

function GroupView({
  node,
  predicates,
  depth,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  savedSegments,
  savedSegmentsLoading,
  currentSegmentId,
}: {
  node: GroupNode;
  predicates: PredicateDefinition[];
  depth: number;
  onChange: (next: GroupNode) => void;
  /** Undefined for the root (root can't be removed). */
  onRemove?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  savedSegments: Segment[];
  savedSegmentsLoading: boolean;
  currentSegmentId?: string;
}): ReactElement {
  const children = Array.isArray(node.children) ? node.children : [];
  const orderHelpId = useId();

  const patchChild = (
    id: string,
    updater: (n: EditorNode) => EditorNode,
  ): void => {
    onChange({
      ...node,
      children: children.map((c) => (c.id === id ? updater(c) : c)),
    });
  };
  const removeChild = (id: string): void => {
    onChange({ ...node, children: children.filter((c) => c.id !== id) });
  };
  const moveChild = (id: string, offset: -1 | 1): void => {
    const from = children.findIndex((child) => child.id === id);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= children.length) return;
    const next = [...children];
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    onChange({ ...node, children: next });
  };
  const addRow = (): void => {
    onChange({ ...node, children: [...children, emptyRow()] });
  };
  const addGroup = (): void => {
    onChange({
      ...node,
      children: [...children, emptyGroup(node.op === "and" ? "or" : "and")],
    });
  };

  return (
    <section
      className="visual-segment-group"
      data-depth={depth}
      aria-label={depth === 0 ? "Audience rule set" : "Nested rule group"}
    >
      {/* Group header: AND/OR toggle + optional NOT + remove (non-root). */}
      <header className="visual-segment-group-header">
        <strong>{depth === 0 ? "Audience rule set" : "Nested group"}</strong>
        <ChoiceGroup
          legend={depth === 0 ? "Root rule logic" : "Nested rule logic"}
          value={node.op}
          onChange={(op) => onChange({ ...node, op })}
          className="tabs"
          optionClassName="tab"
          style={{ width: "auto" }}
          options={(["and", "or"] as const).map((op) => ({
            value: op,
            label: op.toUpperCase(),
            className: node.op === op ? "is-active" : undefined,
          }))}
        />
        <span className="muted visual-segment-logic-copy">
          {node.op === "and" ? "match all of" : "match any of"}
        </span>

        <label className="visual-segment-negation">
          <input
            type="checkbox"
            checked={!!node.negated}
            onChange={(event) =>
              onChange({ ...node, negated: event.target.checked })
            }
          />
          Exclude this entire group
        </label>

        <span className="spacer" style={{ flex: 1 }} />

        {onRemove ? (
          <div className="visual-segment-group-actions">
            <span id={orderHelpId} className="sr-only">
              Reordering changes readability, not the selected AND/OR logic.
            </span>
            <button
              type="button"
              className="btn btn-sm btn-ghost pw-discoverable-unavailable"
              onClick={() => onMoveUp?.()}
              aria-disabled={!onMoveUp || undefined}
              aria-describedby={orderHelpId}
            >
              Move up
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost pw-discoverable-unavailable"
              onClick={() => onMoveDown?.()}
              aria-disabled={!onMoveDown || undefined}
              aria-describedby={orderHelpId}
            >
              Move down
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={onRemove}
            >
              Remove group
            </button>
          </div>
        ) : null}
      </header>

      {/* Children */}
      {children.length === 0 ? (
        <div className="muted" style={{ fontSize: 12, padding: "4px 2px" }}>
          No conditions yet.
        </div>
      ) : (
        <div className="visual-segment-children">
          {children.map((c, index) =>
            c.kind === "condition" ? (
              <ConditionRowView
                key={c.id}
                row={c}
                predicates={predicates}
                onChange={(patch) =>
                  patchChild(c.id, (n) => ({
                    ...(n as ConditionRow),
                    ...patch,
                  }))
                }
                onRemove={() => removeChild(c.id)}
                onMoveUp={index > 0 ? () => moveChild(c.id, -1) : undefined}
                onMoveDown={
                  index < children.length - 1
                    ? () => moveChild(c.id, 1)
                    : undefined
                }
                savedSegments={savedSegments}
                savedSegmentsLoading={savedSegmentsLoading}
                currentSegmentId={currentSegmentId}
              />
            ) : (
              <GroupView
                key={c.id}
                node={c}
                predicates={predicates}
                depth={depth + 1}
                onChange={(next) => patchChild(c.id, () => next)}
                onRemove={() => removeChild(c.id)}
                onMoveUp={index > 0 ? () => moveChild(c.id, -1) : undefined}
                onMoveDown={
                  index < children.length - 1
                    ? () => moveChild(c.id, 1)
                    : undefined
                }
                savedSegments={savedSegments}
                savedSegmentsLoading={savedSegmentsLoading}
                currentSegmentId={currentSegmentId}
              />
            ),
          )}
        </div>
      )}

      {/* Add controls */}
      <div className="visual-segment-add-actions">
        <button type="button" className="btn btn-sm" onClick={addRow}>
          Add condition
        </button>
        {/* Only allow one level of nesting (root → sub-group). */}
        {depth < 1 ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={addGroup}
          >
            Add nested group
          </button>
        ) : null}
      </div>
    </section>
  );
}

/* ─── Preview chip (drives off the built AST) ──────────────────────── */

type PreviewState =
  | { kind: "idle" }
  | { kind: "waiting" }
  | { kind: "loading" }
  | { kind: "ok"; count: number; capped: boolean; ms: number }
  | { kind: "err"; failure: RemoteFailure };

function PreviewChip({ ast }: { ast: unknown | null }): ReactElement {
  const [state, setState] = useState<PreviewState>({ kind: "idle" });
  const [retryNonce, setRetryNonce] = useState(0);
  const key = useMemo(() => {
    if (!ast) return "";
    try {
      return JSON.stringify(ast);
    } catch {
      return "";
    }
  }, [ast]);

  useEffect(() => {
    if (!key) {
      setState({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setState({ kind: "waiting" });
    const id = window.setTimeout(() => {
      setState({ kind: "loading" });
      void (async (): Promise<void> => {
        try {
          const result = await segmentsClient.previewCount({
            queryAst: JSON.parse(key),
          });
          if (cancelled) return;
          if (result.error) {
            setState({
              kind: "err",
              failure: remoteFailureFromError(result.error),
            });
            return;
          }
          const data = result.data;
          if (
            !Number.isFinite(data.count) ||
            data.count < 0 ||
            !Number.isFinite(data.computed_in_ms) ||
            data.computed_in_ms < 0
          ) {
            setState({
              kind: "err",
              failure: remoteFailureFromError({
                kind: "parse",
                code: "invalid_preview_response",
              }),
            });
            return;
          }
          setState({
            kind: "ok",
            count: Math.floor(data.count),
            capped: !!data.capped,
            ms: Math.round(data.computed_in_ms),
          });
        } catch {
          if (!cancelled) {
            setState({
              kind: "err",
              failure: remoteFailureFromError({ kind: "network" }),
            });
          }
        }
      })();
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [key, retryNonce]);

  if (state.kind === "idle") {
    return (
      <span className="muted" style={{ fontSize: 12 }}>
        Add a condition to preview the matching count.
      </span>
    );
  }
  if (state.kind === "waiting") {
    return (
      <span className="muted" role="status" aria-live="polite">
        Waiting for rule changes to settle before recomputing…
      </span>
    );
  }
  if (state.kind === "loading") {
    return (
      <span
        className="muted"
        style={{ fontSize: 12 }}
        aria-busy="true"
        aria-live="polite"
      >
        Computing…
      </span>
    );
  }
  if (state.kind === "err") {
    const diagnostics = [state.failure.code, state.failure.requestId]
      .filter(Boolean)
      .join(" · ");
    return (
      <span className="visual-segment-preview-error" role="alert">
        <span>
          <strong>Couldn&apos;t verify the matching count.</strong>{" "}
          {state.failure.message}
          {diagnostics ? (
            <span className="muted"> Reference: {diagnostics}.</span>
          ) : null}
        </span>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => setRetryNonce((value) => value + 1)}
        >
          Retry count
        </button>
      </span>
    );
  }
  return (
    <span
      className="visual-segment-preview-result"
      role="status"
      aria-live="polite"
    >
      <span className="tabular">
        {state.capped ? "At least " : ""}
        <strong>{state.count.toLocaleString()}</strong> matching subscriber
        {state.count === 1 ? "" : "s"}
      </span>
      <span className="muted">Computed in {state.ms.toLocaleString()} ms.</span>
      {state.capped ? (
        <span className="visual-segment-cap-notice">
          <span className="badge warning">Evaluation capped</span>
          <span className="muted">
            The 10-second evaluation budget was reached, so the true count is at
            least the value shown.
          </span>
        </span>
      ) : null}
    </span>
  );
}

/* ─── Top-level builder ────────────────────────────────────────────── */

interface RuleHistory {
  past: GroupNode[];
  present: GroupNode;
  future: GroupNode[];
}

function initialRuleRoot(): GroupNode {
  const group = emptyGroup("and");
  return { ...group, children: [emptyRow()] };
}

function useRuleHistory() {
  const [history, setHistory] = useState<RuleHistory>(() => ({
    past: [],
    present: initialRuleRoot(),
    future: [],
  }));

  const apply = useCallback((next: GroupNode): void => {
    setHistory((current) => {
      if (next === current.present) return current;
      return {
        past: [...current.past, current.present].slice(-50),
        present: next,
        future: [],
      };
    });
  }, []);

  const undo = useCallback((): void => {
    setHistory((current) => {
      const previous = current.past.at(-1);
      if (!previous) return current;
      return {
        past: current.past.slice(0, -1),
        present: previous,
        future: [current.present, ...current.future].slice(0, 50),
      };
    });
  }, []);

  const redo = useCallback((): void => {
    setHistory((current) => {
      const next = current.future[0];
      if (!next) return current;
      return {
        past: [...current.past, current.present].slice(-50),
        present: next,
        future: current.future.slice(1),
      };
    });
  }, []);

  return {
    root: history.present,
    apply,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  };
}

async function loadPredicateRegistry() {
  const result = await segmentsClient.registry();
  if (result.error) return { error: result.error };
  const registry = result.data;
  if (!registry || !Array.isArray(registry.predicates)) {
    return {
      error: {
        kind: "parse" as const,
        code: "invalid_predicate_registry",
      },
    };
  }
  return { data: registry };
}

async function loadReferencedSegments() {
  // `in_segment` is resolved by the API against `segments.id`. Directory
  // saved views live in the separate `saved_segments` table and are not
  // executable audience definitions, so their ids must never enter this AST.
  const result = await segmentsClient.list();
  if (result.error) return { error: result.error };
  if (!Array.isArray(result.data)) {
    return {
      error: {
        kind: "parse" as const,
        code: "invalid_canonical_segment_catalog",
      },
    };
  }
  return { data: result.data };
}

function useSingleFlightReload(reload: () => Promise<void>) {
  const operation = useSingleFlightOperation();
  const retry = useCallback(async (): Promise<void> => {
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    const request = operation.run(reload);
    if (request) await request;
  }, [operation, reload]);
  return { retry, active: operation.active };
}

function ruleCounts(node: GroupNode): { conditions: number; groups: number } {
  let conditions = 0;
  let groups = 1;
  for (const child of node.children) {
    if (child.kind === "condition") conditions += 1;
    else {
      const nested = ruleCounts(child);
      conditions += nested.conditions;
      groups += nested.groups;
    }
  }
  return { conditions, groups };
}

function shouldPreserveNativeUndo(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

export function VisualSegmentBuilder({
  onAstChange,
  onDirtyChange,
  currentSegmentId,
}: Props): ReactElement {
  const registry = useRemoteResource<PredicateRegistry>(loadPredicateRegistry, {
    identity: "visual-segment-predicate-registry",
  });
  const referencedSegments = useRemoteResource<Segment[]>(
    loadReferencedSegments,
    { identity: `visual-segment-references:${currentSegmentId ?? "new"}` },
  );
  const registryRetry = useSingleFlightReload(registry.reload);
  const referencesRetry = useSingleFlightReload(referencedSegments.reload);
  const history = useRuleHistory();
  const historyHelpId = useId();
  const builderRef = useRef<HTMLDivElement | null>(null);
  const root = history.root;
  const reg = registry.data;
  const predicates = Array.isArray(reg?.predicates) ? reg.predicates : [];
  const savedSegments = referencedSegments.data ?? [];
  const savedSegmentsLoading =
    referencedSegments.data === null &&
    (referencedSegments.transport === "idle" ||
      referencedSegments.transport === "loading");

  // Build the AST and lift it to the parent whenever the tree changes.
  const ast = useMemo(() => buildAst(root, predicates), [root, predicates]);
  const onAstChangeRef = useRef(onAstChange);
  onAstChangeRef.current = onAstChange;
  useEffect(() => {
    onAstChangeRef.current(ast);
  }, [ast]);
  const visualDirty =
    root.op !== "and" ||
    !!root.negated ||
    root.children.length !== 1 ||
    root.children[0]?.kind !== "condition" ||
    !!root.children[0].field ||
    !!root.children[0].comparator ||
    !!root.children[0].value ||
    !!root.children[0].days ||
    !!root.children[0].negated;
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  useEffect(() => {
    onDirtyChangeRef.current?.(visualDirty);
    return () => onDirtyChangeRef.current?.(false);
  }, [visualDirty]);

  useEffect(() => {
    const builder = builderRef.current;
    if (!builder) return;
    const handleHistoryKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (
        event.isComposing ||
        event.keyCode === 229 ||
        shouldPreserveNativeUndo(event.target) ||
        event.altKey ||
        (!event.ctrlKey && !event.metaKey) ||
        event.key.toLowerCase() !== "z"
      ) {
        return;
      }
      if (event.shiftKey) {
        if (!history.canRedo) return;
        history.redo();
      } else {
        if (!history.canUndo) return;
        history.undo();
      }
      event.preventDefault();
    };
    builder.addEventListener("keydown", handleHistoryKeyDown);
    return () => builder.removeEventListener("keydown", handleHistoryKeyDown);
  }, [
    history.canRedo,
    history.canUndo,
    history.redo,
    history.undo,
    registry.data,
  ]);

  if (
    registry.data === null &&
    (registry.transport === "idle" || registry.transport === "loading")
  ) {
    return (
      <div
        className="muted visual-segment-loading"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        Loading the field catalog…
      </div>
    );
  }

  if (!hasVerifiedRemoteData(registry)) {
    return (
      <div className="visual-segment-unavailable">
        <RemoteDataNotice
          resource={registry}
          label="segment field catalog"
          onRetry={() => void registryRetry.retry()}
        />
        <p className="pw-action-status" aria-live="polite">
          {registryRetry.active
            ? "Retrying the field catalog…"
            : "The visual builder needs a verified field catalog."}
        </p>
        <p className="muted">
          You can switch to the &ldquo;Describe&rdquo; tab to build this segment
          in plain language.
        </p>
      </div>
    );
  }

  const verifiedRegistry = registry.data;
  const noSupported = predicates.filter(isSupportedPredicate).length === 0;
  const supportedCount = predicates.filter(isSupportedPredicate).length;
  const unavailableCount = Math.max(0, predicates.length - supportedCount);
  const counts = ruleCounts(root);

  return (
    <div
      ref={builderRef}
      className="visual-segment-builder"
      role="group"
      aria-label="Visual audience rule builder"
    >
      <RemoteDataNotice
        resource={registry}
        label="segment field catalog"
        onRetry={() => void registryRetry.retry()}
      />
      <RemoteDataNotice
        resource={referencedSegments}
        label="referenced-segment choices"
        onRetry={() => void referencesRetry.retry()}
      />

      <header className="visual-segment-builder-toolbar">
        <div>
          <strong>Visual audience rules</strong>
          <p className="pw-action-status">
            {supportedCount.toLocaleString()} filterable field
            {supportedCount === 1 ? "" : "s"} · catalog{" "}
            {verifiedRegistry.registry_version || "version not reported"}
            {unavailableCount > 0
              ? ` · ${unavailableCount.toLocaleString()} unavailable field${unavailableCount === 1 ? "" : "s"} omitted`
              : ""}
          </p>
        </div>
        <div className="visual-segment-history-actions">
          <button
            type="button"
            className="btn btn-sm btn-ghost pw-discoverable-unavailable"
            onClick={() => {
              if (history.canUndo) history.undo();
            }}
            aria-disabled={!history.canUndo || undefined}
            aria-describedby={historyHelpId}
          >
            Undo
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost pw-discoverable-unavailable"
            onClick={() => {
              if (history.canRedo) history.redo();
            }}
            aria-disabled={!history.canRedo || undefined}
            aria-describedby={historyHelpId}
          >
            Redo
          </button>
        </div>
      </header>

      <p id={historyHelpId} className="pw-action-status" role="status">
        {counts.conditions.toLocaleString()} condition
        {counts.conditions === 1 ? "" : "s"} across{" "}
        {counts.groups.toLocaleString()} group
        {counts.groups === 1 ? "" : "s"}. Undo and redo retain up to 50 rule
        edits. Keyboard: Control or Command + Z; add Shift to redo.
      </p>

      {referencedSegments.transport === "loading" &&
      referencedSegments.data === null ? (
        <p className="pw-action-status" role="status" aria-live="polite">
          Verifying referenced-segment choices in the background…
        </p>
      ) : null}

      {Array.isArray(verifiedRegistry.warnings) &&
      verifiedRegistry.warnings.length > 0 ? (
        <p className="pw-action-status" role="status">
          The field catalog reported{" "}
          {verifiedRegistry.warnings.length.toLocaleString()} data availability
          warning{verifiedRegistry.warnings.length === 1 ? "" : "s"}; only
          compiler-supported fields are offered here.
        </p>
      ) : null}

      {noSupported ? (
        <div className="visual-segment-empty" role="status">
          No filterable fields are available for this workspace yet.
        </div>
      ) : (
        <GroupView
          node={root}
          predicates={predicates}
          depth={0}
          onChange={history.apply}
          savedSegments={savedSegments}
          savedSegmentsLoading={savedSegmentsLoading}
          currentSegmentId={currentSegmentId}
        />
      )}

      {/* The preview only makes sense when there's a control to add a
          condition. With no supported predicates the GroupView is hidden,
          so showing "Add a condition to preview…" would instruct the
          operator to do something they have no way to do. */}
      {noSupported ? null : (
        <div className="visual-segment-preview">
          <span className="muted visual-segment-preview-label">
            Live preview:
          </span>
          <PreviewChip ast={ast} />
        </div>
      )}
    </div>
  );
}
