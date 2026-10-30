/**
 * api/search.ts — client for global search.
 *
 * Two corrections over the first pass:
 *
 * 1. It no longer LIES ON FAILURE. `globalSearch` used to swallow every error
 *    and resolve to `[]`, so a 500, an expired session or airplane mode all
 *    rendered as "No matches." — an authoritative claim that the workspace
 *    contains no such subscriber, which is the single most damaging thing a
 *    search box can say. It now returns the standard result envelope and the
 *    fan-out throws when nothing could be reached, so the screen can show an
 *    error instead of an empty state.
 *
 * 2. It FANS OUT for `tag` ONLY. The server index
 *    (apps/api/internal/search/index.go) covers eight types — list, segment,
 *    suppression, subscriber, campaign, flow, template, form — and tag is not
 *    among them, so the tags list endpoint's server-side `query=` fills the one
 *    real gap.
 *
 *    It used to fan out for campaigns too, correctly, back when the index
 *    covered four types. The index grew and this comment did not: campaigns
 *    then arrived from BOTH sources and fanOutSearch concatenates without
 *    deduping, so every matching campaign rendered twice. The union now comes
 *    from @postwave/route-map, which is checked against the Go source, so the
 *    two cannot drift apart again.
 */
import {
  type SearchHitType,
  mobilePath,
  searchHitDestination,
} from "@postwave/route-map";

import { rawRequest, type AIApiResult } from "./request";

/**
 * Everything the results list can show: the server's indexed types, plus `tag`,
 * which the index does not cover and mobile fans out for.
 *
 * Derived from the shared union rather than restated. The hand-written list
 * here was frozen at the four types the server indexed when it was written, so
 * flow / template / form hits were dropped before anything could route them —
 * and campaigns, which the server started indexing later, were requested twice.
 */
export type MobileSearchType = SearchHitType | "tag";

export interface MobileSearchHit {
  type: MobileSearchType;
  id: string;
  title: string;
  detail?: string;
}

export interface GlobalSearchResponse {
  query: string;
  results: MobileSearchHit[];
}

/**
 * Per-source cap. The server clamps `limit` to 50 and truncates the CONCATENATED
 * four-source set, so asking for 15 let list/segment/suppression hits crowd
 * subscribers — the type a search box is most used for — off the list entirely.
 * Asking for the full 50 makes that practically impossible.
 */
export const SEARCH_INDEX_LIMIT = 50;
/** Cap per fanned-out source, matching desktop's per-source slice. */
export const SEARCH_SOURCE_LIMIT = 5;

/** Run the tenant-scoped index search. Returns the raw result envelope. */
export function globalSearch(
  q: string,
  limit = SEARCH_INDEX_LIMIT,
): Promise<AIApiResult<GlobalSearchResponse>> {
  return rawRequest<GlobalSearchResponse>(
    "GET",
    `/api/v1/search?q=${encodeURIComponent(q)}&limit=${limit}`,
  );
}

interface TagSearchRow {
  id?: string;
  name?: string;
}

async function searchTags(q: string): Promise<MobileSearchHit[]> {
  const res = await rawRequest<{ items?: TagSearchRow[] }>(
    "GET",
    `/api/v1/tags?query=${encodeURIComponent(q)}`,
  );
  if (res.error) throw new Error(res.error.message);
  const rows = Array.isArray(res.data?.items) ? res.data?.items : [];
  return rows.slice(0, SEARCH_SOURCE_LIMIT).flatMap((row) =>
    row.id && row.name
      ? [{ type: "tag" as const, id: row.id, title: row.name }]
      : [],
  );
}

export interface FannedSearchResult {
  hits: MobileSearchHit[];
  /**
   * True when at least one source failed but others answered. The screen says
   * so rather than presenting a partial answer as complete — the same class of
   * lie the old swallow-everything behaviour produced, one level down.
   */
  partial: boolean;
  /** True when the index returned its full cap, so matches may be hidden. */
  truncated: boolean;
}

