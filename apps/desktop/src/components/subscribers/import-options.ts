/**
 * import-options.ts — pure client-side helpers for the subscriber
 * import wizard's job-level options (verified consent, job tags,
 * property auto-creation).
 *
 * Mirrors the server contract in
 * apps/api/internal/subscriber_import/options.go +
 * subscriber_import.go (validatePatch / normalizeTags /
 * canonicalizeMapping / propertyCandidatesFromMapping) so the wizard
 * rejects bad input before the PATCH round-trip — with the exact same
 * limits the server enforces, not looser ones.
 *
 * Pure module (no React, no DOM) so it is unit-testable under the
 * node vitest environment, same pattern as subscriber-status.ts.
 */

import type {
  SubscriberImportDryRunResults,
  SubscriberImportMappingContract,
  SubscriberImportMappingKind,
  SubscriberImportPatchInput,
  SubscriberImportStrategy,
} from "../../lib/api/subscriber-data-operations";
import {
  buildImportConsentPatch,
  type ImportConsentDraft,
} from "./consent-evidence";

/** Server caps — keep in lockstep with options.go. */
export const MAX_IMPORT_TAGS = 20;
export const MAX_TAG_LENGTH = 100;
export const MAX_TAG_BYTES = 400;

export interface TagAddResult {
  /** The new chip list — unchanged from `existing` when error != null. */
  tags: string[];
  error: string | null;
}

/**
 * addTags — fold raw chip-input text (may contain commas, e.g. a
 * pasted "a, b, c") into the existing chip list. Mirrors the server's
 * normalizeTags: trim, drop empties, dedupe case-insensitively preserving
 * order, ≤100 Unicode code points / 400 UTF-8 bytes each, ≤20 total. On any violation the existing
 * list is returned untouched alongside the error.
 */
export function addTags(existing: string[], raw: string): TagAddResult {
  const parts = raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (parts.length === 0) return { tags: existing, error: null };
  const out = [...existing];
  const seen = new Set(existing.map((tag) => tag.toLocaleLowerCase("en-US")));
  for (const t of parts) {
    if (
      Array.from(t).length > MAX_TAG_LENGTH ||
      new TextEncoder().encode(t).byteLength > MAX_TAG_BYTES
    ) {
      return {
        tags: existing,
        error: `Tags must be ${MAX_TAG_LENGTH} characters or fewer.`,
      };
    }
    const key = t.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    if (out.length >= MAX_IMPORT_TAGS) {
      return {
        tags: existing,
        error: `At most ${MAX_IMPORT_TAGS} tags per import.`,
      };
    }
    seen.add(key);
    out.push(t);
  }
  return { tags: out, error: null };
}

export interface ImportOptionsDraft {
  strategy: SubscriberImportStrategy;
  consent: ImportConsentDraft;
  tags: string[];
  autoCreateProperties: boolean;
}

/**
 * buildImportOptionsPatch — validate the whole draft and produce the
 * PATCH body (the complete consent contract or explicit no-proof clear,
 * plus tags/properties and
 * existing on_existing). Returns null when any field fails its
 * server-mirrored validation; callers surface the per-field errors.
 */
export function buildImportOptionsPatch(
  d: ImportOptionsDraft,
  now = Date.now(),
): Omit<SubscriberImportPatchInput, "configuration_revision"> | null {
  const consent = buildImportConsentPatch(d.consent, now);
  if (!consent) return null;
  if (d.tags.length > MAX_IMPORT_TAGS) return null;
  if (
    d.tags.some(
      (t) =>
        t.trim() === "" ||
        Array.from(t).length > MAX_TAG_LENGTH ||
        new TextEncoder().encode(t).byteLength > MAX_TAG_BYTES,
    ) ||
    new Set(d.tags.map((tag) => tag.trim().toLocaleLowerCase("en-US"))).size !==
      d.tags.length
  ) {
    return null;
  }
  return {
    on_existing: d.strategy,
    ...consent,
    tags: d.tags.map((tag) => tag.trim()),
    auto_create_properties: d.autoCreateProperties,
  };
}

export function importPreflightIsFresh(
  results: SubscriberImportDryRunResults | null,
  now = Date.now(),
): results is SubscriberImportDryRunResults {
  return Boolean(
    results?.authoritative === true &&
      Number.isFinite(Date.parse(results.validated_at)) &&
      Number.isFinite(Date.parse(results.expires_at)) &&
      Date.parse(results.validated_at) <= now &&
      Date.parse(results.expires_at) > now &&
      results.preflight_fingerprint.length === 64 &&
      results.state_fingerprint.length === 64 &&
      results.catalog_fingerprint.length === 64,
  );
}

