/**
 * api/templateDiscovery.ts — transport for the template discovery layer:
 * stats tiles, recent views, saved searches, collections, and compare.
 *
 * Routes read off internal/server/campaign_sending.go (all mounted with the
 * `read` scope, session floor viewer for every method — the manifest agrees;
 * these are per-USER discovery state, not authoring):
 *
 *   GET    /api/v1/campaign-templates/stats
 *   GET    /api/v1/campaign-templates/recent          {items:[{template,…}]}
 *   DELETE /api/v1/campaign-templates/recent
 *   POST   /api/v1/campaign-templates/{id}/view       records one view
 *   GET    /api/v1/campaign-templates/compare?template=a&template=b   2..4
 *   GET    /api/v1/campaign-template-saved-searches   {items:[…]}
 *   POST   /api/v1/campaign-template-saved-searches
 *   DELETE /api/v1/campaign-template-saved-searches/{id}   (If-Match)
 *   GET    /api/v1/campaign-template-saved-searches/{id}/results
 *   GET    /api/v1/campaign-template-collections      {items:[…]}
 *   GET    /api/v1/campaign-template-collections/{id} (carries `items`)
 *
 * Editing a saved-search DEFINITION or a collection's membership stays a
 * desktop job; mobile lists, applies, saves the current search, and deletes.
 * Parsing lives in lib/templateDiscovery; this module is URLs and envelopes.
 */
import {
  parseCursorTemplatePage,
  parseRecentTemplateViews,
  type CursorTemplatePage,
  parseTemplateCollection,
  parseTemplateCollections,
  parseTemplateCompare,
  parseTemplateSavedSearches,
  parseTemplateStats,
  type RecentTemplateView,
  type TemplateCollection,
  type TemplateCompareResult,
  type TemplateSavedSearch,
  type TemplateStats,
} from "@/lib/templateDiscovery";

import { TEMPLATE_PAGE_SIZE } from "./campaignTemplates";
import { checkedApiResult, rawRequest } from "./request";

const TEMPLATES = "/api/v1/campaign-templates";
const SAVED = "/api/v1/campaign-template-saved-searches";
const COLLECTIONS = "/api/v1/campaign-template-collections";

export async function fetchTemplateStats(): Promise<TemplateStats | null> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", `${TEMPLATES}/stats`),
  );
  return parseTemplateStats(res.data);
}

export async function fetchRecentTemplateViews(): Promise<
  RecentTemplateView[]
> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", `${TEMPLATES}/recent`),
  );
  return parseRecentTemplateViews(res.data);
}

export async function clearRecentTemplateViews(): Promise<void> {
  await checkedApiResult(rawRequest<unknown>("DELETE", `${TEMPLATES}/recent`));
}

/**
 * Record that the operator OPENED a design. Press-driven by contract: the
 * detail sheet calls this when it opens, never a prefetch — a recent shelf
 * built from prefetches would remember things nobody looked at.
 */
export async function recordTemplateView(id: string): Promise<void> {
  await checkedApiResult(
    rawRequest<unknown>("POST", `${TEMPLATES}/${encodeURIComponent(id)}/view`),
  );
}

export function templateComparePath(ids: readonly string[]): string {
  const params = new URLSearchParams();
  for (const id of ids) params.append("template", id);
  return `${TEMPLATES}/compare?${params.toString()}`;
}

export async function fetchTemplateCompare(
  ids: readonly string[],
): Promise<TemplateCompareResult> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", templateComparePath(ids)),
  );
  return parseTemplateCompare(res.data);
}

export async function fetchTemplateSavedSearches(): Promise<
  TemplateSavedSearch[]
> {
  const res = await checkedApiResult(rawRequest<unknown>("GET", SAVED));
  return parseTemplateSavedSearches(res.data);
}

export interface SavedSearchCreateInput {
  name: string;
  /** SavedSearchFilters json keys — lib/templateDiscovery documents the map. */
  filters: {
    q?: string;
    goal?: string;
    source?: string;
    favorited?: boolean;
    archived?: string;
    sort?: string;
  };
}

export async function createTemplateSavedSearch(
  input: SavedSearchCreateInput,
): Promise<void> {
  await checkedApiResult(rawRequest<unknown>("POST", SAVED, input));
}

export async function deleteTemplateSavedSearch(
  id: string,
  etag: string,
): Promise<void> {
  await checkedApiResult(
    rawRequest<unknown>(
      "DELETE",
      `${SAVED}/${encodeURIComponent(id)}`,
      undefined,
      etag ? { headers: { "If-Match": etag } } : undefined,
    ),
  );
}

/**
 * One page of a saved search's results — the server re-runs the FULL stored
 * definition (SavedSearchResults → saved.Filters.SearchFilter), so axes
 * mobile has no control for still apply. Cursor-paged: pass the previous
 * page's `next_cursor` verbatim.
 */
export async function fetchSavedSearchResults(
  id: string,
  cursor: string | null,
): Promise<CursorTemplatePage> {
  const params = new URLSearchParams();
  params.set("per_page", String(TEMPLATE_PAGE_SIZE));
  if (cursor) params.set("cursor", cursor);
  const res = await checkedApiResult(
    rawRequest<unknown>(
      "GET",
      `${SAVED}/${encodeURIComponent(id)}/results?${params.toString()}`,
    ),
  );
  return parseCursorTemplatePage(res.data);
}

export async function fetchTemplateCollections(): Promise<
  TemplateCollection[]
> {
  const res = await checkedApiResult(rawRequest<unknown>("GET", COLLECTIONS));
  return parseTemplateCollections(res.data);
}

export async function fetchTemplateCollection(
  id: string,
): Promise<TemplateCollection | null> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", `${COLLECTIONS}/${encodeURIComponent(id)}`),
  );
  return parseTemplateCollection(res.data);
}
