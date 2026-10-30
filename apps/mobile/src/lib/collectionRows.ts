/**
 * lib/collectionRows.ts — rendering somebody else's arbitrary JSON without
 * lying about it, and without letting it rewrite the screen.
 *
 * A reference collection's rows are `map[string]any` (`types.go:58`). The write
 * validator bounds them but does not shape them: rows are HETEROGENEOUS (row 1
 * may carry `code` and `expires`, row 2 only `code`), values may be nested
 * objects and arrays up to `MaxNestedDepth = 8`, a single string may be
 * `MaxStringValueBytes = 64 KiB`, and a row may hold `MaxColumnsPerRow = 100`
 * fields (`types.go:118-133`). None of that fits a phone, so this module
 * decides what a preview shows and how each cell is written down.
 *
 * THE SECURITY DETAIL THAT DROVE `formatCollectionCell`. `validateObjectKey`
 * rejects control and bidirectional-formatting runes in FIELD NAMES
 * (`validation.go:196-200`). `validateJSONValue` does NOT apply the same check
 * to string VALUES — it enforces UTF-8 validity, a byte ceiling and a NUL ban,
 * and nothing else (`validation.go:236-247`). So a stored cell may legally
 * contain U+202E RIGHT-TO-LEFT OVERRIDE, and rendering it raw lets one row
 * visually reverse the text that follows it — in a table an operator is reading
 * to decide whether an import is correct. Every string is stripped of those
 * runes before display, and the stripping is announced rather than silent.
 *
 * WHY A PREVIEW AND NOT A TABLE. `GET /api/v1/collections/{id}` returns the
 * COMPLETE array in one response — there is no row-level pagination anywhere in
 * the package, only the `MaxDataBytes = 1 MiB` persistence ceiling
 * (`types.go:116`) and `MaxRows = 50000`. The payload has already been
 * downloaded by the time this runs, so the cap here is purely about what is
 * legible and what a phone can lay out; `collectionRowPreviewNote` states the
 * cap out loud so a 12-row preview of a 50,000-row table is never read as the
 * table.
 *
 * Deliberately free of react-native imports so it runs under node vitest.
 */
import { EMDASH, num, plural } from "@/lib/format";
import type { CollectionDataRow } from "@/lib/collections";

/** Rows rendered in the detail preview. Beyond this, scrolling is the desktop's job. */
export const COLLECTION_ROW_PREVIEW_LIMIT = 12;

/** Columns rendered per row. `MaxColumnsPerRow` is 100; a phone shows a few. */
export const COLLECTION_COLUMN_PREVIEW_LIMIT = 4;

/** Longest rendered cell before it is clipped, in code points. */
export const COLLECTION_CELL_MAX_CHARS = 64;

/** Same rune set as `isUnsafeTextRune` (`validation.go:337-347`). */
const UNSAFE_TEXT_RE =
  /[\p{Cc}\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu;

export interface CollectionColumns {
  /** Field names to render, in first-seen order across the sampled rows. */
  names: string[];
  /** How many distinct field names the sampled rows carried in total. */
  total: number;
}

/**
 * The columns a preview shows.
 *
 * First-seen order, not alphabetical: a CSV import preserves its header order
 * through `json.Decoder` into jsonb only by key insertion, and the first row's
 * shape is what the operator recognises. Sorting would show `amount, code,
 * expires` for a file whose header reads `code, amount, expires`, and the
 * mismatch is exactly what makes somebody think they imported the wrong file.
 *
 * `total` counts every distinct name in the SAMPLE, not in the collection —
 * later rows may carry fields the preview never saw, which is why the note
 * built from it says "in these rows".
 */
export function collectionColumns(
  rows: readonly CollectionDataRow[],
  limit: number = COLLECTION_COLUMN_PREVIEW_LIMIT,
): CollectionColumns {
  const seen: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.includes(key)) seen.push(key);
    }
  }
  return { names: seen.slice(0, Math.max(0, limit)), total: seen.length };
}

export interface CollectionCell {
  /** What the cell prints. */
  text: string;
  /** True when the key was absent from this row — distinct from a stored null. */
  missing: boolean;
  /** True when text-direction or control runes were removed for display. */
  sanitized: boolean;
  /** True when the value was clipped to fit. */
  truncated: boolean;
}

const ABSENT = Symbol("absent");

