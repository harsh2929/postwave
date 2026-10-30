/**
 * lib/integrationsCatalog.ts — the integrations CATALOG (what could be
 * connected), parsed, searched and bounded.
 *
 * WHAT THE PAYLOAD IS. `GET /api/v1/integrations/catalog`
 * (apps/api/internal/integrations/handlers.go:215 `catalog`) answers the whole
 * public catalog in one shot:
 *
 *   { schema_version, target_public_entries, target_native_managed,
 *     honest_badges: [], categories: [{key,label}], capabilities: [],
 *     items: [{slug,name,category,badge,runtime_status,summary,capabilities,
 *              docs_url,setup_path,native,featured,phase,sources}],
 *     counts: {total, "badge:x", "category:y", "runtime:z", native,
 *              native_managed, native_verified, planned} }
 *
 * THE HONESTY PROBLEM THIS FILE EXISTS FOR. The catalog is ~614 rows and only
 * a small minority carry `runtime_status: "available"`. Everything else is a
 * partner/bridge route, a migration-only entry, or a planned one — and several
 * whole families are deliberately release-held: `decorateCatalogItem`
 * (catalog.go:194) REWRITES every support-provider entry to badge `planned`,
 * status `planned`, no capabilities and no setup path, and blanks `setup_path`
 * for SMS and MCP entries for the same reason. A browser that rendered 614
 * uniform rows would therefore be telling the reader that 614 things can be
 * connected, which is false by roughly an order of magnitude.
 *
 * So every row here carries the server's OWN two-axis vocabulary — badge
 * (`honest_badges`, the server's word for the list) and `runtime_status` — and
 * `catalogEntryConnectable` is true for exactly one value, `available`. No
 * label is invented: an unrecognised token is rendered verbatim rather than
 * being bucketed into a friendly word that might be wrong.
 *
 * SEARCH mirrors the server's own `catalogItemMatches` (handlers.go:763) field
 * for field — slug, name, category, badge, runtime status, summary, sources
 * and capabilities — so typing into the phone narrows the same set the server
 * would have narrowed with `?q=`. Filtering locally rather than per keystroke
 * is deliberate: the screen already pays for this payload once, and a request
 * per character would be 614 rows down the wire per letter.
 *
 * DELIBERATELY IMPORT-FREE so it runs under the node vitest environment.
 */

export interface CatalogEntry {
  slug: string;
  name: string;
  /** Category KEY (e.g. "ecommerce"); the label is looked up separately. */
  category: string;
  /** Server badge token, verbatim. */
  badge: string;
  /** Server runtime_status token, verbatim. */
  runtimeStatus: string;
  summary: string;
  capabilities: string[];
  sources: string[];
  setupPath: string;
  phase: string;
  native: boolean;
}

export interface CatalogCategory {
  key: string;
  label: string;
}

export interface IntegrationsCatalog {
  entries: CatalogEntry[];
  /** The server's category vocabulary, in its order. */
  categories: CatalogCategory[];
  /** The server's badge vocabulary (`honest_badges`), in its order. */
  badges: string[];
  /** The server's own counts. Never recomputed here. */
  counts: Record<string, number>;
}

/** Rows revealed per "Show more". */
export const CATALOG_PAGE_SIZE = 25;

export const CATALOG_MAX_SEARCH_CHARS = 256;

/**
 * The one runtime status that means "you can connect this today". Everything
 * else is coverage information.
 */
export const CATALOG_CONNECTABLE_STATUS = "available";

const TIER_LABELS: Readonly<Record<string, string>> = {
  native: "Native",
  partner: "Partner",
  zapier: "Zapier",
  webhook: "Webhook",
  api_sdk: "API & SDK",
  migration_only: "Migration only",
  planned: "Planned",
};

const STATUS_LABELS: Readonly<Record<string, string>> = {
  available: "Available",
  partial: "Partial",
  delegated: "Delegated",
  planned: "Planned",
};

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const s = str(entry);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function counts(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "number" && Number.isFinite(raw)) out[key] = raw;
  }
  return out;
}

/** `{items, categories, honest_badges, counts}` → the rows a browser renders. */
export function normalizeIntegrationsCatalog(
  payload: unknown,
): IntegrationsCatalog {
  const raw = (payload ?? {}) as Record<string, unknown>;
  const items = Array.isArray(raw.items) ? raw.items : [];
  const entries: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const row of items) {
    const r = (row ?? {}) as Record<string, unknown>;
    const slug = str(r.slug);
    const name = str(r.name);
    // A row with no slug cannot be keyed or deduplicated, and a row with no
    // name has nothing to render; either is junk, not an entry.
    if (!slug || !name || seen.has(slug)) continue;
    seen.add(slug);
    entries.push({
      slug,
      name,
      category: str(r.category),
      badge: str(r.badge),
      runtimeStatus: str(r.runtime_status),
      summary: str(r.summary),
      capabilities: strList(r.capabilities),
      sources: strList(r.sources),
      setupPath: str(r.setup_path),
      phase: str(r.phase),
      native: r.native === true,
    });
  }

  const rawCategories = Array.isArray(raw.categories) ? raw.categories : [];
  const categories: CatalogCategory[] = [];
  for (const row of rawCategories) {
    const c = (row ?? {}) as Record<string, unknown>;
    const key = str(c.key);
    if (!key) continue;
    categories.push({ key, label: str(c.label) || key });
  }

  return {
    entries,
    categories,
    badges: strList(raw.honest_badges),
    counts: counts(raw.counts),
  };
}

