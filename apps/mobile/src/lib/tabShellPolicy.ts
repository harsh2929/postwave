/**
 * lib/tabShellPolicy.ts — the (tabs) shell's one runtime decision, as a pure
 * function of (pathname, effective role, auth mode).
 *
 * WHY THIS IS ITS OWN MODULE. The decision used to live inline in
 * `app/(tabs)/_layout.tsx`, where it could not be tested: that file imports
 * expo-router and react-native, so a node-environment vitest suite cannot load
 * it. The same rule that produced `approvalPolicy` / `feedbackPolicy` /
 * `chartScale` applies here — the interesting part is a decision over data, so
 * it moves to a module whose transitive imports are data and types only
 * (`mobileRouteManifest` → `mobileRouteTable` → type-only imports).
 *
 * WHAT IT DECIDES. Whether the route the user is currently on is a secondary
 * destination their workspace role may not open. It returns the ROUTE (so the
 * caller can name it in the denial) rather than a boolean, because "denied" and
 * "which screen was denied" are the same fact and splitting them invites a
 * second, drifting path lookup.
 *
 * WHAT IT DELIBERATELY DOES NOT DECIDE. Nothing about rendering. The shell used
 * to answer a denial by returning the notice INSTEAD of the tab navigator,
 * which unmounted every tab — see the comment on MobileRouteAccessDenied in
 * `app/(tabs)/_layout.tsx`. Keeping the policy free of that choice is what let
 * the rendering be fixed without touching the policy.
 */
import {
  canAccessMobileSecondaryRoute,
  mobileSecondaryRouteForPath,
  type MobileSecondaryRoute,
} from "@/lib/mobileRouteManifest";

/**
 * The secondary route the current pathname resolves to, IF the caller's role
 * may not open it. `null` means "nothing to deny" — either the path is not a
 * gated secondary route (every primary tab, and every ungated secondary one),
 * or the role clears its floor.
 */
export function deniedSecondaryRoute(
  pathname: string,
  role: string | null | undefined,
  mode?: "api_key" | "session" | null,
): MobileSecondaryRoute | null {
  const route = mobileSecondaryRouteForPath(pathname);
  if (!route) return null;
  return canAccessMobileSecondaryRoute(route, role, mode) ? null : route;
}
