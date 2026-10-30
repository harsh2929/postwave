// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState } from "react";

import type { AssetFilter, AssetSort } from "@/lib/assets-api";

/**
 * Pure state and class helpers behind the asset-library browse controls.
 * They live apart from the control component so the /app/assets page can
 * keep them in its eager graph while the control itself (and its icons)
 * loads as its own chunk.
 */

export type AssetViewMode = "grid" | "list";
export type AssetTileDensity = "compact" | "cozy" | "comfortable";

export const ASSET_TILE_DENSITIES: ReadonlyArray<{
  value: AssetTileDensity;
  label: string;
}> = [
  { value: "compact", label: "Compact" },
  { value: "cozy", label: "Default" },
  { value: "comfortable", label: "Comfortable" },
];

/** Grid classes per density; "cozy" is the page's original three-up grid. */
const GRID_CLASS: Record<AssetTileDensity, string> = {
  compact:
    "grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5",
  cozy: "grid gap-3 sm:grid-cols-2 lg:grid-cols-3",
  comfortable: "grid gap-4 lg:grid-cols-2",
};

export function assetGridClassName(density: AssetTileDensity): string {
  return GRID_CLASS[density];
}

export interface AssetBrowseFilters {
  query: string;
  sort: AssetSort;
  filter: AssetFilter;
  folderId: string;
  tag: string;
}

export const DEFAULT_ASSET_BROWSE_FILTERS: AssetBrowseFilters = {
  query: "",
  sort: "newest",
  filter: "all",
  folderId: "",
  tag: "",
};

/** True when any search, sort, smart filter, folder, or tag differs from default. */
export function assetFiltersActive(filters: AssetBrowseFilters): boolean {
  return (
    filters.query.trim() !== DEFAULT_ASSET_BROWSE_FILTERS.query ||
    filters.sort !== DEFAULT_ASSET_BROWSE_FILTERS.sort ||
    filters.filter !== DEFAULT_ASSET_BROWSE_FILTERS.filter ||
    filters.folderId !== DEFAULT_ASSET_BROWSE_FILTERS.folderId ||
    filters.tag !== DEFAULT_ASSET_BROWSE_FILTERS.tag
  );
}

/** View + density state for the page (session-local; nothing is persisted). */
export function useAssetBrowseView(initial?: {
  view?: AssetViewMode;
  density?: AssetTileDensity;
}) {
  const [view, setView] = useState<AssetViewMode>(initial?.view ?? "grid");
  const [density, setDensity] = useState<AssetTileDensity>(
    initial?.density ?? "cozy",
  );
  return { view, setView, density, setDensity };
}
