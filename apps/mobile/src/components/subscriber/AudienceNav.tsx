/**
 * AudienceNav — lateral navigation across the four (soon five) audience
 * surfaces.
 *
 * Subscribers is a primary bottom-tab destination; Segments, Lists, Tags
 * and Suppressions live under More → Audience. They are one conceptual
 * surface with no way to move between them, so getting from a subscriber
 * to the list they're on meant backing all the way out to a menu.
 *
 * The row is driven by `routesForMoreSection("Audience")` rather than a
 * hardcoded array, so it stays in sync with the manifest — including its
 * role gating, and including any route the manifest gains later (the
 * Segments screen registers there). Subscribers is prepended because it is
 * a primary tab and therefore not in the secondary manifest.
 *
 * `router.replace` rather than `push`: these are siblings, not a drill-down,
 * so the back stack must not grow one entry per lateral hop.
 */
import { useMemo } from "react";
import { router } from "expo-router";

import { SegmentedControl } from "@/components/SegmentedControl";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  canAccessMobileSecondaryRoute,
  routesForMoreSection,
} from "@/lib/mobileRouteManifest";
import { useAuthStore } from "@/store/auth";

const SUBSCRIBERS_ROUTE = "/(tabs)/subscribers";

export function AudienceNav({ active }: { active: string }) {
  const gate = useOnlineQueryGate();
  const role = gate.effectiveRole;
  // An api_key session is capped at viewer, so the mode is load-bearing for
  // the role check — do not assume "session".
  const mode = useAuthStore((s) => s.mode);

  const options = useMemo(() => {
    const rows = routesForMoreSection("Audience")
      .filter((route) => canAccessMobileSecondaryRoute(route, role, mode))
      .map((route) => ({ value: route.route, label: route.label }));
    return [{ value: SUBSCRIBERS_ROUTE, label: "People" }, ...rows];
  }, [mode, role]);

  // One destination is not a navigation control.
  if (options.length < 2) return null;

  return (
    <SegmentedControl
      accessibilityLabel="Audience section"
      scrollable
      options={options}
      value={active}
      onChange={(next) => {
        if (next === active) return;
        router.replace(next as Parameters<typeof router.replace>[0]);
      }}
    />
  );
}

export { SUBSCRIBERS_ROUTE };
