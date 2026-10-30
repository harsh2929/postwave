/**
 * lib/auditDiff.ts — pure before/after flattener for an audit row's
 * metadata blob. Ported from apps/desktop/src/components/audit/AuditDiff.tsx
 * so both clients answer "what actually changed?" the same way.
 *
 * Many audit emitters carry `{before: {...}, after: {...}}` (older ones use
 * `old`/`new` or `previous`/`current`). Comparing per dot-path LEAF rather
 * than per top-level key means a one-field change inside a nested config
 * blob reads as `settings.notify.email: true → false` instead of dumping
 * the whole `notify` object twice.
 *
 * Mobile-specific hardening the desktop version does not need:
 *   - a recursion depth cap, because the payload is an unvalidated
 *     `as`-cast wire shape and a cyclic / pathological blob would
 *     otherwise blow the JS stack on device;
 *   - a row cap, because a 5,000-leaf diff inside a modal is not a
 *     readable artefact, it is a scroll hazard.
 */

export type AuditDiffRow =
  | { kind: "added"; key: string; after: string }
  | { kind: "removed"; key: string; before: string }
  | { kind: "changed"; key: string; before: string; after: string };

export interface AuditMetadataView {
  /** Changed/added/removed leaves, sorted by path. Empty when no pair. */
  diff: AuditDiffRow[];
  /** True when the metadata carried a recognised before/after pair. */
  hasPair: boolean;
  /** Leaves omitted because the diff hit MAX_DIFF_ROWS. */
  truncatedRows: number;
  /** Flattened non-pair metadata leaves, for the "raw" readout. */
  entries: { key: string; value: string }[];
  /** Leaves omitted from `entries` because it hit MAX_ENTRY_ROWS. */
  truncatedEntries: number;
}

const MAX_DEPTH = 8;
const MAX_DIFF_ROWS = 60;
const MAX_ENTRY_ROWS = 60;

/** Render any leaf as a short, stable string. */
export function formatAuditValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v === "" ? '""' : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function flatten(
  value: unknown,
  prefix: string,
  out: Map<string, unknown>,
  depth: number,
): void {
  if (value === null || value === undefined) {
    out.set(prefix, value);
    return;
  }
  if (depth >= MAX_DEPTH) {
    out.set(prefix, value);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.set(prefix, value);
      return;
    }
    value.forEach((item, i) => flatten(item, `${prefix}[${i}]`, out, depth + 1));
    return;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) {
      out.set(prefix, value);
      return;
    }
    for (const k of keys) {
      flatten(obj[k], prefix ? `${prefix}.${k}` : k, out, depth + 1);
    }
    return;
  }
  out.set(prefix, value);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * Pick the before/after pair, tolerating the three emitter spellings.
 * Both halves must be objects — a `{before: "x"}` string pair is not a
 * structured change and falls through to the raw readout.
 */
export function pickAuditPair(meta: Record<string, unknown>): {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
} | null {
  const before = asRecord(meta.before ?? meta.old ?? meta.previous);
  const after = asRecord(meta.after ?? meta.new ?? meta.current);
  if (!before || !after) return null;
  return { before, after };
}

/**
 * buildAuditMetadataView — the single entry point the row-detail sheet
 * renders. Always returns something useful: a leaf diff when the row
 * carries a before/after pair, otherwise the flattened raw metadata.
 * Unchanged leaves are deliberately dropped — on a phone the answer to
 * "what changed" must not be buried in forty identical rows.
 */
export function buildAuditMetadataView(
  metadata: Record<string, unknown> | null | undefined,
): AuditMetadataView {
  const empty: AuditMetadataView = {
    diff: [],
    hasPair: false,
    truncatedRows: 0,
    entries: [],
    truncatedEntries: 0,
  };
  if (!metadata || typeof metadata !== "object") return empty;

  const pair = pickAuditPair(metadata);
  if (pair) {
    const beforeFlat = new Map<string, unknown>();
    const afterFlat = new Map<string, unknown>();
    flatten(pair.before, "", beforeFlat, 0);
    flatten(pair.after, "", afterFlat, 0);
    const keys = [
      ...new Set([...beforeFlat.keys(), ...afterFlat.keys()]),
    ].sort();
    const diff: AuditDiffRow[] = [];
    let truncatedRows = 0;
    for (const key of keys) {
      const hasBefore = beforeFlat.has(key);
      const hasAfter = afterFlat.has(key);
      const before = formatAuditValue(beforeFlat.get(key));
      const after = formatAuditValue(afterFlat.get(key));
      if (hasBefore && hasAfter && before === after) continue;
      if (diff.length >= MAX_DIFF_ROWS) {
        truncatedRows += 1;
        continue;
      }
      if (!hasBefore) diff.push({ kind: "added", key, after });
      else if (!hasAfter) diff.push({ kind: "removed", key, before });
      else diff.push({ kind: "changed", key, before, after });
    }
    return { diff, hasPair: true, truncatedRows, entries: [], truncatedEntries: 0 };
  }

  const flat = new Map<string, unknown>();
  flatten(metadata, "", flat, 0);
  const all = [...flat.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const entries = all
    .slice(0, MAX_ENTRY_ROWS)
    .map(([key, value]) => ({ key, value: formatAuditValue(value) }));
  return {
    diff: [],
    hasPair: false,
    truncatedRows: 0,
    entries,
    truncatedEntries: Math.max(0, all.length - entries.length),
  };
}

/**
 * A one-line summary for the list row: "3 fields changed" / "12 details".
 * Returns null when there is nothing worth opening the sheet for, so the
 * row can hide the affordance instead of promising an empty detail view.
 */
export function auditMetadataSummary(
  view: AuditMetadataView,
): string | null {
  if (view.hasPair) {
    const n = view.diff.length + view.truncatedRows;
    if (n === 0) return null;
    return `${n} field${n === 1 ? "" : "s"} changed`;
  }
  const n = view.entries.length + view.truncatedEntries;
  if (n === 0) return null;
  return `${n} detail${n === 1 ? "" : "s"}`;
}
