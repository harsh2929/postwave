/**
 * lib/assetLibrary.ts — the wire shapes of the workspace asset library, parsed
 * without a single react-native import so the whole module is exercised in the
 * node vitest environment (the pattern documented in lib/templateCatalog.ts).
 *
 * Every shape below was read off the Go source, not off openapi.json:
 * `apps/api/internal/assets/handlers.go` (the envelopes),
 * `assets/repo.go` (the `Asset` / `Counts` / `Referrer` structs and the count
 * SQL), `assets/folders.go` and `assets/tags.go` (the two facet reads). Five
 * facts shape this module and each of them is easy to get wrong from a doc:
 *
 *  1. THE LIST ENVELOPE IS THREE-PART, AND ONLY ONE PART IS THE ROWS.
 *     `{"items":[…],"counts":{…},"nextCursor":string|null}` (handlers.go:332).
 *     `counts` describes the WHOLE tenant set and deliberately ignores
 *     `filter` / `limit` / `before`, so a chip total does not shift underneath
 *     the thumb while paging. It is therefore NOT a count of `items`, and the
 *     UI must never derive one from the other.
 *  2. `nextCursor` IS AN ASSET ID, NOT AN OFFSET. It is fed back as `?before=`,
 *     and `ListPageWithCounts` 400s (`invalid_cursor`) if that id is not a
 *     live row in the tenant — so a cursor is only ever echoed, never built.
 *  3. THE FILTER AND SORT VOCABULARIES ARE CLOSED SETS. `List` rejects
 *     anything outside them with a 400 before touching the database
 *     (handlers.go:283-294), so the chip rail may only be built from the
 *     constants here. An unknown value is a broken screen, not a wider search.
 *  4. `folder_id=root` IS A SENTINEL, NOT A UUID. `folderRootSentinel`
 *     (folders.go:58) selects the Uncategorised bucket — `folder_id IS NULL`.
 *     Every other value must be a canonical lowercase UUID or the request 400s.
 *  5. ABSENCE IS NOT ZERO, AND THIS PAYLOAD HAS BOTH KINDS. `bytes`, `width`,
 *     `height` and `referencesCount` all lack `omitempty`, so the server always
 *     sends them and an ABSENT field means the payload is not what this app
 *     thinks it is — reported as null, rendered as an em-dash. `lastUsedAt`
 *     is the opposite: `omitempty` on a `*time.Time`, so its absence genuinely
 *     means "never observed in a live draft" and is reported as null for the
 *     UI to render as words.
 */
// The single guard mirroring `exactPositiveJSONInteger`. Imported rather than
// re-stated so the folder rail and the write transport cannot drift on what
// counts as a usable version. lib/assetVersionGate imports nothing itself, so
// this module stays react-native-free and node-runnable.
import { isAssetRowVersion } from "@/lib/assetVersionGate";

/* ------------------------------------------------------------------ *
 * Smart filters — mirror the `switch p.Filter` allowlist in
 * handlers.go:289 and the count SQL in repo.go:188.
 * ------------------------------------------------------------------ */

export const ASSET_FILTERS = [
  { value: "all", label: "All", countKey: "all" },
  { value: "recent", label: "Recent", countKey: "recent" },
  { value: "in-use", label: "In use", countKey: "inUse" },
  { value: "unused", label: "Unused", countKey: "unused" },
  { value: "large", label: "Large", countKey: "large" },
] as const;

export type AssetFilter = (typeof ASSET_FILTERS)[number]["value"];
export type AssetCountKey = (typeof ASSET_FILTERS)[number]["countKey"];

/**
 * What each chip actually selects, in the operator's words. The definitions
 * are the SQL's, not an approximation of it: "recent" is created OR last-used
 * inside 30 days, "unused" additionally requires the asset to be older than 14
 * days (so something uploaded this morning is never accused of being dead
 * weight), and "large" is a hard 1 MiB threshold.
 */
