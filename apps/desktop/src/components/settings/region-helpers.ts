/**
 * region-helpers — pure logic for the read-only Settings "Region"
 * card (#57). Public endpoints (/api/regions, /api/regions/current)
 * live OUTSIDE /api/v1 and need no auth.
 */

import type { CurrentRegionInfo, RegionInfo } from "../../lib/api-client";

/** Compact zone label for a region row or the current deployment. */
export function regionZoneLabel(r: {
  is_eu: boolean;
  is_us?: boolean;
}): string {
  if (r.is_eu) return "EU";
  if (r.is_us) return "US";
  return "Other";
}

/** One-liner describing the deployment this workspace is served from. */
export function describeCurrentRegion(c: CurrentRegionInfo): string {
  return `This workspace is served from the ${c.region} region (${regionZoneLabel(c)}).`;
}

/** Current region first, then the rest alphabetically. */
export function sortRegions(
  regions: RegionInfo[],
  currentRegion?: string,
): RegionInfo[] {
  return [...regions].sort((a, b) => {
    if (currentRegion) {
      if (a.region === currentRegion && b.region !== currentRegion) return -1;
      if (b.region === currentRegion && a.region !== currentRegion) return 1;
    }
    // A row can arrive without `region` — coerce so the sort never
    // crashes on `undefined.localeCompare`.
    return (a.region ?? "").localeCompare(b.region ?? "");
  });
}