/**
 * Search every source in parallel.
 *
 * Throws only when NOTHING could be reached — a single failing source degrades
 * to `partial: true` so one flaky endpoint can't blank a working search.
 */
export async function fanOutSearch(q: string): Promise<FannedSearchResult> {
  // No campaigns fan-out: the server indexes them now. Keeping it meant every
  // matching campaign arrived from both sources, and fanOutSearch concatenates
  // without deduping, so each one rendered twice.
  const [index, tags] = await Promise.allSettled([globalSearch(q), searchTags(q)]);

  const hits: MobileSearchHit[] = [];
  let failures = 0;
  let truncated = false;

  if (index.status === "fulfilled" && !index.value.error) {
    const results = index.value.data?.results ?? [];
    truncated = results.length >= SEARCH_INDEX_LIMIT;
    hits.push(...results);
  } else {
    failures += 1;
  }

  for (const source of [tags]) {
    if (source.status === "fulfilled") hits.push(...source.value);
    else failures += 1;
  }

  if (failures === 2) {
    throw new Error("Search is unavailable right now.");
  }
  return { hits, partial: failures > 0, truncated };
}

export interface SearchHitTarget {
  pathname: string;
  params?: Record<string, string>;
}

/**
 * Where a hit goes.
 *
 * `subscriber` and `campaign` are route-map entities with real detail screens,
 * so they deep-link precisely. `segment` now has one too: the index selects
 * `segments.id::text` (apps/api/internal/search/index.go), which is exactly
 * the UUID `GET /api/v1/segments/{id}` and `/(tabs)/segments/[id]` want — it
 * used to land on the SUBSCRIBERS list pre-searched for the segment's NAME,
 * which found whoever happened to have that string in a tag or custom field
 * and had nothing to do with the segment's rule.
 *
 * `suppression` has a detail screen too — `app/(tabs)/suppressions/[email].tsx`
 * — but it is addressed by EMAIL, not by the row id the index returns
 * (internal/search/index.go selects `id::text` alongside `email` as the title).
 * So the hit's TITLE is what gets routed, through the same route-map resolver,
 * whose `isAddressableHitId` carries the email-shaped exception written for
 * exactly this screen. Anything that is not email-shaped falls back to the
 * pre-filtered collection.
 *
 * `list` and `tag` have no id-addressable mobile detail, so they carry the
 * hit's title as a `q` param and the destination seeds its own filter. (A list
 * hit's id is the Moosewave UUID while the mobile catalogue is keyed by the
 * gateway's Listmonk bigint, so deep-linking it would render a detail screen
 * with no name and no count.)
 */
export function searchHitRoute(hit: MobileSearchHit): SearchHitTarget {
  switch (hit.type) {
    case "subscriber":
      return detailTarget("subscriber", hit.id, "/(tabs)/subscribers");
    case "campaign":
      return detailTarget("campaign", hit.id, "/(tabs)/campaigns");
    case "segment":
      return segmentTarget(hit);
    case "list":
      return { pathname: "/(tabs)/lists", params: { q: hit.title } };
    case "tag":
      return { pathname: "/(tabs)/tags", params: { q: hit.title } };
    case "suppression":
      return suppressionTarget(hit);
    // Indexed by the server and shipped by mobile, but absent from the old
    // hand-written union — so these hits were dropped before routing.
    // Destinations come from the shared registry, which knows that mobile has a
    // detail screen for forms and only collection screens for flows and
    // templates.
    case "flow":
    case "template":
    case "form":
      return registryTarget(hit);
  }
}

/**
 * Route a hit through @postwave/route-map rather than a hardcoded path.
 *
 * The registry answers what this surface can actually show: a detail screen
 * where one exists, the collection where it does not. Passing `q` on the
 * collection case keeps the fallback useful — the operator lands on the list
 * pre-searched for what they typed, rather than on an unfiltered index.
 */
