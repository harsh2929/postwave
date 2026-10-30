/**
 * Bounded JSON response visualizer for the API Playground.
 *
 * The transport retains the original response. This component builds a
 * deterministic display projection so a very wide, deeply nested, or
 * string-heavy response cannot create an unbounded React tree.
 */

import { type ReactElement, useMemo, useState } from "react";

interface Props {
  /** Already-parsed JSON value. */
  value: unknown;
  /** When present, renders this text in a bounded fallback <pre>. */
  rawFallback?: string;
  /** Describes the projected tree when it is used for schemas or examples. */
  ariaLabel?: string;
}

export const PLAYGROUND_JSON_VIEW_BUDGET = {
  maxDepth: 12,
  maxNodes: 1_000,
  maxStringCharacters: 65_536,
  maxStringCharactersPerValue: 4_096,
  maxRawCharacters: 65_536,
} as const;

const COLLAPSE_DEPTH = 2;

interface BoundedText {
  text: string;
  truncated: boolean;
  originalLength: number;
}

interface BoundedLeafNode {
  kind: "leaf";
  value: unknown;
  stringValue?: BoundedText;
}

interface BoundedObjectEntry {
  displayKey: BoundedText;
  reactKey: string;
  value: BoundedJSONNode;
}

interface BoundedObjectNode {
  kind: "object";
  entries: BoundedObjectEntry[];
  omittedEntries: number;
  omittedReason?: "depth" | "nodes";
  totalEntries: number;
}

interface BoundedArrayNode {
  kind: "array";
  entries: BoundedJSONNode[];
  omittedEntries: number;
  omittedReason?: "depth" | "nodes";
  totalEntries: number;
}

type BoundedJSONNode = BoundedLeafNode | BoundedObjectNode | BoundedArrayNode;

interface ProjectionSummary {
  circularValue: boolean;
  depthLimit: boolean;
  nodeLimit: boolean;
  stringLimit: boolean;
}

interface ProjectionState extends ProjectionSummary {
  nodes: number;
  stringCharacters: number;
}

interface BoundedProjection {
  node: BoundedJSONNode;
  summary: ProjectionSummary;
}

export function PlaygroundJSONView({
  value,
  rawFallback,
  ariaLabel = "JSON response",
}: Props): ReactElement {
  if (value === undefined && rawFallback != null) {
    return <RawFallback text={rawFallback} />;
  }
  return <BoundedTree value={value} ariaLabel={ariaLabel} />;
}

function BoundedTree({
  value,
  ariaLabel,
}: {
  value: unknown;
  ariaLabel: string;
}): ReactElement {
  const projection = useMemo(() => buildBoundedProjection(value), [value]);
  return (
    <>
      <TruncationNotice summary={projection.summary} />
      <div className="play-json" role="region" aria-label={ariaLabel}>
        <Node value={projection.node} depth={0} keyName={null} />
      </div>
    </>
  );
}

function buildBoundedProjection(value: unknown): BoundedProjection {
  const state: ProjectionState = {
    circularValue: false,
    depthLimit: false,
    nodeLimit: false,
    stringLimit: false,
    nodes: 0,
    stringCharacters: 0,
  };
  const node = projectNode(value, 0, state, new WeakSet<object>());
  return {
    node,
    summary: {
      circularValue: state.circularValue,
      depthLimit: state.depthLimit,
      nodeLimit: state.nodeLimit,
      stringLimit: state.stringLimit,
    },
  };
}

function projectNode(
  value: unknown,
  depth: number,
  state: ProjectionState,
  ancestors: WeakSet<object>,
): BoundedJSONNode {
  state.nodes += 1;
  if (typeof value === "string") {
    return { kind: "leaf", value, stringValue: boundText(value, state) };
  }
  if (value === null || typeof value !== "object") {
    return { kind: "leaf", value };
  }
  if (ancestors.has(value)) {
    state.circularValue = true;
    const marker = "[Circular]";
    return {
      kind: "leaf",
      value: marker,
      stringValue: boundText(marker, state),
    };
  }

  ancestors.add(value);
  const projected = Array.isArray(value)
    ? projectArray(value, depth, state, ancestors)
    : projectObject(value as Record<string, unknown>, depth, state, ancestors);
  ancestors.delete(value);
  return projected;
}

function projectArray(
  value: unknown[],
  depth: number,
  state: ProjectionState,
  ancestors: WeakSet<object>,
): BoundedArrayNode {
  const totalEntries = value.length;
  if (depth >= PLAYGROUND_JSON_VIEW_BUDGET.maxDepth && totalEntries > 0) {
    state.depthLimit = true;
    return {
      kind: "array",
      entries: [],
      totalEntries,
      omittedEntries: totalEntries,
      omittedReason: "depth",
    };
  }

  const entries: BoundedJSONNode[] = [];
  for (let index = 0; index < totalEntries; index += 1) {
    if (state.nodes >= PLAYGROUND_JSON_VIEW_BUDGET.maxNodes) {
      state.nodeLimit = true;
      return {
        kind: "array",
        entries,
        totalEntries,
        omittedEntries: totalEntries - index,
        omittedReason: "nodes",
      };
    }
    entries.push(projectNode(value[index], depth + 1, state, ancestors));
  }
  return { kind: "array", entries, totalEntries, omittedEntries: 0 };
}

