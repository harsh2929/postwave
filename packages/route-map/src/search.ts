/**
 * One result-type union for `/api/v1/search`, and one destination resolver, so
 * every client agrees on what a search hit is and where it goes.
 *
 * WHY THIS EXISTS. The server emits eight hit types (see SEARCH_HIT_TYPES).
 * Each client then decided independently what to do with them, and each decided
 * differently:
 *
 *   - desktop's `serverHitToTarget` switched on subscriber / list / **tag** /
 *     segment / suppression and returned `null` for everything else. `tag` is a
 *     type the server has never emitted, and the `return null` fallthrough
 *     silently dropped campaign, flow, template and form hits — a quarter of the
 *     index, invisible in the palette with no error to notice.
 *   - web's `searchHitHref` route-mapped subscriber and campaign, hardcoded
 *     template literals for flow / template / form, and dropped segment /
 *     suppression / list onto index screens.
 *   - mobile mapped its own subset again.
 *
 * Three hand-maintained copies of one rule, each validated on its own side, is
 * not one rule. `check-route-map-destinations.mjs` now parses the Go source for
 * the types the server actually emits and fails if this union drifts in either
 * direction — a new server type nobody wired, or a client type the server never
 * sends.
 *
 * Destinations come from the ENTITIES registry rather than being restated here,
 * so a hit lands wherever that surface really addresses the entity: a detail
 * screen where one exists, the collection where it does not, and `null` only
 * when the surface does not ship the feature at all.
 */

import {
  ENTITIES,
  type EntityKey,
  type RouteSurface,
  isSafeResourceId,
} from "./entities.js";

/**
 * The result types `GET /api/v1/search` can return, in the order
 * `internal/search/index.go` collects them.
 *
 * This list is the contract. It is checked against the Go source by
 * `scripts/check-route-map-destinations.mjs`, so it cannot quietly fall behind
 * the server or carry a type the server dropped.
 */
export const SEARCH_HIT_TYPES = [
  "list",
  "segment",
  "suppression",
  "subscriber",
  "campaign",
  "flow",
  "template",
  "form",
] as const;

export type SearchHitType = (typeof SEARCH_HIT_TYPES)[number];

const SEARCH_HIT_TYPE_SET: ReadonlySet<string> = new Set(SEARCH_HIT_TYPES);

/** Narrow an arbitrary server string to a known hit type. */
export function isSearchHitType(value: unknown): value is SearchHitType {
  return typeof value === "string" && SEARCH_HIT_TYPE_SET.has(value);
}

/**
 * Hit type → entity key. They coincide today for all eight, but the server's
 * search vocabulary and the routing registry are separate contracts that
 * happen to agree; mapping through a table keeps a future divergence
 * (`suppression` vs `email-suppression`, say) from being a silent breakage.
 */
const HIT_TYPE_ENTITY: Readonly<Record<SearchHitType, EntityKey>> = {
  list: "list",
  segment: "segment",
  suppression: "suppression",
  subscriber: "subscriber",
  campaign: "campaign",
  flow: "flow",
  template: "template",
  form: "form",
};

export function searchHitEntity(type: SearchHitType): EntityKey {
  return HIT_TYPE_ENTITY[type];
}

export interface SearchHitDestination {
  /** The entity this hit belongs to. */
  entity: EntityKey;
  /** Plural URL slug — `campaigns`, `subscribers`. */
  slug: string;
  /**
   * How much of the entity this surface can show. "detail" means `id` is in
   * the path; "list" means the hit lands on the collection because no detail
   * screen exists on this surface.
   */
  support: "detail" | "list";
  /** In-app path for the surface, with no origin. */
  path: string;
  /** The id carried through, so a caller can highlight or query by it. */
  id: string;
}

/**
 * Where a search hit goes on a given surface.
 *
 * Returns null only when the surface does not ship the entity at all — the one
 * case where dropping the hit is right, because there is nothing to navigate
 * to. Every other type resolves, which is the property the conformance test
 * pins: no client may silently discard a type the server indexes.
 */
export function searchHitDestination(
  type: SearchHitType,
  id: string,
  surface: RouteSurface,
): SearchHitDestination | null {
  const entity = HIT_TYPE_ENTITY[type];
  const def = ENTITIES[entity];
  if (!def) return null;
  const support = def.surfaces[surface];
  if (support === "none") return null;

  const base = `/app/${def.slug}`;
  const trimmed = String(id).trim();
  // A detail path needs an id the router can safely carry. An unusable id falls
  // back to the collection rather than minting `/app/campaigns/` or a path with
  // a traversal in it.
  const addressable = support === "detail" && isAddressableHitId(trimmed);
  return {
    entity,
    slug: def.slug,
    support: addressable ? "detail" : "list",
    path: addressable ? `${base}/${encodeURIComponent(trimmed)}` : base,
    id: trimmed,
  };
}

/**
 * Whether a search hit's id can be put in a path.
 *
 * `isSafeResourceId` is the shared rule and stays the default: opaque ids only,
 * `[A-Za-z0-9_-]`, which rejects path traversal outright rather than relying on
 * encoding to neutralise it.
 *
 * Suppressions are the exception, and a real one — the record's identity IS an
 * email address (mobile ships `app/(tabs)/suppressions/[email].tsx`), and
 * `isSafeResourceId` rejects every email because of the `@` and the dot. So a
 * conservative email shape is accepted alongside it: no slashes, no dot-dot, no
 * control characters, no whitespace, one `@`. Everything that passes is still
 * percent-encoded before it reaches a path.
 *
 * Widening `isSafeResourceId` itself would have been the wrong fix — it guards
 * deep links, share sheets and rehydrated caches across three surfaces, and
 * loosening it for one screen's benefit spends a security property on a
 * convenience.
 */
function isAddressableHitId(id: string): boolean {
  const looksLikeEmail =
    id.length > 0 &&
    id.length <= 254 &&
    !id.includes("..") &&
    /^[^\s/\\@]+@[^\s/\\@]+\.[^\s/\\@]+$/.test(id);
  return looksLikeEmail || isSafeResourceId(id);
}
