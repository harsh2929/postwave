/**
 * lib/templateDiscovery.ts — the discovery layer of the template library
 * (desktop parity: Templates.tsx catalog controls + TemplateDiscoveryHub),
 * as node-testable data rules.
 *
 * Server facts this module mirrors:
 *   - `source` accepts platform|mine|team|all (catalog.go SearchFilter);
 *     "Favorites" is NOT a source — it is `favorited=1` — and "Archived" is
 *     the `archived` lifecycle param (active|archived|all; EMPTY means BOTH,
 *     campaigntemplates.go:684). Mobile therefore always sends
 *     `archived=active` unless the archived shelf is open: the server default
 *     mixes retired designs into the browse shelf, which is the exact clutter
 *     the archive verb exists to remove.
 *   - `sort` accepts recommended (default) | name | most_used
 *     (catalogOrderBy); anything else is a 400, so only these are offered.
 *   - `/stats` answers extras.go's Stats rollup.
 *   - `/recent` answers {items: [{template, view_count, last_viewed_at}]}.
 *   - saved searches / collections are viewer-role user-scoped state with
 *     strong ETags; mobile lists, applies, creates, and deletes — editing a
 *     definition stays a desktop job.
 *   - `/compare` takes 2..4 identifiers (normalizeCompareIdentifiers) and
 *     answers {items: [{requested_identifier, matched_by, template}],
 *     unavailable_identifiers}.
 */
import {
  parseTemplate,
  templateGoalLabel,
  type MobileTemplate,
} from "@/lib/templateCatalog";

/* ---------------------------------------------------------------- shelves */

export const TEMPLATE_SHELVES = [
  "all",
  "gallery",
  "team",
  "mine",
  "favorites",
  "archived",
] as const;

export type TemplateShelf = (typeof TEMPLATE_SHELVES)[number];

export const TEMPLATE_SHELF_LABELS: Record<TemplateShelf, string> = {
  all: "All",
  gallery: "Gallery",
  team: "Team",
  mine: "Mine",
  favorites: "Favorites",
  archived: "Archived",
};

export interface ShelfQuery {
  source: string | null;
  favorited: boolean;
  /** Always sent — see the module header on the server's mixed default. */
  archived: "active" | "archived";
}

export function shelfQuery(shelf: TemplateShelf): ShelfQuery {
  switch (shelf) {
    case "gallery":
      return { source: "platform", favorited: false, archived: "active" };
    case "team":
      return { source: "team", favorited: false, archived: "active" };
    case "mine":
      return { source: "mine", favorited: false, archived: "active" };
    case "favorites":
      return { source: null, favorited: true, archived: "active" };
    case "archived":
      return { source: null, favorited: false, archived: "archived" };
    default:
      return { source: null, favorited: false, archived: "active" };
  }
}

/* ------------------------------------------------------------------ sorts */

export const TEMPLATE_SORTS = ["recommended", "name", "most_used"] as const;

export type TemplateSort = (typeof TEMPLATE_SORTS)[number];

export const TEMPLATE_SORT_LABELS: Record<TemplateSort, string> = {
  recommended: "Recommended",
  name: "Name",
  most_used: "Most used",
};

/** The default is omitted so the URL stays honest about what is filtered. */
export function sortQueryValue(sort: TemplateSort): string | null {
  return sort === "recommended" ? null : sort;
}

/* ------------------------------------------------------------------ stats */