function projectObject(
  value: Record<string, unknown>,
  depth: number,
  state: ProjectionState,
  ancestors: WeakSet<object>,
): BoundedObjectNode {
  const keys = Object.keys(value);
  const totalEntries = keys.length;
  if (depth >= PLAYGROUND_JSON_VIEW_BUDGET.maxDepth && totalEntries > 0) {
    state.depthLimit = true;
    return {
      kind: "object",
      entries: [],
      totalEntries,
      omittedEntries: totalEntries,
      omittedReason: "depth",
    };
  }

  const entries: BoundedObjectEntry[] = [];
  for (let index = 0; index < totalEntries; index += 1) {
    if (state.nodes >= PLAYGROUND_JSON_VIEW_BUDGET.maxNodes) {
      state.nodeLimit = true;
      return {
        kind: "object",
        entries,
        totalEntries,
        omittedEntries: totalEntries - index,
        omittedReason: "nodes",
      };
    }
    const key = keys[index]!;
    entries.push({
      displayKey: boundText(key, state),
      reactKey: key,
      value: projectNode(value[key], depth + 1, state, ancestors),
    });
  }
  return { kind: "object", entries, totalEntries, omittedEntries: 0 };
}

function boundText(value: string, state: ProjectionState): BoundedText {
  const remaining = Math.max(
    0,
    PLAYGROUND_JSON_VIEW_BUDGET.maxStringCharacters - state.stringCharacters,
  );
  const visibleLength = Math.min(
    value.length,
    PLAYGROUND_JSON_VIEW_BUDGET.maxStringCharactersPerValue,
    remaining,
  );
  state.stringCharacters += visibleLength;
  const truncated = visibleLength < value.length;
  if (truncated) state.stringLimit = true;
  return {
    text: value.slice(0, visibleLength),
    truncated,
    originalLength: value.length,
  };
}

interface NodeProps {
  value: BoundedJSONNode;
  depth: number;
  keyName: BoundedText | null;
}

function Node({ value, depth, keyName }: NodeProps): ReactElement {
  if (value.kind === "object") {
    return <CollapsibleObject value={value} depth={depth} keyName={keyName} />;
  }
  if (value.kind === "array") {
    return <CollapsibleArray value={value} depth={depth} keyName={keyName} />;
  }
  return (
    <div className="play-json-row" style={{ paddingLeft: depth * 14 }}>
      {keyName !== null ? <KeySpan name={keyName} /> : null}
      <LeafSpan node={value} />
    </div>
  );
}

function CollapsibleObject({
  value,
  depth,
  keyName,
}: {
  value: BoundedObjectNode;
  depth: number;
  keyName: BoundedText | null;
}): ReactElement {
  const [open, setOpen] = useState(depth < COLLAPSE_DEPTH);
  return (
    <div className="play-json-row play-json-block">
      <button
        type="button"
        className="play-json-disclosure"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        style={{ paddingLeft: depth * 14 }}
      >
        <Chevron open={open} />
        {keyName !== null ? <KeySpan name={keyName} /> : null}
        <span className="play-json-bracket">{"{"}</span>
        {!open ? <CountBadge count={value.totalEntries} noun="key" /> : null}
        {!open ? <span className="play-json-bracket">{"}"}</span> : null}
      </button>
      {open ? (
        <>
          {value.entries.map((entry) => (
            <Node
              key={entry.reactKey}
              value={entry.value}
              depth={depth + 1}
              keyName={entry.displayKey}
            />
          ))}
          <OmissionRow
            count={value.omittedEntries}
            noun="keys"
            reason={value.omittedReason}
            depth={depth + 1}
          />
          <ClosingBracket bracket="}" depth={depth} />
        </>
      ) : null}
    </div>
  );
}

function CollapsibleArray({
  value,
  depth,
  keyName,
}: {
  value: BoundedArrayNode;
  depth: number;
  keyName: BoundedText | null;
}): ReactElement {
  const [open, setOpen] = useState(depth < COLLAPSE_DEPTH);
  return (
    <div className="play-json-row play-json-block">
      <button
        type="button"
        className="play-json-disclosure"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        style={{ paddingLeft: depth * 14 }}
      >
        <Chevron open={open} />
        {keyName !== null ? <KeySpan name={keyName} /> : null}
        <span className="play-json-bracket">[</span>
        {!open ? <CountBadge count={value.totalEntries} noun="item" /> : null}
        {!open ? <span className="play-json-bracket">]</span> : null}
      </button>
      {open ? (
        <>
          {value.entries.map((entry, index) => (
            <Node
              key={index}
              value={entry}
              depth={depth + 1}
              keyName={{
                text: String(index),
                truncated: false,
                originalLength: String(index).length,
              }}
            />
          ))}
          <OmissionRow
            count={value.omittedEntries}
            noun="items"
            reason={value.omittedReason}
            depth={depth + 1}
          />
          <ClosingBracket bracket="]" depth={depth} />
        </>
      ) : null}
    </div>
  );
}