/** A badge token as a reader-facing tier. Unknown tokens render verbatim. */
export function catalogTierLabel(badge: string): string {
  return TIER_LABELS[badge] ?? (badge || "Unclassified");
}

/** A runtime_status token as a reader-facing word. Verbatim when unknown. */
export function catalogStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? (status || "Unknown");
}

/**
 * Whether this entry can actually be connected right now.
 *
 * Exactly one status qualifies. `partial` and `delegated` both describe a
 * route that exists in some form but is not a connect-and-go integration, and
 * `planned` is not built — treating any of them as connectable is the lie this
 * predicate exists to prevent.
 */
export function catalogEntryConnectable(entry: CatalogEntry): boolean {
  return entry.runtimeStatus === CATALOG_CONNECTABLE_STATUS;
}

export type CatalogStatusTone = "success" | "warning" | "info" | "neutral";

export function catalogStatusTone(status: string): CatalogStatusTone {
  if (status === "available") return "success";
  if (status === "partial") return "warning";
  if (status === "delegated") return "info";
  return "neutral";
}

/** Bound and normalise what the search field hands over. */
export function catalogSearchTerm(search: string): string {
  return search.slice(0, CATALOG_MAX_SEARCH_CHARS).trim().toLocaleLowerCase();
}

export interface CatalogFilters {
  search: string;
  /** Category key, or "" for every category. */
  category: string;
  /** Badge token, or "" for every tier. */
  tier: string;
}

/**
 * The server's `catalogItemMatches` field set, mirrored: slug, name, category,
 * badge, runtime status, summary, sources and capabilities. Dropping any of
 * them would make the phone's results a strict subset of the server's for the
 * same query, which is the quiet kind of wrong — the reader concludes the
 * catalog has no Snowflake entry when they searched "warehouse".
 */
export function filterCatalogEntries(
  entries: readonly CatalogEntry[],
  filters: CatalogFilters,
): CatalogEntry[] {
  const query = catalogSearchTerm(filters.search);
  const { category, tier } = filters;
  return entries.filter((entry) => {
    if (category && entry.category !== category) return false;
    if (tier && entry.badge !== tier) return false;
    if (!query) return true;
    const haystack = [
      entry.slug,
      entry.name,
      entry.category,
      entry.badge,
      entry.runtimeStatus,
      entry.summary,
      ...entry.sources,
      ...entry.capabilities,
    ]
      .join(" ")
      .toLocaleLowerCase();
    return haystack.includes(query);
  });
}

export interface CatalogFilterOption {
  value: string;
  label: string;
  count: number;
}

/**
 * Category chips, in the server's order, restricted to categories that
 * actually have entries in this payload. A chip that can only ever produce an
 * empty list is a dead end, and the catalog's category vocabulary is wider
 * than what any one deployment returns.
 */
export function catalogCategoryOptions(
  catalog: IntegrationsCatalog,
): CatalogFilterOption[] {
  const present = new Map<string, number>();
  for (const entry of catalog.entries) {
    present.set(entry.category, (present.get(entry.category) ?? 0) + 1);
  }
  const out: CatalogFilterOption[] = [];
  for (const category of catalog.categories) {
    const count = present.get(category.key);
    if (count === undefined) continue;
    out.push({ value: category.key, label: category.label, count });
  }
  return out;
}

/**
 * Tier chips from `honest_badges` — the server's own name for the list, and
 * the reason it is used rather than a client-side enum: the badge vocabulary
 * is the server's honesty contract, not a display preference.
 */
export function catalogTierOptions(
  catalog: IntegrationsCatalog,
): CatalogFilterOption[] {
  const present = new Map<string, number>();
  for (const entry of catalog.entries) {
    present.set(entry.badge, (present.get(entry.badge) ?? 0) + 1);
  }
  const out: CatalogFilterOption[] = [];
  const seen = new Set<string>();
  for (const badge of catalog.badges) {
    const count = present.get(badge);
    if (count === undefined) continue;
    seen.add(badge);
    out.push({ value: badge, label: catalogTierLabel(badge), count });
  }
  // A badge the server did not list in honest_badges but did put on a row is
  // still real; showing it keeps the chips a complete partition of the list.
  for (const [badge, count] of present) {
    if (!badge || seen.has(badge)) continue;
    out.push({ value: badge, label: catalogTierLabel(badge), count });
  }
  return out;
}

/**
 * The availability sentence, built from the SERVER'S counts.
 *
 * Returns null when the server did not report them, because the alternative —
 * counting the rows we happened to receive — would state a workspace-wide fact
 * from a page of data.
 */
export function catalogAvailabilityLine(
  catalog: IntegrationsCatalog,
): string | null {
  const total = catalog.counts.total;
  const available = catalog.counts["runtime:available"];
  if (typeof total !== "number" || typeof available !== "number") return null;
  return `${available} of ${total} catalog entries report runtime status "available". The rest are listed for coverage — a tier or status here is not a promise that the entry can be connected.`;
}

/** The one line under the search field. */
export function catalogResultSentence(
  total: number,
  matched: number,
  filtered: boolean,
): string {
  if (!filtered) return `${total} catalog entries.`;
  return `${matched} of ${total} entries match the active filters.`;
}
