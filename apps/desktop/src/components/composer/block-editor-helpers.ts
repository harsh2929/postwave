/**
 * block-editor-helpers — pure logic behind composer/BlockEditor.tsx.
 *
 * The block editor maintains an ordered list of `EmailBlockInstance`
 * rows ({block_id, config}) built from the server catalog
 * (GET /email-blocks/catalog) and composes them into MJML via
 * POST /email-blocks/compose. Everything here is side-effect free so
 * it runs under the node-env vitest suite without a JSX transform.
 *
 * Invariants:
 *   1. All list operations are immutable — they return a NEW array
 *      (or the original reference when the operation is a no-op) so
 *      React state updates stay referentially honest.
 *   2. `defaultConfigFor` seeds every field key declared in the
 *      catalog spec, merging the server's `defaults` on top, so the
 *      field editor never renders an `undefined` controlled input.
 *   3. `coerceFieldValue` mirrors the loose typing the Go composer
 *      expects (it stringifies via `str()` / numeric helpers): number
 *      fields become real numbers when parseable, bools stay bools,
 *      everything else passes through as the raw string.
 */

import type {
  EmailBlock,
  EmailBlockBrandDefaults,
  EmailBlockComposeInput,
  EmailBlockFieldSpec,
  EmailBlockInstance,
} from "../../lib/api-client";

/** Seed value for a field that has no catalog default. */
function emptyValueFor(spec: EmailBlockFieldSpec): unknown {
  if (spec.type === "bool") return false;
  if (spec.type === "select") return spec.options?.[0] ?? "";
  return "";
}

/**
 * Build the initial config for a new instance of `block`: every
 * declared field gets a value (server default when present, a
 * type-appropriate empty otherwise). Server defaults for keys NOT in
 * the field list (hidden plumbing like feed ids) are preserved too.
 */
export function defaultConfigFor(block: EmailBlock): Record<string, unknown> {
  const config: Record<string, unknown> = { ...(block.defaults ?? {}) };
  for (const field of block.fields ?? []) {
    if (!(field.key in config)) {
      config[field.key] = emptyValueFor(field);
    }
  }
  return config;
}

/** New canvas row for a catalog block. */
export function createInstance(block: EmailBlock): EmailBlockInstance {
  return { block_id: block.id, config: defaultConfigFor(block) };
}

/** Append a new instance of `block`. */
export function addInstance(
  list: EmailBlockInstance[],
  block: EmailBlock,
): EmailBlockInstance[] {
  return [...list, createInstance(block)];
}

/** Remove the instance at `index`; out-of-range is a no-op. */
export function removeInstanceAt(
  list: EmailBlockInstance[],
  index: number,
): EmailBlockInstance[] {
  if (index < 0 || index >= list.length) return list;
  return [...list.slice(0, index), ...list.slice(index + 1)];
}

/**
 * Move the instance at `index` by `delta` positions (-1 = up,
 * +1 = down). Moves that would leave the array are no-ops returning
 * the original reference, so callers can disable buttons lazily.
 */
export function moveInstance(
  list: EmailBlockInstance[],
  index: number,
  delta: -1 | 1,
): EmailBlockInstance[] {
  const target = index + delta;
  if (index < 0 || index >= list.length) return list;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  const [row] = next.splice(index, 1);
  next.splice(target, 0, row!);
  return next;
}

/** Immutably set one config key on the instance at `index`. */
export function setInstanceField(
  list: EmailBlockInstance[],
  index: number,
  key: string,
  value: unknown,
): EmailBlockInstance[] {
  const row = list[index];
  if (!row) return list;
  const next = [...list];
  next[index] = { ...row, config: { ...row.config, [key]: value } };
  return next;
}

/**
 * Convert a raw input value to the type the field spec implies.
 * Numbers parse strictly (empty / non-numeric input stays a string so
 * the operator sees exactly what they typed); bools pass through.
 */
export function coerceFieldValue(
  spec: EmailBlockFieldSpec,
  raw: string | boolean,
): unknown {
  if (spec.type === "bool") return raw === true || raw === "true";
  if (typeof raw === "boolean") return raw;
  if (spec.type === "number") {
    const trimmed = raw.trim();
    if (trimmed === "") return "";
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : raw;
  }
  return raw;
}

/** Field value → string for a controlled text-ish input. */
export function fieldValueAsString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

/** Field types whose values read as content (vs. plumbing/options). */
const SUMMARY_FIELD_TYPES = new Set(["text", "textarea", "url", "image_url"]);

/**
 * One-line summary for a collapsed instance row: the first non-empty
 * CONTENT value (text-ish field types only — a seeded select option
 * like "left" is configuration, not content) among the block's
 * declared fields, truncated to 60 chars. Falls back to the block
 * description, then the raw block id (catalog miss — e.g. a block
 * retired server-side).
 */
export function instanceSummary(
  block: EmailBlock | undefined,
  instance: EmailBlockInstance,
): string {
  if (block) {
    for (const field of block.fields ?? []) {
      if (!SUMMARY_FIELD_TYPES.has(field.type)) continue;
      const v = instance.config[field.key];
      if (typeof v === "string" && v.trim() !== "") {
        const s = v.trim();
        return s.length > 60 ? `${s.slice(0, 57)}…` : s;
      }
    }
    return block.description || block.name;
  }
  return instance.block_id;
}

/** Catalog grouped by category, preserving server order in both axes. */
export function groupBlocksByCategory(
  blocks: EmailBlock[],
): { category: string; blocks: EmailBlock[] }[] {
  const order: string[] = [];
  const byCat = new Map<string, EmailBlock[]>();
  for (const b of blocks) {
    const cat = b.category || "other";
    if (!byCat.has(cat)) {
      byCat.set(cat, []);
      order.push(cat);
    }
    byCat.get(cat)!.push(b);
  }
  return order.map((category) => ({ category, blocks: byCat.get(category)! }));
}

/** Compose request body per the manifest wire shape. */
export function buildComposeInput(
  brand: EmailBlockBrandDefaults,
  instances: EmailBlockInstance[],
  subject?: string,
): EmailBlockComposeInput {
  const input: EmailBlockComposeInput = { brand, blocks: instances };
  if (subject && subject.trim() !== "") input.subject = subject.trim();
  return input;
}

/** Quick lookup table id → catalog block. */
export function indexBlocks(blocks: EmailBlock[]): Map<string, EmailBlock> {
  return new Map(blocks.map((b) => [b.id, b]));
}
