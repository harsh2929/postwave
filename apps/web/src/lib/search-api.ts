// SPDX-License-Identifier: AGPL-3.0-only
//
// Client for the unified global-search endpoint (GET /api/v1/search), the same
// backend the desktop command palette already uses. Backs the web command
// palette's entity-aware results (Apple-level integration Phase 4 — search
// parity: upgrade the web palette from nav-only to entity-aware). Kept as a
// thin, pure module (no React) so the hit→destination mapping is unit-testable.

import {
  type SearchHitType,
  isSearchHitType,
  searchHitDestination,
} from "@postwave/route-map";

import { api } from "@/lib/api";

/** The entity types the global search returns (apps/api/internal/search). */
export type GlobalSearchType =
  | "list"
  | "segment"
  | "suppression"
  | "subscriber"
  | "campaign"
  | "flow"
  | "template"
  | "form";

export interface GlobalSearchResult {
  type: GlobalSearchType;
  id: string;
  title: string;
  detail?: string;
}

export interface GlobalSearchResponse {
  query: string;
  results: GlobalSearchResult[];
}

export const searchApi = {
  /** Run the tenant-scoped global search. Signal-aware so an in-flight request
   *  is aborted when the query changes (the palette debounces + cancels). */
  global: (q: string, opts?: { limit?: number; signal?: AbortSignal }) =>
    api.get<GlobalSearchResponse>(
      `/api/v1/search?q=${encodeURIComponent(q)}&limit=${opts?.limit ?? 8}`,
      { signal: opts?.signal },
    ),
};

/**
 * Where a web search hit lives on this surface. Never returns null: the palette
 * always navigates somewhere.
 *
 * Some entities have no addressable detail screen. `list` has a real collection
 * route at `/app/lists`, while `segment` lives nested under subscribers rather
 * than at `/app/segments`. When the shared resolver rejects an unsafe id, web
 * falls back to that entity's real collection home rather than inventing a URL.
 *
 * Everything else derives from the registry rather than a hardcoded template
 * literal, so a route move shows up in one place instead of drifting per client.
 */
const WEB_HOMES: Readonly<Record<SearchHitType, string>> = {
  list: "/app/lists",
  // The nested route the ACK records.
  segment: "/app/subscribers/segments",
  suppression: "/app/suppressions",
  subscriber: "/app/subscribers",
  campaign: "/app/campaigns",
  flow: "/app/flows",
  template: "/app/templates",
  form: "/app/forms",
};

export function searchHitHref(hit: GlobalSearchResult): string {
  if (!isSearchHitType(hit.type)) {
    // A type the server added and nobody wired. Land on the dashboard rather
    // than minting a path from an unknown string.
    return "/app";
  }
  const destination = searchHitDestination(hit.type, String(hit.id), "web");
  return destination?.path ?? WEB_HOMES[hit.type];
}

/** Short human label for a hit's type (palette row meta). */
export function searchHitTypeLabel(type: GlobalSearchType): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}