/**
 * validPropertyKey — mirror of the server's validPropertyKey
 * (options.go): lowercase alphanumeric + underscore, starting with a
 * letter, ≤64 chars. Keys that don't fit are skipped server-side, so
 * the wizard must not promise to create them.
 */
function validPropertyKey(s: string): boolean {
  if (s === "" || s.length > 64) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const lower = c >= "a" && c <= "z";
    const digit = c >= "0" && c <= "9";
    const ok = lower || (i > 0 && (digit || c === "_"));
    if (!ok) return false;
  }
  return true;
}

/**
 * propertyCandidatesFromMapping — the registry keys the server's
 * auto_create_properties pass would create from a preview mapping:
 * every kind=custom column's canonical custom_key, with
 * invalid keys filtered and duplicates collapsed — the exact mirror
 * of propertyCandidatesFromMapping in options.go.
 */
export function propertyCandidatesFromMapping(mapping: unknown): string[] {
  const cols = Array.isArray((mapping as { columns?: unknown })?.columns)
    ? (
        mapping as {
          columns: Array<{ name?: string; kind?: string; custom_key?: string }>;
        }
      ).columns
    : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of cols) {
    let key = "";
    if (c.kind === "custom") key = c.custom_key || "";
    else continue;
    if (!validPropertyKey(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/* ===================================================================
 * SUB-102 — per-column mapping overrides
 *
 * The preview's mapping.columns array is the source of truth. The
 * operator can remap each column to a canonical merge-field kind, to a
 * registered custom field (kind=custom + custom_key), or skip it
 * (kind=ignore). These helpers are pure mirrors of the server's
 * validateMappingOverride contract (subscriber_import.go), so the
 * wizard rejects/warns before the PATCH round-trip.
 * ================================================================== */

/** One column as it travels through the wizard's mapping editor. */
export interface ImportMappingColumn {
  index: number;
  name: string;
  kind: SubscriberImportMappingKind;
  /** Set only when kind === "custom"; the registered field's key. */
  custom_key?: string;
}

/** The mapping shape persisted in subscriber_imports.mapping (JSONB) and
 * echoed back by the preview / GET — only the fields the wizard touches. */
export interface ImportMapping {
  path: string;
  headers: string[];
  columns: ImportMappingColumn[];
  rows: number;
}

export interface ImportMappingConflictSource {
  index: number;
  name: string;
}

export interface ImportMappingConflict {
  /** Stable normalized key, e.g. `name` or `custom:company`. */
  target: string;
  /** Human-readable target used in review and inline errors. */
  label: string;
  /** Every source column assigned to this target, in file order. */
  sources: ImportMappingConflictSource[];
}

/** Canonical merge kinds that, if assigned to two different columns,
 * collide on a single merge target (e.g. two "name" columns). "custom"
 * and "ignore" can repeat freely — custom collisions are caught per
 * custom_key, and ignore is "skip" which is unbounded. */
const SINGLETON_MERGE_KINDS = new Set<string>([
  "email",
  "name",
  "tags",
]);

const IMPORT_MAPPING_KINDS = new Set<SubscriberImportMappingKind>([
  "email",
  "name",
  "tags",
  "custom",
  "ignore",
]);

/**
 * readMappingColumns — defensively extract the columns array from a
 * preview's `mapping` (which the API client types as `unknown`).
 * Returns a fresh, normalised array safe to edit; missing fields get
 * sensible defaults so the editor never renders undefined.
 */
export function readMappingColumns(mapping: unknown): ImportMappingColumn[] {
  const cols = Array.isArray((mapping as { columns?: unknown })?.columns)
    ? (
        mapping as {
          columns: Array<{
            index?: number;
            name?: string;
            kind?: string;
            custom_key?: string;
          }>;
        }
      ).columns
    : [];
  return cols.map((c, i) => ({
    index: Number.isSafeInteger(c.index) ? (c.index as number) : i,
    name: typeof c.name === "string" ? c.name : `col-${i}`,
    kind: IMPORT_MAPPING_KINDS.has(c.kind as SubscriberImportMappingKind)
      ? (c.kind as SubscriberImportMappingKind)
      : "ignore",
    custom_key:
      c.kind === "custom"
        ? (c.custom_key || c.name || "").toLowerCase()
        : undefined,
  }));
}

/**
 * applyColumnKind — produce a new columns array with column `index`
 * remapped to `kind`. When the new kind is "custom" the supplied
 * `customKey` is attached (defaults to the column name lowercased);
 * otherwise any stale custom_key is dropped. Pure — never mutates input.
 */
export function applyColumnKind(
  cols: ImportMappingColumn[],
  index: number,
  kind: SubscriberImportMappingKind,
  customKey?: string,
): ImportMappingColumn[] {
  return cols.map((c) => {
    if (c.index !== index) return c;
    if (kind === "custom") {
      const key = (customKey ?? c.custom_key ?? c.name ?? "")
        .trim()
        .toLowerCase();
      return { ...c, kind, custom_key: key };
    }
    return { ...c, kind, custom_key: undefined };
  });
}

/**
 * duplicateMergeTargets — list the human-readable merge targets that two
 * or more columns map onto, so the wizard can warn (e.g. two columns
 * both mapped to "name"). Singleton merge kinds collide by kind; custom
 * fields collide by custom_key. "ignore" never collides.
 * Returns an empty array when the mapping is unambiguous.
 */
export function mappingTargetConflicts(
  cols: ImportMappingColumn[],
): ImportMappingConflict[] {
  const assignments = new Map<string, ImportMappingConflictSource[]>();
  for (const c of cols) {
    let target: string | null = null;
    if (SINGLETON_MERGE_KINDS.has(c.kind)) {
      target = c.kind;
    } else if (c.kind === "custom") {
      const key = (c.custom_key || "").trim().toLowerCase();
      if (key !== "") target = `custom:${key}`;
    }
    if (target == null) continue;
    const sources = assignments.get(target) ?? [];
    sources.push({ index: c.index, name: c.name });
    assignments.set(target, sources);
  }
  const conflicts: ImportMappingConflict[] = [];
  for (const [target, sources] of assignments) {
    if (sources.length < 2) continue;
    conflicts.push({
      target,
      label: target.startsWith("custom:")
        ? `custom field "${target.slice("custom:".length)}"`
        : target,
      sources,
    });
  }
  return conflicts;
}

/** Backwards-compatible target labels for summary-only consumers. */
export function duplicateMergeTargets(cols: ImportMappingColumn[]): string[] {
  return mappingTargetConflicts(cols).map((conflict) => conflict.label);
}

/**
 * mappingHasEmail — the server's preview refuses an import without an
 * email column, and a remap that drops the last email column would be
 * rejected. The wizard mirrors that so the operator gets the warning
 * inline rather than a PATCH/confirm error.
 */
export function mappingHasEmail(cols: ImportMappingColumn[]): boolean {
  return cols.some((c) => c.kind === "email");
}

/** The mapping can leave review only when it has one email source and no
 * destination receives more than one source column. */
export function mappingIsReady(cols: ImportMappingColumn[]): boolean {
  return (
    cols.length > 0 &&
    new Set(cols.map((column) => column.index)).size === cols.length &&
    cols.every(
      (column) =>
        Number.isSafeInteger(column.index) &&
        column.index >= 0 &&
        column.index < cols.length &&
        column.name.trim() !== "" &&
        IMPORT_MAPPING_KINDS.has(column.kind) &&
        (column.kind !== "custom" || validPropertyKey(column.custom_key ?? "")) &&
        (column.kind === "custom" || column.custom_key === undefined),
    ) &&
    mappingHasEmail(cols) &&
    cols.filter((column) => column.kind === "email").length === 1 &&
    mappingTargetConflicts(cols).length === 0
  );
}

export function mappingPatchError(
  original: unknown,
  cols: ImportMappingColumn[],
): string | null {
  const base = original as Partial<SubscriberImportMappingContract> | null;
  if (
    !base ||
    !Array.isArray(base.headers) ||
    typeof base.path !== "string" ||
    !Number.isSafeInteger(base.rows) ||
    base.headers.length !== cols.length
  ) {
    return "The server mapping is incomplete. Upload the file again before continuing.";
  }
  if (!mappingIsReady(cols)) {
    return "Map every source column exactly once, keep one Email destination, and resolve invalid or duplicate targets.";
  }
  for (const column of cols) {
    if (base.headers[column.index] !== column.name) {
      return "The CSV header geometry changed after preview. Upload the file again before continuing.";
    }
  }
  return null;
}

/**
 * buildMappingPatch — assemble the `mapping` PATCH body from the edited
 * columns, preserving the preview's other mapping fields (path/headers/
 * rows) so the server-side override merge keeps the file metadata.
 */
export function buildMappingPatch(
  original: unknown,
  cols: ImportMappingColumn[],
): SubscriberImportMappingContract | null {
  if (mappingPatchError(original, cols)) return null;
  const base = original as SubscriberImportMappingContract;
  return {
    path: base.path,
    headers: [...base.headers],
    rows: base.rows,
    columns: [...cols]
      .sort((a, b) => a.index - b.index)
      .map((c) =>
      c.kind === "custom"
        ? {
            index: c.index,
            name: c.name,
            kind: c.kind,
            custom_key: (c.custom_key || c.name || "").trim().toLowerCase(),
          }
        : { index: c.index, name: c.name, kind: c.kind },
      ),
  };
}
