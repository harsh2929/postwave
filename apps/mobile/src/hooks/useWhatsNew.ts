/**
 * useWhatsNew — which product announcement (if any) the More screen shows.
 *
 * Three things happen here that the pure selector in `lib/whatsNew.ts`
 * deliberately does not do:
 *
 *  1. THE DISMISSAL RECORD IS READ ASYNCHRONOUSLY, so the card is withheld
 *     until it arrives. Rendering first and hiding on load would flash a card
 *     the user put down weeks ago on every cold start — the exact failure
 *     desktop's SidebarCallout shipped and had to fix (its useState captured
 *     the first callout's dismissal once).
 *  2. REACHABILITY comes from the route manifest and the caller's role, so a
 *     viewer is never offered a destination their More list hides.
 *  3. THE PATH comes from the manifest row, never from the announcement table:
 *     a renamed route file changes one place.
 *
 * A dismissal is optimistic in memory and best-effort on disk (the store never
 * throws). Worst case the card returns after a reinstall.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  canAccessMobileSecondaryRoute,
  MOBILE_SECONDARY_ROUTES,
} from "@/lib/mobileRouteManifest";
import { pickAnnouncement, type WhatsNewItem } from "@/lib/whatsNew";
import {
  dismissAnnouncement,
  readDismissedAnnouncements,
} from "@/lib/whatsNewStore";

export interface WhatsNewState {
  /** The single card to render, or null when there is nothing to say. */
  item: WhatsNewItem | null;
  /** Where the CTA lands — resolved from the route manifest. */
  route: string | null;
  /** False until the dismissal record has been read. */
  ready: boolean;
  dismiss: () => void;
}

export function useWhatsNew(input: {
  effectiveRole: string | null;
  mode: "api_key" | "session" | null;
}): WhatsNewState {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void readDismissedAnnouncements().then((keys) => {
      if (cancelled) return;
      setDismissed(keys);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const { effectiveRole, mode } = input;

  const item = useMemo(() => {
    if (!ready) return null;
    return pickAnnouncement({
      dismissed,
      canReach: (routeKey) => {
        const route = MOBILE_SECONDARY_ROUTES.find(
          (candidate) => candidate.key === routeKey,
        );
        return Boolean(
          route && canAccessMobileSecondaryRoute(route, effectiveRole, mode),
        );
      },
    });
  }, [dismissed, effectiveRole, mode, ready]);

  const route = useMemo(() => {
    if (!item) return null;
    return (
      MOBILE_SECONDARY_ROUTES.find(
        (candidate) => candidate.key === item.routeKey,
      )?.route ?? null
    );
  }, [item]);

  const dismiss = useCallback(() => {
    if (!item) return;
    const key = item.featureKey;
    // Optimistic: the card must go down on the tap, not on the write.
    setDismissed((prev) => (prev.includes(key) ? prev : [...prev, key]));
    void dismissAnnouncement(key).then(setDismissed);
  }, [item]);

  return { item, route, ready, dismiss };
}
