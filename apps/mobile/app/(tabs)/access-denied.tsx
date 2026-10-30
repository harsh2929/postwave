/**
 * Hidden role-denial destination.
 *
 * SecondaryRouteGuard replaces a forbidden deep-linked screen with this
 * route. A real route is preferable to an overlay that lives indefinitely:
 * React Navigation can keep the bottom rail mounted, while the restricted
 * screen itself unmounts and is no longer reachable by VoiceOver.
 */
import { useLocalSearchParams } from "expo-router";

import { MobileRouteAccessDenied } from "@/components/SecondaryRouteGuard";
import { MOBILE_SECONDARY_ROUTES } from "@/lib/mobileRouteManifest";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

function firstParam(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

export default function AccessDeniedScreen() {
  const params = useLocalSearchParams<{ routeKey?: string | string[] }>();
  const routeKey = firstParam(params.routeKey);
  const route = MOBILE_SECONDARY_ROUTES.find((row) => row.key === routeKey);

  return (
    <MobileRouteAccessDenied
      label={route?.label ?? "This screen"}
      tabBarHeight={0}
    />
  );
}
