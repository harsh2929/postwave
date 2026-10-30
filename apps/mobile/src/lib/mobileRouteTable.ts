/**
 * lib/mobileRouteTable.ts — the DATA half of the mobile navigation manifest:
 * the secondary-route rows themselves.
 *
 * Split out of `mobileRouteManifest.ts` when that file crossed its 450-line
 * source budget. The seam is deliberate and not merely mechanical: this file
 * is a table an engineer edits when they add a screen, while the manifest is
 * the ACCESS POLICY (capabilities, role floors, path resolution) that reads it.
 * Keeping the growing list out of the policy means adding a route never again
 * pushes the policy over a size ceiling.
 *
 * The row TYPE moved on to `mobileRouteTypes.ts` for the same reason, when the
 * table itself crossed 450 — this file is the one that grows with every screen
 * that ships, so it is the one that should carry nothing else.
 *
 * Consumers should keep importing from `mobileRouteManifest`, which re-exports
 * everything here — the split is an implementation detail.
 */
import { ADMIN_MOBILE_ROUTES } from "@/lib/mobileRoutesAdmin";
import { CORE_MOBILE_ROUTES } from "@/lib/mobileRoutesCore";
import type { MobileSecondaryRoute } from "@/lib/mobileRouteTypes";

export type {
  MobileAccessRole,
  MobileMoreSection,
  MobileSecondaryRoute,
} from "@/lib/mobileRouteTypes";
export { MOBILE_MORE_SECTION_ORDER } from "@/lib/mobileRouteTypes";

export const RAW_MOBILE_SECONDARY_ROUTES: readonly MobileSecondaryRoute[] = [
  ...CORE_MOBILE_ROUTES,
  ...ADMIN_MOBILE_ROUTES,
];