function CountBadge({
  count,
  noun,
}: {
  count: number;
  noun: string;
}): ReactElement {
  return (
    <span className="play-json-count">
      {count === 1 ? `1 ${noun}` : `${count.toLocaleString()} ${noun}s`}
    </span>
  );
}

function OmissionRow({
  count,
  noun,
  reason,
  depth,
}: {
  count: number;
  noun: "items" | "keys";
  reason?: "depth" | "nodes";
  depth: number;
}): ReactElement | null {
  if (count === 0 || !reason) return null;
  return (
    <div
      className="play-json-row play-json-omission"
      role="note"
      style={{ paddingLeft: depth * 14 }}
    >
      … {count.toLocaleString()} {noun} omitted at the {reason} limit.
    </div>
  );
}

function ClosingBracket({
  bracket,
  depth,
}: {
  bracket: "]" | "}";
  depth: number;
}): ReactElement {
  return (
    <div
      className="play-json-row play-json-close"
      style={{ paddingLeft: depth * 14 }}
    >
      <span className="play-json-bracket">{bracket}</span>
    </div>
  );
}

function KeySpan({ name }: { name: BoundedText }): ReactElement {
  return (
    <>
      <span className="play-json-key">
        &quot;{escapeStr(name.text)}
        {name.truncated ? (
          <TruncatedTextMarker originalLength={name.originalLength} />
        ) : null}
        &quot;
      </span>
      <span className="play-json-punct">:&nbsp;</span>
    </>
  );
}

function LeafSpan({ node }: { node: BoundedLeafNode }): ReactElement {
  const { value } = node;
  if (value === null) return <span className="play-json-null">null</span>;
  if (typeof value === "boolean") {
    return <span className="play-json-bool">{value ? "true" : "false"}</span>;
  }
  if (typeof value === "number") {
    return <span className="play-json-number">{value}</span>;
  }
  if (node.stringValue) {
    return (
      <span className="play-json-string">
        &quot;{escapeStr(node.stringValue.text)}
        {node.stringValue.truncated ? (
          <TruncatedTextMarker
            originalLength={node.stringValue.originalLength}
          />
        ) : null}
        &quot;
      </span>
    );
  }
  return <span>{String(value)}</span>;
}

function TruncatedTextMarker({
  originalLength,
}: {
  originalLength: number;
}): ReactElement {
  return (
    <span
      className="play-json-string-truncation"
      aria-label={`String shortened from ${originalLength.toLocaleString()} characters`}
    >
      …
    </span>
  );
}

function TruncationNotice({
  summary,
}: {
  summary: ProjectionSummary;
}): ReactElement | null {
  if (
    !summary.circularValue &&
    !summary.depthLimit &&
    !summary.nodeLimit &&
    !summary.stringLimit
  ) {
    return null;
  }
  return (
    <div
      className="play-json-truncation"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      Response preview was bounded for safety. The visualizer renders at most{" "}
      {PLAYGROUND_JSON_VIEW_BUDGET.maxNodes.toLocaleString()} values,{" "}
      {PLAYGROUND_JSON_VIEW_BUDGET.maxDepth} nested levels, and{" "}
      {PLAYGROUND_JSON_VIEW_BUDGET.maxStringCharacters.toLocaleString()} string
      characters. The response value itself was not changed.
    </div>
  );
}

function Chevron({ open }: { open: boolean }): ReactElement {
  return (
    <svg
      width={10}
      height={10}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 100ms ease-out",
        marginRight: 4,
      }}
    >
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

function RawFallback({ text }: { text: string }): ReactElement {
  const truncated = text.length > PLAYGROUND_JSON_VIEW_BUDGET.maxRawCharacters;
  const visible = truncated
    ? text.slice(0, PLAYGROUND_JSON_VIEW_BUDGET.maxRawCharacters)
    : text;
  return (
    <>
      {truncated ? (
        <div
          className="play-json-truncation"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          Response preview was truncated after{" "}
          {PLAYGROUND_JSON_VIEW_BUDGET.maxRawCharacters.toLocaleString()} text
          characters for safety. The response value itself was not changed.
        </div>
      ) : null}
      <pre className="play-json-raw" aria-label="Raw response">
        <code>{visible || "(empty response)"}</code>
        {truncated ? (
          <span
            className="play-json-string-truncation"
            aria-label={`Response text shortened from ${text.length.toLocaleString()} characters`}
          >
            …
          </span>
        ) : null}
      </pre>
    </>
  );
}

/** Show newlines and tabs as escaped text so one string stays on one row. */
function escapeStr(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}
