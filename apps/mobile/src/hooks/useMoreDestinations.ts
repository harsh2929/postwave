/**
 * useMoreDestinations — the More menu's row model.
 *
 * Extracted from `app/(tabs)/more.tsx` when the screen component crossed its
 * 300-line function budget after gaining a filter. The seam is a real one and
 * not a size dodge: everything here is DERIVATION (which routes this identity
 * may see, which are pinned, which are recent, which match a query) and none of
 * it is layout. The screen is left holding rendering and the two side effects
 * it owns — sign-out and refresh.
 *
 * The three-stage memo structure is load-bearing and is preserved exactly:
 *
 *   1. `baseSections` scans the route manifest once per ROLE/MODE change. It
 *      used to run six full Array.filter passes plus 22+ object allocations on
 *      every render, including every re-render the tab navigator triggers on
 *      each navigation.
 *   2. Pin state is applied in a SECOND memo, so pinning a row re-decorates the
 *      rows without re-running the manifest scan.
 *   3. The query filter is a THIRD memo over the decorated rows, so typing does
 *      not touch either of the first two.
 */
import { router } from "expo-router";
import { useMemo } from "react";

import type { MoreRow } from "@/components/more/MoreRows";
import { badgeLabel, badgeSpokenCount } from "@/hooks/useNotificationFeed";
import { useMoreNavPreferences } from "@/hooks/useMoreNavPreferences";
import {
  canAccessMobileSecondaryRoute,
  MOBILE_MORE_SECTION_ORDER,
  routesForMoreSection,
  type MobileMoreSection,
  type MobileSecondaryRoute,
} from "@/lib/mobileRouteManifest";
import { filterMoreRows } from "@/lib/moreFilter";
import { visibleFavorites, visibleRecents } from "@/lib/navPreferences";
import { newFeatureKeyForRoute } from "@/lib/whatsNew";

export interface MoreDestinationsInput {
  effectiveRole: string | null;
  mode: "api_key" | "session" | null;
  /** Unread notification count — badges the Notifications row. */
  unread: number;
  /** Current filter text. Empty means "browsing", not "no matches". */
  query: string;
  /** Replays the product tour (an Account-section action, not a route). */
  startTour: () => void;
  /** Confirms a pin/unpin. Long-press and the VoiceOver rotor are both silent. */
  onPinChanged: (label: string, pinned: boolean) => void;
}

export interface MoreDestinations {
  sections: Map<MobileMoreSection, MoreRow[]>;
  favoriteRows: MoreRow[];
  recentRows: MoreRow[];
  /** Ranked matches for `query`; empty array while browsing. */
  matches: MoreRow[];
  /** `query` with surrounding space removed — the screen branches on this. */
  trimmedQuery: string;
  /** Record a visit so the Recent list reflects it. */
  recordVisit: (key: string) => void;
}

export function useMoreDestinations({
  effectiveRole,
  mode,
  unread,
  query,
  startTour,
  onPinChanged,
}: MoreDestinationsInput): MoreDestinations {
  const baseSections = useMemo(() => {
    const rowFromRoute = (route: MobileSecondaryRoute): MoreRow => {
      const newFeatureKey = newFeatureKeyForRoute(route.key);
      return {
      key: route.key,
      icon: route.icon,
      label: route.label,
      hint: route.hint,
      to: route.route,
      // The visible pill is capped ("99+"); the SPOKEN one is not. Without
      // `badgeSpoken` the MoreRow label falls back to the capped string, so a
      // VoiceOver user hears "99 plus unread" on this row while the tab bar
      // one screen away speaks the exact number (app/(tabs)/_layout.tsx).
      ...(route.key === "notifications" && badgeLabel(unread)
        ? {
            badge: badgeLabel(unread),
            badgeSpoken: badgeSpokenCount(unread),
          }
        : {}),
      // 30-day discovery badge, from the same registry the what's-new card
      // reads (lib/whatsNew over lib/newFeatures). Evaluated with THIS memo,
      // so a badge that expires while the app sits open clears on the next
      // role/mode/unread change rather than mid-frame — which is the right
      // resolution for a 30-day window and avoids a timer on the More screen.
      ...(newFeatureKey ? { newFeatureKey } : {}),
      };
    };
    const built = new Map<MobileMoreSection, MoreRow[]>();
    for (const section of MOBILE_MORE_SECTION_ORDER) {
      built.set(
        section,
        routesForMoreSection(section)
          .filter((route) =>
            canAccessMobileSecondaryRoute(route, effectiveRole, mode),
          )
          .map(rowFromRoute),
      );
    }
    built.get("Account")?.push({
      key: "tour",
      icon: "help",
      label: "Replay product tour",
      hint: "A quick guided walkthrough",
      onPress: () => {
        // Replay from the dashboard so the tour's spotlight targets exist;
        // give the screen a beat to mount before the overlay starts.
        router.push("/(tabs)/dashboard");
        setTimeout(() => startTour(), 450);
      },
    });
    return built;
  }, [effectiveRole, mode, startTour, unread]);

  const { preferences, toggleFavorite, recordVisit } = useMoreNavPreferences();

  const { sections, favoriteRows, recentRows } = useMemo(() => {
    const byKey = new Map<string, MoreRow>();
    for (const rows of baseSections.values()) {
      for (const row of rows) byKey.set(row.key, row);
    }
    const known = (key: string) => byKey.has(key);
    const pinned = new Set(visibleFavorites(preferences, known));
    const decorate = (row: MoreRow): MoreRow => ({
      ...row,
      favorite: pinned.has(row.key),
      onToggleFavorite: () => {
        onPinChanged(row.label, toggleFavorite(row.key));
      },
    });
    const decorated = new Map<MobileMoreSection, MoreRow[]>();
    for (const [section, rows] of baseSections) {
      decorated.set(section, rows.map(decorate));
    }
    const pick = (keys: string[]) =>
      keys
        .map((key) => byKey.get(key))
        .filter((row): row is MoreRow => Boolean(row))
        .map(decorate);
    return {
      sections: decorated,
      favoriteRows: pick(visibleFavorites(preferences, known)),
      // Recents exclude anything already pinned: showing a destination twice
      // costs the row that would otherwise carry a genuinely new suggestion.
      recentRows: pick(visibleRecents(preferences, known)),
    };
  }, [baseSections, preferences, toggleFavorite, onPinChanged]);

  // A query collapses the six sections into ONE ranked list. Section membership
  // is only useful while browsing; once the user has typed "dmar" it is noise
  // that pushes the answer below the fold.
  const trimmedQuery = query.trim();
  const matches = useMemo(() => {
    if (!trimmedQuery) return [];
    const all: MoreRow[] = [];
    for (const section of MOBILE_MORE_SECTION_ORDER) {
      const rows = sections.get(section);
      if (rows) all.push(...rows);
    }
    return filterMoreRows(all, trimmedQuery);
  }, [sections, trimmedQuery]);

  return {
    sections,
    favoriteRows,
    recentRows,
    matches,
    trimmedQuery,
    recordVisit,
  };
}