export interface TemplateStats {
  total: number;
  mine: number;
  favorites: number;
  usedLast30d: number;
  topTemplateName: string;
  topUsageCount: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonNegative(value: unknown): number {
  const n = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** Null when the body is not the Stats rollup — the tiles then stay absent. */
export function parseTemplateStats(payload: unknown): TemplateStats | null {
  const body = record(payload);
  if (typeof body["total"] !== "number") return null;
  return {
    total: nonNegative(body["total"]),
    mine: nonNegative(body["mine"]),
    favorites: nonNegative(body["favorites"]),
    usedLast30d: nonNegative(body["used_last_30d"]),
    topTemplateName:
      typeof body["top_template_name"] === "string"
        ? body["top_template_name"].trim()
        : "",
    topUsageCount: nonNegative(body["top_usage_count"]),
  };
}

/* ----------------------------------------------------------------- recent */

export interface RecentTemplateView {
  template: MobileTemplate;
  viewCount: number;
  lastViewedAt: string | null;
}

export function parseRecentTemplateViews(
  payload: unknown,
): RecentTemplateView[] {
  const body = record(payload);
  const rows = Array.isArray(body["items"])
    ? (body["items"] as unknown[])
    : Array.isArray(payload)
      ? payload
      : [];
  const out: RecentTemplateView[] = [];
  for (const entry of rows) {
    const row = record(entry);
    const template = parseTemplate(row["template"], "catalog");
    if (!template) continue;
    const last = row["last_viewed_at"];
    out.push({
      template,
      viewCount: nonNegative(row["view_count"]),
      lastViewedAt:
        typeof last === "string" && !Number.isNaN(Date.parse(last))
          ? last
          : null,
    });
  }
  return out;
}

/* ---------------------------------------------------------- saved search */

export interface TemplateSavedSearch {
  id: string;
  name: string;
  etag: string;
  /** The axes mobile can NAME; the results feed applies the full definition. */
  query: string;
  goal: string;
  /** True when the definition carries axes beyond query/goal/shelf/sort. */
  hasExtraFilters: boolean;
}

const MOBILE_FILTER_KEYS = new Set([
  "q",
  "goal",
  "source",
  "favorited",
  "archived",
  "sort",
]);

export function parseTemplateSavedSearches(
  payload: unknown,
): TemplateSavedSearch[] {
  const body = record(payload);
  const rows = Array.isArray(body["items"])
    ? (body["items"] as unknown[])
    : Array.isArray(payload)
      ? payload
      : [];
  const out: TemplateSavedSearch[] = [];
  for (const entry of rows) {
    const row = record(entry);
    const id = typeof row["id"] === "string" ? row["id"].trim() : "";
    const name = typeof row["name"] === "string" ? row["name"].trim() : "";
    if (!id || !name) continue;
    const filters = record(row["filters"]);
    const hasExtraFilters = Object.entries(filters).some(
      ([key, value]) =>
        !MOBILE_FILTER_KEYS.has(key) &&
        value !== "" &&
        value !== null &&
        value !== undefined &&
        !(Array.isArray(value) && value.length === 0),
    );
    out.push({
      id,
      name,
      etag: typeof row["etag"] === "string" ? row["etag"] : "",
      query: typeof filters["q"] === "string" ? filters["q"] : "",
      goal: typeof filters["goal"] === "string" ? filters["goal"] : "",
      hasExtraFilters,
    });
  }
  return out;
}

/**
 * The auto-name for "save this search" — a phone types names badly, so the
 * name is derived from what the search IS. Desktop can rename it later
 * (PATCH accepts `name`).
 */
export function savedSearchAutoName(input: {
  query: string;
  goal: string | null;
  shelf: TemplateShelf;
  sort: TemplateSort;
}): string {
  const parts: string[] = [];
  const query = input.query.trim();
  if (query) parts.push(`“${query}”`);
  if (input.goal) parts.push(templateGoalLabel(input.goal));
  if (input.shelf !== "all") parts.push(TEMPLATE_SHELF_LABELS[input.shelf]);
  if (input.sort !== "recommended") parts.push(TEMPLATE_SORT_LABELS[input.sort]);
  return parts.length > 0 ? parts.join(" · ") : "All designs";
}

/**
 * One CURSOR-paged results page (the saved-search `/results` endpoint pages
 * on the opaque base64 `next_cursor`, never on `page`). The cursor is kept
 * VERBATIM — decodeCatalogCursor rejects anything it did not mint.
 */
export interface CursorTemplatePage {
  items: MobileTemplate[];
  nextCursor: string | null;
}

export function parseCursorTemplatePage(payload: unknown): CursorTemplatePage {
  const body = record(payload);
  const rows = Array.isArray(body["items"]) ? (body["items"] as unknown[]) : [];
  const items = rows
    .map((row) => parseTemplate(row, "catalog"))
    .filter((item): item is MobileTemplate => item !== null);
  const cursor = body["next_cursor"];
  return {
    items,
    nextCursor:
      typeof cursor === "string" && cursor.trim() !== "" ? cursor : null,
  };
}

/* ------------------------------------------------------------ collections */

export interface TemplateCollection {
  id: string;
  name: string;
  description: string;
  itemCount: number;
  etag: string;
  /** Populated only by the single read (GET /{id} carries `items`). */
  items: MobileTemplate[];
}

export function parseTemplateCollections(payload: unknown): TemplateCollection[] {
  const body = record(payload);
  const rows = Array.isArray(body["items"])
    ? (body["items"] as unknown[])
    : Array.isArray(payload)
      ? payload
      : [];
  const out: TemplateCollection[] = [];
  for (const entry of rows) {
    const parsed = parseTemplateCollection(entry);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function parseTemplateCollection(
  payload: unknown,
): TemplateCollection | null {
  const row = record(payload);
  const id = typeof row["id"] === "string" ? row["id"].trim() : "";
  if (!id) return null;
  const items = Array.isArray(row["items"])
    ? (row["items"] as unknown[])
        .map((item) => parseTemplate(item, "catalog"))
        .filter((item): item is MobileTemplate => item !== null)
    : [];
  const templateIds = Array.isArray(row["template_ids"])
    ? (row["template_ids"] as unknown[]).filter(
        (value) => typeof value === "string",
      )
    : [];
  return {
    id,
    name: typeof row["name"] === "string" ? row["name"].trim() : "Collection",
    description:
      typeof row["description"] === "string" ? row["description"].trim() : "",
    itemCount: nonNegative(row["item_count"]) || templateIds.length,
    etag: typeof row["etag"] === "string" ? row["etag"] : "",
    items,
  };
}

/* ---------------------------------------------------------------- compare */

export interface TemplateCompareResult {
  items: MobileTemplate[];
  /** Identifiers the server could not resolve — said, never dropped. */
  unavailable: string[];
}

export function parseTemplateCompare(payload: unknown): TemplateCompareResult {
  const body = record(payload);
  const rows = Array.isArray(body["items"]) ? (body["items"] as unknown[]) : [];
  const items: MobileTemplate[] = [];
  for (const entry of rows) {
    // "catalog": the compare sheet compares metadata and stats, and marking
    // rows body-loaded on a projection we have not verified would let a blank
    // masquerade as a measurement (templateCatalog note 1).
    const template = parseTemplate(record(entry)["template"], "catalog");
    if (template) items.push(template);
  }
  const unavailable = Array.isArray(body["unavailable_identifiers"])
    ? (body["unavailable_identifiers"] as unknown[]).filter(
        (value): value is string => typeof value === "string" && value !== "",
      )
    : [];
  return { items, unavailable };
}

/** Server bound: 2..4 identifiers (normalizeCompareIdentifiers). */
export const TEMPLATE_COMPARE_MIN = 2;
export const TEMPLATE_COMPARE_MAX = 4;

/**
 * Toggle one design in the compare shortlist, refusing past the server's cap
 * BEFORE the request — the fifth long-press is told why, not 400d later.
 */
export function toggleCompareId(
  ids: readonly string[],
  id: string,
): { ids: string[]; blockReason: string | null } {
  if (ids.includes(id)) {
    return { ids: ids.filter((existing) => existing !== id), blockReason: null };
  }
  if (ids.length >= TEMPLATE_COMPARE_MAX) {
    return {
      ids: [...ids],
      blockReason: `Compare holds at most ${TEMPLATE_COMPARE_MAX} designs — remove one first.`,
    };
  }
  return { ids: [...ids, id], blockReason: null };
}