function registryTarget(hit: MobileSearchHit): SearchHitTarget {
  const destination = searchHitDestination(
    hit.type as SearchHitType,
    hit.id,
    "mobile",
  );
  if (!destination) {
    return { pathname: "/(tabs)/campaigns", params: { q: hit.title } };
  }
  const base = `/(tabs)/${destination.slug}`;
  if (destination.support === "detail") {
    return { pathname: `${base}/[id]`, params: { id: destination.id } };
  }
  return { pathname: base, params: { q: hit.title } };
}

/**
 * A suppression's identity is the address, so the detail route's param is
 * `[email]` and the hit's TITLE — not its id — is what addresses it.
 *
 * The shape check is the registry's, not a second regex here: `route-map`
 * already owns the conservative email rule (no slashes, no `..`, no
 * whitespace, one `@`) that keeps an unsafe value out of a path, and it was
 * written for this screen. A hit whose title does not pass it lands on the
 * collection pre-searched for the title, which is where every suppression hit
 * used to land unconditionally.
 */
function suppressionTarget(hit: MobileSearchHit): SearchHitTarget {
  const email = hit.title.trim();
  const destination = email
    ? searchHitDestination("suppression", email, "mobile")
    : null;
  if (!destination || destination.support !== "detail") {
    return { pathname: "/(tabs)/suppressions", params: { q: hit.title } };
  }
  return {
    pathname: "/(tabs)/suppressions/[email]",
    params: { email: destination.id },
  };
}

/** Segment ids are UUIDs; anything else is a gateway we don't recognise, so
 *  fall back to the catalogue rather than pushing an unroutable id. */
const SEGMENT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function segmentTarget(hit: MobileSearchHit): SearchHitTarget {
  if (!SEGMENT_ID_RE.test(hit.id.trim())) {
    return { pathname: "/(tabs)/segments", params: { q: hit.title } };
  }
  return { pathname: "/(tabs)/segments/[id]", params: { id: hit.id.trim() } };
}

function detailTarget(
  entity: "subscriber" | "campaign",
  id: string,
  listRoute: string,
): SearchHitTarget {
  const path = mobilePath(entity, id);
  // mobilePath returns `/(tabs)/<slug>/<id>`; expo-router needs the [id]
  // template plus params so the detail screen reads a typed id.
  if (path && path.endsWith(`/${id}`)) {
    return {
      pathname: `${path.slice(0, -(id.length + 1))}/[id]`,
      params: { id },
    };
  }
  return { pathname: listRoute };
}

const TYPE_LABELS: Record<MobileSearchType, string> = {
  list: "List",
  segment: "Segment",
  suppression: "Suppression",
  subscriber: "Subscriber",
  campaign: "Campaign",
  flow: "Flow",
  template: "Template",
  form: "Form",
  tag: "Tag",
};

/** Short display label for a hit's type. */
export function searchHitTypeLabel(type: MobileSearchType): string {
  return TYPE_LABELS[type] ?? type;
}

/** Stable group ordering for the results SectionList. */
export const SEARCH_TYPE_ORDER: readonly MobileSearchType[] = [
  "subscriber",
  "campaign",
  "flow",
  "form",
  "template",
  "list",
  "segment",
  "tag",
  "suppression",
];

export interface SearchSection {
  type: MobileSearchType;
  title: string;
  data: MobileSearchHit[];
}

/** Group hits into type sections, preserving SEARCH_TYPE_ORDER. */
export function groupSearchHits(
  hits: readonly MobileSearchHit[],
): SearchSection[] {
  const buckets = new Map<MobileSearchType, MobileSearchHit[]>();
  for (const hit of hits) {
    const bucket = buckets.get(hit.type);
    if (bucket) bucket.push(hit);
    else buckets.set(hit.type, [hit]);
  }
  return SEARCH_TYPE_ORDER.flatMap((type) => {
    const data = buckets.get(type);
    return data && data.length
      ? [{ type, title: `${searchHitTypeLabel(type)}s`, data }]
      : [];
  });
}