/**
 * Write down one cell.
 *
 * FOUR THINGS THAT LOOK THE SAME AND ARE NOT:
 *   - the key is ABSENT from this row  → em-dash, `missing: true`
 *   - the value is a stored JSON null  → "null", a fact the row recorded
 *   - the value is an empty string     → the quoted empty marker
 *   - the value is the number 0        → "0"
 * Collapsing any of these into a blank is how a preview turns a malformed
 * import into a tidy-looking table.
 */
export function formatCollectionCell(
  row: CollectionDataRow,
  key: string,
): CollectionCell {
  const raw = Object.prototype.hasOwnProperty.call(row, key)
    ? row[key]
    : ABSENT;
  if (raw === ABSENT) {
    return { text: EMDASH, missing: true, sanitized: false, truncated: false };
  }
  return describeValue(raw);
}

function describeValue(raw: unknown): CollectionCell {
  if (raw === null) {
    return { text: "null", missing: false, sanitized: false, truncated: false };
  }
  if (typeof raw === "boolean") {
    return {
      text: raw ? "true" : "false",
      missing: false,
      sanitized: false,
      truncated: false,
    };
  }
  if (typeof raw === "number") {
    // Integers get the app's thousands separators; exactness is safe because
    // the write validator caps exact integers at 2^53-1 (`types.go:124`).
    //
    // NON-INTEGERS ARE PRINTED RAW, and that is the point: `num` is
    // `maximumFractionDigits: 0`, so routing a price of 12.5 through it prints
    // "13". Rounding a stored value inside a table somebody is reading to
    // verify an import is the worst lie on this screen.
    return {
      text:
        Number.isFinite(raw) && Number.isInteger(raw) ? num(raw) : String(raw),
      missing: false,
      sanitized: false,
      truncated: false,
    };
  }
  if (Array.isArray(raw)) {
    // The SHAPE, not the contents: a nested array is a structure the desktop
    // renders, and flattening it into "a, b, c" invents a delimiter the data
    // does not have.
    return {
      text: `[${plural(raw.length, "item")}]`,
      missing: false,
      sanitized: false,
      truncated: false,
    };
  }
  if (typeof raw === "object") {
    const fields = Object.keys(raw as Record<string, unknown>).length;
    return {
      text: `{${plural(fields, "field")}}`,
      missing: false,
      sanitized: false,
      truncated: false,
    };
  }
  return sanitizeCellText(String(raw));
}

/** Strip direction/control runes, then clip. Both facts are reported back. */
export function sanitizeCellText(value: string): CollectionCell {
  const stripped = value.replace(UNSAFE_TEXT_RE, "");
  const sanitized = stripped.length !== value.length;
  const points = [...stripped];
  if (points.length > COLLECTION_CELL_MAX_CHARS) {
    return {
      text: `${points.slice(0, COLLECTION_CELL_MAX_CHARS).join("")}…`,
      missing: false,
      sanitized,
      truncated: true,
    };
  }
  if (stripped === "") {
    // An empty string is a value somebody stored, and printing nothing would
    // make it indistinguishable from an absent key.
    return {
      text: sanitized ? "(formatting only)" : "(empty)",
      missing: false,
      sanitized,
      truncated: false,
    };
  }
  return { text: stripped, missing: false, sanitized, truncated: false };
}

/**
 * "Showing the first 12 of 4,318 rows" — or `null` when the preview is the
 * whole collection.
 *
 * `total` is `row_count`, which for a detail response is `len(data)`
 * (`repo.go:343`) and therefore exact.
 */
export function collectionRowPreviewNote(
  shown: number,
  total: number | null,
): string | null {
  if (total === null) return null;
  if (total <= shown) return null;
  return `Showing the first ${num(shown)} of ${plural(total, "row")}. The rest are on the web admin.`;
}

/**
 * "and 6 more fields" — the columns a preview left off, or `null`.
 *
 * Says "in these rows" because `collectionColumns` sampled the previewed rows
 * only, and a row further down may carry a field neither number knows about.
 */
export function collectionColumnNote(columns: CollectionColumns): string | null {
  const hidden = columns.total - columns.names.length;
  if (hidden <= 0) return null;
  return `${plural(hidden, "more field")} in these rows.`;
}

/** True when any previewed cell had direction/control runes removed. */
export function previewWasSanitized(
  rows: readonly CollectionDataRow[],
  names: readonly string[],
): boolean {
  return rows.some((row) =>
    names.some((name) => formatCollectionCell(row, name).sanitized),
  );
}
