/**
 * Pure helpers for the CommandPalette's server-side search source
 * (WIRING-COVERAGE #59 — GET /api/v1/search via `searchApi.global`).
 *
 * Kept DOM-free / React-free so the vitest node environment can
 * exercise the mapping + dedupe rules directly (same pattern as
 * notifications-panel-helpers.ts and friends).
 */

import {
  type SearchHitType,
  isSearchHitType,
  searchHitDestination,
} from "@postwave/route-map";

import type { GlobalSearchResult } from "../lib/api-client";
import type { Section } from "../lib/store";

/**
 * Palette item kinds a server hit can map to.
 *
 * Derived from the shared search union rather than restated. This list used to
 * be hand-maintained and had drifted in both directions: it carried a `tag`
 * kind the server has never emitted, and it lacked campaign / flow / template /
 * form — which the `default: return null` below then dropped silently, so a
 * quarter of the search index was invisible in the palette with nothing to
 * notice.
 */
export type ServerHitKind = SearchHitType;

export interface ServerHitTarget {
  /** Stable palette item id — primary dedupe key vs per-type fetches. */
  itemId: string;
  /**
   * Extra ids this hit collides with. The per-type subscriber fetch
   * keys rows by email (`subscriber:<email>`) while the server returns
   * the record id, so the email-keyed alias catches that overlap.
   */
  aliasIds: string[];
  kind: ServerHitKind;
  section: Section;
  /**
   * Pending deep-link id for the destination page, or null when the
   * page doesn't consume `consumePendingDeepLinkTarget()`.
   */
  targetId: string | null;
  group: string;
}

/** Display group per hit type. */
const HIT_GROUP: Readonly<Record<SearchHitType, string>> = {
  subscriber: "Subscribers",
  list: "Lists",
  segment: "Segments",
  suppression: "Suppressions",
  campaign: "Campaigns",
  flow: "Flows",
  template: "Templates",
  form: "Forms",
};

/**
 * Types the destination page addresses by a human key rather than a record id.
 *
 * Subscribers and suppressions are both reached by email: the subscribers page
 * matches email OR id and the email doubles as its search query, and the
 * suppressions page exact-searches by email. Everything else deep-links by id.
 */
const ADDRESSED_BY_TITLE: ReadonlySet<SearchHitType> = new Set([
  "subscriber",
  "suppression",
]);

/**
 * Map one `/api/v1/search` hit onto a palette navigation target.
 *
 * Destinations come from @postwave/route-map, which knows which surfaces
 * actually ship which entity. A null result now means one specific thing —
 * desktop has no screen for this entity, so there is nowhere to navigate — and
 * `flow` is the only type for which that is true. Previously null also covered
 * "nobody wrote a branch for it", which is why four types vanished.
 */
export function serverHitToTarget(
  hit: GlobalSearchResult,
): ServerHitTarget | null {
  if (!isSearchHitType(hit.type)) return null;
  const id = String(hit.id);
  const destination = searchHitDestination(hit.type, id, "desktop");
  if (destination === null) return null;

  const byTitle = ADDRESSED_BY_TITLE.has(hit.type);
  return {
    itemId: `${hit.type}:${id}`,
    // The per-type subscriber fetch keys rows by email; alias so the two
    // sources dedupe against each other.
    aliasIds: byTitle ? [`${hit.type}:${hit.title}`] : [],
    kind: hit.type,
    section: destination.slug as Section,
    targetId:
      byTitle && hit.title.includes("@")
        ? hit.title
        : destination.support === "detail"
          ? id
          : null,
    group: HIT_GROUP[hit.type],
  };
}

/**
 * Should a server hit of `kind` render given the palette's enabled
 * categories (after prefix routing)?
 *
 *   - subscriber → "@" or unprefixed
 *   - list / segment → "#" or unprefixed (segments are list-siblings)
 *   - tag → "#" or unprefixed
 *   - suppression → unprefixed only (no dedicated prefix)
 */
export function serverHitVisible(
  kind: ServerHitKind,
  cats: ReadonlySet<string>,
): boolean {
  switch (kind) {
    case "subscriber":
      return cats.has("subscribers");
    case "list":
    case "segment":
      return cats.has("lists");
    case "suppression":
      return cats.has("subscribers") && cats.has("lists");
    // Newly routable. Each maps to the palette category that already exists for
    // its own section, so a prefix-filtered palette keeps filtering; before
    // this they were dropped before visibility was ever consulted.
    case "campaign":
      return cats.has("campaigns");
    case "template":
      return cats.has("templates");
    case "form":
      return cats.has("forms");
    case "flow":
      // Unreachable: serverHitToTarget returns null for flow on desktop, which
      // ships no flows section. Kept so the switch stays exhaustive over the
      // shared union — if desktop gains flows, this is where it turns on.
      return false;
  }
}
