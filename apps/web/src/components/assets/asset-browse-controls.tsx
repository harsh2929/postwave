// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { LayoutGrid, List, RotateCcw } from "lucide-react";

import {
  ASSET_TILE_DENSITIES,
  type AssetTileDensity,
  type AssetViewMode,
} from "@/components/assets/asset-browse-helpers";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * Asset-library browse controls (desktop parity: LibraryToolbar's Grid / List
 * toggle and tile-size select, plus the smart-filter reset). Presentation-only
 * and client-side over the rows the page has already loaded: switching view or
 * density never refetches, and "Reset filters" hands the page one callback that
 * restores every filter to its default.
 *
 * The state hook and pure helpers live in ./asset-browse-helpers so the page
 * can import them eagerly while this control loads as its own chunk; they are
 * re-exported here for callers that only know this module.
 */

export {
  ASSET_TILE_DENSITIES,
  assetFiltersActive,
  assetGridClassName,
  DEFAULT_ASSET_BROWSE_FILTERS,
  useAssetBrowseView,
  type AssetBrowseFilters,
  type AssetTileDensity,
  type AssetViewMode,
} from "@/components/assets/asset-browse-helpers";

export function AssetBrowseControls({
  view,
  density,
  onViewChange,
  onDensityChange,
  filtersActive,
  onResetFilters,
  className,
}: {
  view: AssetViewMode;
  density: AssetTileDensity;
  onViewChange: (view: AssetViewMode) => void;
  onDensityChange: (density: AssetTileDensity) => void;
  filtersActive: boolean;
  onResetFilters: () => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <div
        role="group"
        aria-label="View mode"
        className="inline-flex rounded-md border bg-muted/50 p-1"
      >
        <Button
          type="button"
          size="sm"
          className="min-h-11 sm:min-h-8"
          variant={view === "grid" ? "secondary" : "ghost"}
          aria-pressed={view === "grid"}
          onClick={() => onViewChange("grid")}
        >
          <LayoutGrid className="h-4 w-4" aria-hidden />
          Grid
        </Button>
        <Button
          type="button"
          size="sm"
          className="min-h-11 sm:min-h-8"
          variant={view === "list" ? "secondary" : "ghost"}
          aria-pressed={view === "list"}
          onClick={() => onViewChange("list")}
        >
          <List className="h-4 w-4" aria-hidden />
          List
        </Button>
      </div>
      {view === "grid" ? (
        <div className="w-40">
          <Select
            aria-label="Tile size"
            value={density}
            onChange={(event) =>
              onDensityChange(event.target.value as AssetTileDensity)
            }
          >
            {ASSET_TILE_DENSITIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="min-h-11 sm:min-h-8"
        disabled={!filtersActive}
        title={
          filtersActive
            ? undefined
            : "Search, sort, and filters are already at their defaults."
        }
        onClick={onResetFilters}
      >
        <RotateCcw className="h-4 w-4" aria-hidden />
        Reset filters
      </Button>
    </div>
  );
}