export const ASSET_FILTER_HINTS: Record<AssetFilter, string> = {
  all: "Every image in this workspace.",
  recent: "Added or used in the last 30 days.",
  "in-use": "Referenced by a live campaign, template or form right now.",
  unused: "No live references, and more than 14 days old.",
  large: "Bigger than 1 MB.",
};

/** `?folder_id=root` selects the Uncategorised bucket (folder_id IS NULL). */
export const ASSET_FOLDER_ROOT = "root";

/**
 * The server's exact sort vocabulary — anything else 400s with `invalid_sort`
 * ("sort must be newest, oldest, largest, name, or most-used",
 * handlers.go:286). `newest` is the server default and is therefore OMITTED
 * from the URL by assetListPath, so the chip and the no-param request can
 * never disagree.
 */
export const ASSET_SORTS = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "largest", label: "Largest" },
  { value: "name", label: "Name" },
  { value: "most-used", label: "Most used" },
] as const;

export type AssetSort = (typeof ASSET_SORTS)[number]["value"];

export const DEFAULT_ASSET_SORT: AssetSort = "newest";

/**
 * The PATCH /assets/{id} bound: the handler counts RUNES, not UTF-16 units
 * (`utf8.RuneCountInString(altText) > 1024`, handlers.go). `[...text]`
 * iterates code points, which is the same count for everything the field can
 * hold, so the client refuses exactly where the server would.
 */
export const ALT_TEXT_MAX_RUNES = 1024;

/**
 * Non-null when the alt text cannot be saved — evaluated BEFORE the PATCH so
 * the operator keeps their typing instead of losing it to an `alt_too_long`
 * 400. An EMPTY string is deliberately allowed: clearing alt text is a real
 * edit (the server accepts it), not a validation failure.
 */
export function altTextBlockReason(text: string): string | null {
  const runes = [...text].length;
  if (runes <= ALT_TEXT_MAX_RUNES) return null;
  return `Alt text is ${runes} characters — the limit is ${ALT_TEXT_MAX_RUNES}. Trim it before saving.`;
}

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export interface MobileAsset {
  id: string;
  filename: string;
  mime: string;
  /** null only when the payload omitted a field the server always sends. */
  bytes: number | null;
  width: number | null;
  height: number | null;
  /**
   * Absolute (S3 / R2 public delivery) or the relative
   * `/api/v1/assets/{id}/blob` the dev-only filesystem backend returns
   * (storage.go:116). Resolving the second form needs the workspace base URL —
   * see `absoluteAssetUrl`.
   */
  url: string;
  createdAt: string | null;
  altText: string;
  /** null = the payload did not say. 0 genuinely means "nothing uses it". */
  referencesCount: number | null;
  /** null genuinely means "never observed in a live draft". */
  lastUsedAt: string | null;
  /** null = the Uncategorised bucket. */
  folderId: string | null;
  /**
   * The row's optimistic-concurrency version (`repo.go` `json:"version"`).
   *
   * Every asset WRITE is now version-gated: the PATCH answers 428
   * `expected_version_required` without a positive one and 412 `stale_version`
   * when it does not match. `null` means the payload did not carry it, and a
   * client that guessed a number would either be refused or — worse — overwrite
   * a teammate's edit, so callers withhold the affordance instead.
   */
  version: number | null;
}

export interface AssetCounts {
  all: number;
  recent: number;
  inUse: number;
  unused: number;
  large: number;
}

export interface AssetPage {
  items: MobileAsset[];
  /** null when the response carried no `counts` object — never a zeroed one. */
  counts: AssetCounts | null;
  nextCursor: string | null;
}

export interface AssetFolder {
  id: string;
  name: string;
  createdAt: string | null;
  assetCount: number;
  /**
   * The FOLDER's own optimistic-concurrency version (`folders.go` Folder.Version).
   *
   * Rename and delete are gated on it — 428 `expected_version_required`
   * without a positive one, 412 `stale_version` when it no longer matches —
   * while filing an image into the folder is gated on the ASSET's version
   * instead. ABSENT (rather than null) when the payload did not carry one, so
   * a folder row built before this field existed is still a valid `AssetFolder`
   * and `toEqual` comparisons of a version-less payload still hold. Absent
   * means the organise sheet withholds rename and delete for that folder.
   */
  version?: number;
}

