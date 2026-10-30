/**
 * AuditDiff — pretty-prints the metadata payload of an audit_log row
 * as a before/after diff when both keys are present, falling back to
 * raw JSON otherwise. Refined Audit PR 1.
 *
 * Many audit emitters carry `{before: {...}, after: {...}}` pairs
 * (or `{old: ..., new: ...}` for older emitters). Surfacing the
 * delta visually saves the auditor a parse pass through nested JSON
 * — they see which fields changed at a glance.
 *
 * Refined Audit PR 4: deep-diff. The comparator now walks nested
 * objects + arrays so a one-leaf change inside a nested config blob
 * surfaces as "settings.notify.email: true → false" rather than
 * dumping the whole notify object on both sides. Implemented as a
 * recursive flattener keyed by dot-paths.
 */

import type { ReactElement } from "react";

interface Props {
  metadata: Record<string, unknown> | null | undefined;
}

type DiffRow =
  | { kind: "added"; key: string; after: unknown }
  | { kind: "removed"; key: string; before: unknown }
  | { kind: "changed"; key: string; before: unknown; after: unknown }
  | { kind: "unchanged"; key: string; value: unknown };

function pickPair(meta: Record<string, unknown>): {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
} {
  const b =
    (meta.before as Record<string, unknown> | undefined) ??
    (meta.old as Record<string, unknown> | undefined) ??
    (meta.previous as Record<string, unknown> | undefined) ??
    null;
  const a =
    (meta.after as Record<string, unknown> | undefined) ??
    (meta.new as Record<string, unknown> | undefined) ??
    (meta.current as Record<string, unknown> | undefined) ??
    null;
  if (!b || !a) return { before: null, after: null };
  return { before: b, after: a };
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Walk an object/array recursively and yield dot-path leaves. We
 *  flatten so the diff can compare per-leaf instead of per-top-level-
 *  key — a nested change shows up as "settings.notify.email" rather
 *  than dumping the whole notify object on both sides. */
function flatten(
  v: unknown,
  prefix: string,
  out: Map<string, unknown>,
): void {
  if (v === null || v === undefined) {
    out.set(prefix, v);
    return;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) {
      out.set(prefix, v);
      return;
    }
    v.forEach((item, i) => flatten(item, `${prefix}[${i}]`, out));
    return;
  }
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) {
      out.set(prefix, v);
      return;
    }
    for (const k of keys) {
      flatten(obj[k], prefix ? `${prefix}.${k}` : k, out);
    }
    return;
  }
  // Scalar (string / number / boolean).
  out.set(prefix, v);
}

function buildDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): DiffRow[] {
  const beforeFlat = new Map<string, unknown>();
  const afterFlat = new Map<string, unknown>();
  flatten(before, "", beforeFlat);
  flatten(after, "", afterFlat);
  const keys = new Set<string>([
    ...beforeFlat.keys(),
    ...afterFlat.keys(),
  ]);
  const rows: DiffRow[] = [];
  for (const k of [...keys].sort()) {
    const hasB = beforeFlat.has(k);
    const hasA = afterFlat.has(k);
    const b = beforeFlat.get(k);
    const a = afterFlat.get(k);
    const sameJSON = hasB && hasA && JSON.stringify(b) === JSON.stringify(a);
    if (!hasB && hasA) {
      rows.push({ kind: "added", key: k, after: a });
    } else if (hasB && !hasA) {
      rows.push({ kind: "removed", key: k, before: b });
    } else if (sameJSON) {
      rows.push({ kind: "unchanged", key: k, value: b });
    } else {
      rows.push({ kind: "changed", key: k, before: b, after: a });
    }
  }
  return rows;
}

export function AuditDiff({ metadata }: Props): ReactElement {
  const hasMeta =
    metadata && typeof metadata === "object" && Object.keys(metadata).length > 0;
  if (!hasMeta) {
    return (
      <div className="muted" style={{ fontSize: 12 }}>
        —
      </div>
    );
  }
  const { before, after } = pickPair(metadata as Record<string, unknown>);
  if (!before || !after) {
    // Fall through — pretty-print the whole blob.
    return (
      <pre
        className="muted mono pw-pre"
        style={{
          fontSize: 11,
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
        }}
      >
        {JSON.stringify(metadata, null, 2)}
      </pre>
    );
  }
  const diff = buildDiff(before, after);
  const changed = diff.filter(
    (d) => d.kind !== "unchanged",
  );
  if (changed.length === 0) {
    return (
      <div className="muted" style={{ fontSize: 12 }}>
        Before and after payloads are identical.
      </div>
    );
  }
  return (
    <div className="audit-diff" role="region" aria-label="Before/after diff">
      {changed.map((d, i) => {
        if (d.kind === "added") {
          return (
            <div key={i} className="audit-diff-row is-added">
              <span className="audit-diff-key">{d.key}</span>
              <span className="audit-diff-marker">+</span>
              <span className="audit-diff-after mono">{fmt(d.after)}</span>
            </div>
          );
        }
        if (d.kind === "removed") {
          return (
            <div key={i} className="audit-diff-row is-removed">
              <span className="audit-diff-key">{d.key}</span>
              <span className="audit-diff-marker">−</span>
              <span className="audit-diff-before mono">{fmt(d.before)}</span>
            </div>
          );
        }
        return (
          <div key={i} className="audit-diff-row is-changed">
            <span className="audit-diff-key">{d.key}</span>
            <span className="audit-diff-before mono">{fmt(d.before)}</span>
            <span className="audit-diff-arrow">→</span>
            <span className="audit-diff-after mono">{fmt(d.after)}</span>
          </div>
        );
      })}
    </div>
  );
}
