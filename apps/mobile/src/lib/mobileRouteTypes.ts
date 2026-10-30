/**
 * lib/mobileRouteTypes.ts — the SHAPE of a mobile secondary route.
 *
 * Split from `mobileRouteTable.ts` when that file crossed its 450-line ceiling
 * for the second time. The seam matches the one that produced the table in the
 * first place: the manifest holds POLICY, the table holds DATA, and this holds
 * the TYPE the other two agree on. A row is added to the table roughly every
 * time a screen ships, so the table is the part that grows without bound — the
 * type is not, and it should stop being dragged over a ceiling by it.
 *
 * Consumers should keep importing from `mobileRouteManifest`, which re-exports
 * all three — the split is an implementation detail.
 */
import type { EntityKey } from "@postwave/route-map";

import type { IconName } from "@/components/TabBarIcon";

export type MobileMoreSection =
  | "Audience"
  | "Tools"
  | "Sending"
  | "Content"
  | "Enterprise"
  | "Account";

export type MobileAccessRole =
  | "viewer"
  | "member"
  | "editor"
  | "admin"
  | "owner";


export interface MobileSecondaryRoute {
  key: string;
  label: string;
  hint: string;
  route: string;
  routeFile: string;
  icon: IconName;
  moreSection: MobileMoreSection;
  /** Canonical @postwave/nav key when this row also exists in the nav manifest. */
  navKey?: string;
  /** Entity deep-link key when this route is a list/detail landing for route-map. */
  entityKey?: EntityKey;
  /** Minimum effective workspace role required for this route to appear. */
  minimumRole?: MobileAccessRole;
}

export const MOBILE_MORE_SECTION_ORDER: readonly MobileMoreSection[] = [
  "Audience",
  "Tools",
  "Sending",
  "Content",
  "Enterprise",
  "Account",
];