export interface AssetTagCount {
  tag: string;
  count: number;
}

/** One live draft / template / form that embeds this asset's URL. */
export interface AssetReferrer {
  kind: string;
  id: string;
  name: string;
}

export interface AssetDetail {
  asset: MobileAsset | null;
  /** `GET /assets/{id}` recomputes this; it is never a cached scalar. */
  usage: AssetReferrer[];
}

/* ------------------------------------------------------------------ *
 * Primitive readers
 * ------------------------------------------------------------------ */

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(source: Record<string, unknown>, key: string): string {
  const raw = source[key];
  return typeof raw === "string" ? raw : "";
}

function nullableStr(
  source: Record<string, unknown>,
  key: string,
): string | null {
  const raw = source[key];
  return typeof raw === "string" && raw.trim() !== "" ? raw : null;
}

/** A finite, non-negative number, or null when the field was not sent. */
function countable(
  source: Record<string, unknown>,
  key: string,
): number | null {
  const raw = source[key];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  return raw;
}

/**
 * A DIMENSION. Zero is reported as null on purpose: `Asset.Width` is populated
 * from the decoder, so a stored 0 means the dimension was never established,
 * not that the image is zero pixels wide.
 */
function dimension(
  source: Record<string, unknown>,
  key: string,
): number | null {
  const value = countable(source, key);
  return value === null || value === 0 ? null : value;
}

/* ------------------------------------------------------------------ *
 * Parsers
 * ------------------------------------------------------------------ */

export function parseAsset(input: unknown): MobileAsset | null {
  const row = record(input);
  if (!row) return null;
  const id = str(row, "id").trim();
  if (!id) return null;
  return {
    id,
    filename: str(row, "filename"),
    mime: str(row, "mime"),
    bytes: countable(row, "bytes"),
    width: dimension(row, "width"),
    height: dimension(row, "height"),
    url: str(row, "url"),
    createdAt: nullableStr(row, "createdAt"),
    altText: str(row, "altText"),
    referencesCount: countable(row, "referencesCount"),
    lastUsedAt: nullableStr(row, "lastUsedAt"),
    folderId: nullableStr(row, "folderId"),
    // `isAssetRowVersion`, not `countable`: `countable` accepts 0 and
    // fractions, and BOTH are numbers the write handlers answer 428 for
    // (`exactPositiveJSONInteger`). Carrying one would read as "this row is
    // versioned", offer Delete, and send a number guaranteed to be refused —
    // the exact failure this whole gate exists to stop.
    version: isAssetRowVersion(row["version"]) ? row["version"] : null,
  };
}

function parseCounts(input: unknown): AssetCounts | null {
  const row = record(input);
  if (!row) return null;
  const all = countable(row, "all");
  const recent = countable(row, "recent");
  const inUse = countable(row, "inUse");
  const unused = countable(row, "unused");
  const large = countable(row, "large");
  // Partial counts are not counts. A chip rail built from three of five
  // numbers would show a confident 0 beside two filters that were never
  // measured, which is exactly the lie the em-dash rule exists to prevent.
  if (
    all === null ||
    recent === null ||
    inUse === null ||
    unused === null ||
    large === null
  ) {
    return null;
  }
  return { all, recent, inUse, unused, large };
}

export function parseAssetPage(input: unknown): AssetPage {
  const envelope = record(input);
  const rawItems = envelope?.["items"];
  const items = Array.isArray(rawItems)
    ? rawItems
        .map(parseAsset)
        .filter((asset): asset is MobileAsset => asset !== null)
    : [];
  const cursor = envelope ? envelope["nextCursor"] : null;
  return {
    items,
    counts: parseCounts(envelope?.["counts"]),
    // Explicitly `string | null` on the wire — the handler writes a bare null
    // when there is no further page (handlers.go:328).
    nextCursor: typeof cursor === "string" && cursor.trim() !== "" ? cursor : null,
  };
}

