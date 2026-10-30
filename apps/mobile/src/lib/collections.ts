/**
 * lib/collections.ts — the wire shape of SUB-014 reference collections, parsed
 * once, honestly.
 *
 * READ FROM THE GO SOURCE, not from openapi.json:
 *   `apps/api/internal/collections/types.go:60-102` is the struct, and its JSON
 *   tags are the contract: `id`, `tenant_id`, `name`, `collection_type`,
 *   `source_type`, `data`, `row_count`, `created_at`, `updated_at`; the list
 *   envelope is `{ items, total, next_cursor? }`.
 *
 * THE ONE TRAP THIS FILE EXISTS TO CLOSE. A list item's `data` is NOT the
 * collection's rows and is NOT empty because the collection is empty — the
 * summary scanner hard-codes `c.Data = []RowValue{}` after projecting the count
 * separately (`repo.go:367`, and the SELECT at `repo.go:126` reads
 * `jsonb_array_length(data)` instead of the bodies). So a client that renders
 * `item.data.length` prints "0 rows" for every collection in the workspace,
 * including a 50,000-row coupon table. `normalizeCollectionSummary` therefore
 * DROPS `data` entirely and reads `row_count`, and when `row_count` is missing
 * it answers `null` — never 0. Absence is not zero (house rule 8).
 *
 * The DETAIL response is the opposite case and is treated as such: `Get`
 * decodes the complete `data` array and sets `RowCount = len(c.Data)`
 * (`repo.go:332-343`), so there the array IS the measurement and its length is
 * a real number rather than a placeholder.
 *
 * EXACTNESS OF NUMBERS INSIDE ROWS. Row values are `map[string]any` decoded
 * with `UseNumber`, and the write validator caps exact integers at
 * `MaxSafeJSONInteger = 2^53 - 1` (`types.go:124`), explicitly so Go, jsonb and
 * JavaScript's `JSON.parse` agree. Anything larger must have been stored as a
 * string. So this module can hold cells as plain JS values without silently
 * rounding an identifier.
 *
 * Deliberately free of react-native / expo imports so it runs under node vitest
 * (house rule 6).
 */

/** The three collection kinds the server accepts (`types.go:19-23`). */
export const COLLECTION_TYPE_KEYS = ["coupons", "content", "schedule"] as const;
export type CollectionTypeKey = (typeof COLLECTION_TYPE_KEYS)[number];

/** How the rows got in (`types.go:40-44`). */
export const COLLECTION_SOURCE_KEYS = ["uploaded", "api", "manual"] as const;
export type CollectionSourceKey = (typeof COLLECTION_SOURCE_KEYS)[number];

/**
 * One row of the metadata-only list.
 *
 * `collectionType` / `sourceType` are kept as raw strings rather than narrowed
 * to the unions above: the server validates them on write AND on read
 * (`repo.go:364`, `validation.go`), but a future release may add a fourth kind,
 * and a client that coerced an unknown value to "content" would be inventing.
 */
export interface CollectionSummary {
  id: string;
  name: string;
  collectionType: string;
  sourceType: string;
  /** Exact persisted row count, or `null` when the server did not report one. */
  rowCount: number | null;
  createdAt: string;
  updatedAt: string;
}

/** A single reference row: an object of bounded JSON values. */
export type CollectionDataRow = Record<string, unknown>;

/** A collection plus its complete row bodies — only the detail route returns this. */
export interface CollectionDetail extends CollectionSummary {
  rows: CollectionDataRow[];
}

/** `ListPage` (`types.go:97-102`). `total` counts every match for the filter. */
export interface CollectionListPage {
  items: CollectionSummary[];
  /** Exact filter-wide total, or `null` when the server did not report one. */
  total: number | null;
  /** Opaque keyset cursor for the next page; `null` when this is the last. */
  nextCursor: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A non-negative integer, or `null`.
 *
 * `null` for anything unparseable is the whole point: a count the server did
 * not send must not become a zero the screen then prints as fact.
 */
function count(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || !Number.isInteger(value)) return null;
  return value;
}

/**
 * Parse one list item. Returns `null` for a row with no id — an unaddressable
 * row cannot be opened, and rendering it would offer a dead press target.
 */
export function normalizeCollectionSummary(
  raw: unknown,
): CollectionSummary | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = str(record["id"]).trim();
  if (!id) return null;
  return {
    id,
    name: str(record["name"]),
    collectionType: str(record["collection_type"]).trim(),
    sourceType: str(record["source_type"]).trim(),
    // `data` is deliberately not consulted — see the module header.
    rowCount: count(record["row_count"]),
    createdAt: str(record["created_at"]),
    updatedAt: str(record["updated_at"]),
  };
}

/** Parse `GET /api/v1/collections`. */
export function normalizeCollectionListPage(raw: unknown): CollectionListPage {
  const record = asRecord(raw);
  const rawItems = record ? record["items"] : null;
  const items = Array.isArray(rawItems)
    ? rawItems
        .map(normalizeCollectionSummary)
        .filter((item): item is CollectionSummary => item !== null)
    : [];
  const cursor = record ? str(record["next_cursor"]).trim() : "";
  return {
    items,
    total: record ? count(record["total"]) : null,
    // `next_cursor` carries `omitempty`, so its absence — not a sentinel — is
    // how the server says "last page".
    nextCursor: cursor === "" ? null : cursor,
  };
}

/**
 * Parse `GET /api/v1/collections/{id}`.
 *
 * Unlike a summary, `rows` here is the complete persisted array, so its length
 * is a genuine measurement and is used when the server omitted `row_count`.
 * Non-object entries are dropped rather than rendered: `validateRows` rejects
 * them on write (`validation.go:153`), so one appearing means something is
 * wrong with the payload, and a `null` masquerading as a row would print as an
 * empty line indistinguishable from a real blank record.
 */
export function normalizeCollectionDetail(raw: unknown): CollectionDetail | null {
  const summary = normalizeCollectionSummary(raw);
  if (!summary) return null;
  const record = asRecord(raw);
  const rawRows = record ? record["data"] : null;
  const rows = Array.isArray(rawRows)
    ? rawRows
        .map(asRecord)
        .filter((row): row is Record<string, unknown> => row !== null)
    : [];
  return {
    ...summary,
    rowCount: summary.rowCount ?? rows.length,
    rows,
  };
}
