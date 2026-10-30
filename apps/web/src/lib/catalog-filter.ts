// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure filter / sort / facet logic for the integration catalog grid. Extracted
// from the catalog page component so the 630-item filtering, capability facets,
// and sort ordering are unit-tested independently of React (INTG-007/008/032/
// 036). The page component owns only the URL/debounce plumbing and rendering.

import type {
  CatalogItem,
  IntegrationRuntimeStatus,
} from "./integrations-catalog-api";

export type CatalogStatusFilter = "all" | IntegrationRuntimeStatus;

export const CATALOG_SORTS = ["featured", "name", "native", "status"] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];

export interface CatalogFilterState {
  search: string;
  category: string | null;
  status: CatalogStatusFilter;
  capability: string | null;
  nativeOnly: boolean;
  // INTG-029: show only integrations this workspace has connected.
  connectedOnly: boolean;
  sort: CatalogSort;
}

/** Bounded page size so the grid never mounts all ~630 card subtrees at once. */
export const CATALOG_PAGE_SIZE = 48;

export const CATALOG_FILTER_DEFAULTS: CatalogFilterState = {
  search: "",
  category: null,
  status: "all",
  capability: null,
  nativeOnly: false,
  connectedOnly: false,
  sort: "featured",
};

// Ranks a runtime status for the "status" sort (best-supported first).
const STATUS_RANK: Record<IntegrationRuntimeStatus, number> = {
  available: 0,
  partial: 1,
  delegated: 2,
  planned: 3,
};

/** True when no filter is narrowing the catalog (used to offer "Clear filters"). */
export function isCatalogFiltered(state: CatalogFilterState): boolean {
  return (
    state.search.trim() !== "" ||
    state.category !== null ||
    state.status !== "all" ||
    state.capability !== null ||
    state.nativeOnly ||
    state.connectedOnly
  );
}

/**
 * Applies every active facet to the catalog list (order-preserving). `connected`
 * (INTG-029) is a set of connected item slugs supplied by the page; the pure
 * core stays connection-agnostic and just joins on item.slug.
 */
export function filterCatalog(
  items: readonly CatalogItem[],
  state: CatalogFilterState,
  connected?: ReadonlySet<string>,
): CatalogItem[] {
  const q = state.search.trim().toLowerCase();
  return items.filter((item) => {
    if (state.connectedOnly && !connected?.has(item.slug)) return false;
    if (state.nativeOnly && !item.native) return false;
    if (state.category && item.category !== state.category) return false;
    if (state.status !== "all" && item.runtime_status !== state.status) {
      return false;
    }
    if (state.capability && !item.capabilities.includes(state.capability)) {
      return false;
    }
    if (q) {
      const haystack =
        `${item.name} ${item.slug} ${item.summary}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

/**
 * Sorts a (already-filtered) list. `Array.prototype.sort` is stable in every
 * supported engine, so equal-key items keep their incoming API order — which is
 * exactly the backend's featured-first ordering for the default sort.
 */
export function sortCatalog(
  items: readonly CatalogItem[],
  sort: CatalogSort,
): CatalogItem[] {
  const copy = [...items];
  switch (sort) {
    case "name":
      copy.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case "native":
      copy.sort(
        (a, b) =>
          Number(b.native) - Number(a.native) || a.name.localeCompare(b.name),
      );
      break;
    case "status":
      copy.sort(
        (a, b) =>
          STATUS_RANK[a.runtime_status] - STATUS_RANK[b.runtime_status] ||
          a.name.localeCompare(b.name),
      );
      break;
    case "featured":
    default:
      copy.sort(
        (a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)),
      );
      break;
  }
  return copy;
}

/** Convenience: filter then sort in one call. */
export function filterSortCatalog(
  items: readonly CatalogItem[],
  state: CatalogFilterState,
  connected?: ReadonlySet<string>,
): CatalogItem[] {
  return sortCatalog(filterCatalog(items, state, connected), state.sort);
}

export interface CatalogFacet {
  key: string;
  count: number;
}

/**
 * Capability facets across the full catalog with live counts, sorted by
 * frequency then name so the most-common capabilities lead. Only capabilities
 * that actually appear are returned (empty facets are dropped).
 */
export function capabilityFacets(items: readonly CatalogItem[]): CatalogFacet[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const cap of item.capabilities) {
      counts.set(cap, (counts.get(cap) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** Category facets with live counts, sorted by label. */
export function categoryFacets(
  items: readonly CatalogItem[],
  labelFor: (key: string) => string,
): Array<CatalogFacet & { label: string }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count, label: labelFor(key) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * A deterministic 1–2 letter monogram for a provider, used as a lightweight
 * visual scan aid on catalog cards where no real brand logo asset exists
 * (INTG-031). Derived from the display name so it is stable across renders.
 */
export function providerMonogram(name: string): string {
  const words = name
    .trim()
    .split(/[\s/&_-]+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return (words[0][0] + words[1][0]).toUpperCase();
}