export function parseAssetFolders(input: unknown): AssetFolder[] {
  const rows = record(input)?.["folders"];
  if (!Array.isArray(rows)) return [];
  const out: AssetFolder[] = [];
  for (const raw of rows) {
    const row = record(raw);
    if (!row) continue;
    const id = str(row, "id").trim();
    const name = str(row, "name").trim();
    if (!id || !name) continue;
    // `isAssetRowVersion`, not `countable`: the folder rename/delete guard is
    // `exactPositiveJSONInteger`, so a fractional or zero version is a number
    // the server would answer 428 for. Carrying it would offer a Rename button
    // that could only fail.
    const version = row["version"];
    out.push({
      id,
      name,
      createdAt: nullableStr(row, "createdAt"),
      // `assetCount` is a COALESCE'd COUNT (folders.go:82) — never absent —
      // so a missing one is a broken payload and shows as zero rather than
      // suppressing the folder from the rail entirely.
      assetCount: countable(row, "assetCount") ?? 0,
      // Spread rather than assigned: `exactOptionalPropertyTypes` forbids an
      // explicit `undefined`, and a version-less payload must produce a row
      // with no `version` KEY — that absence is what makes the organise sheet
      // withhold rename and delete instead of guessing a number.
      ...(isAssetRowVersion(version) ? { version } : {}),
    });
  }
  return out;
}

export function parseAssetTags(input: unknown): AssetTagCount[] {
  const rows = record(input)?.["tags"];
  if (!Array.isArray(rows)) return [];
  const out: AssetTagCount[] = [];
  for (const raw of rows) {
    const row = record(raw);
    if (!row) continue;
    const tag = str(row, "tag").trim();
    if (!tag) continue;
    out.push({ tag, count: countable(row, "count") ?? 0 });
  }
  return out;
}

function parseReferrers(input: unknown): AssetReferrer[] {
  if (!Array.isArray(input)) return [];
  const out: AssetReferrer[] = [];
  for (const raw of input) {
    const row = record(raw);
    if (!row) continue;
    const id = str(row, "id").trim();
    const kind = str(row, "kind").trim();
    if (!id && !kind) continue;
    out.push({ kind, id, name: str(row, "name").trim() });
  }
  return out;
}

/** `{"asset": Asset, "usage": [Referrer]}` — handlers.go:373. */
export function parseAssetDetail(input: unknown): AssetDetail {
  const envelope = record(input);
  return {
    asset: parseAsset(envelope?.["asset"]),
    usage: parseReferrers(envelope?.["usage"]),
  };
}

/* ------------------------------------------------------------------ *
 * Derivations the UI needs, kept here so they are unit-tested
 * ------------------------------------------------------------------ */

/**
 * Resolve the stored URL against the workspace origin.
 *
 * The filesystem backend returns a RELATIVE `/api/v1/assets/{id}/blob`
 * (storage.go:116) while S3 / R2 return an absolute public delivery URL. A
 * relative string is useless to a clipboard and to an <Image>, so it is joined
 * to the base URL the session is already talking to. Returns null when there
 * is nothing that can honestly be turned into an absolute URL — the caller
 * renders an em-dash rather than a half-formed link.
 */
export function absoluteAssetUrl(
  url: string,
  baseUrl: string | null | undefined,
): string | null {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (!trimmed.startsWith("/")) return null;
  const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!base || !/^https?:\/\//i.test(base)) return null;
  return base + trimmed;
}

/** "1280 × 720", or null when the server never established the dimensions. */
export function assetDimensions(asset: MobileAsset): string | null {
  if (asset.width === null || asset.height === null) return null;
  return `${asset.width} × ${asset.height}`;
}

/**
 * The one-line usage verdict, with "we do not know" kept distinct from "zero".
 * `referencesCount` is refreshed periodically for list rows and recomputed on
 * demand for the detail read, so the list's phrasing is deliberately softer.
 */
export function assetUsagePhrase(count: number | null): string {
  if (count === null) return "Usage unknown";
  if (count === 0) return "Not used by anything live";
  return count === 1 ? "Used by 1 live item" : `Used by ${count} live items`;
}
