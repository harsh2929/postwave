/**
 * hooks/useDashboardRefresh.ts — pull-to-refresh for the dashboard, lifted out
 * of `app/(tabs)/dashboard.tsx`.
 *
 * Two decisions live here that are easy to get wrong and invisible once
 * they are buried in a 300-line screen:
 *
 *  - A BLOCKED PULL SAYS SO. When the online gate is closed the gesture cannot
 *    fetch anything, and the spinner used to snap back in silence — which
 *    reads as "refreshed, nothing changed" rather than "we never asked". It now
 *    warns, in words, and reports `outcome: "blocked"` so the telemetry can
 *    tell a dead gesture apart from a successful one.
 *  - REFRESH MEANS EVERYTHING ON SCREEN. `refetchQueries({ type: "active" })`
 *    rather than an explicit list: the old four-way list forgot the
 *    onboarding-progress query, so completing a setup step elsewhere left the
 *    checklist visibly stale after a deliberate pull. An explicit list is a
 *    list somebody has to remember to update; "active" cannot fall behind.
 */
import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { EVENTS } from "@postwave/telemetry";

import { haptics } from "@/lib/haptics";
import { track } from "@/lib/telemetry";

export interface DashboardRefreshInput {
  /** Non-null when the online gate is closed; carries the message to show. */
  gateNotice: { staleMessage: string } | null;
  /** Reporting window, attached to the telemetry event. */
  range: string;
  toast: (options: {
    kind: "success" | "error" | "warning" | "info";
    message: string;
  }) => void;
}

export interface DashboardRefresh {
  /** True only for a USER-initiated refresh, so background polls don't spin. */
  refreshing: boolean;
  onRefresh: () => void;
}

export function useDashboardRefresh({
  gateNotice,
  range,
  toast,
}: DashboardRefreshInput): DashboardRefresh {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(() => {
    if (gateNotice) {
      haptics.warning();
      toast({ kind: "warning", message: gateNotice.staleMessage });
      track(EVENTS.MOBILE_DASHBOARD_REFRESHED, { outcome: "blocked", range });
      return;
    }
    haptics.tap();
    setRefreshing(true);
    void queryClient
      .refetchQueries({ type: "active" })
      .then(() => {
        haptics.success();
        track(EVENTS.MOBILE_DASHBOARD_REFRESHED, { outcome: "ok", range });
      })
      .catch(() => {
        haptics.error();
        track(EVENTS.MOBILE_DASHBOARD_REFRESHED, { outcome: "error", range });
      })
      .finally(() => setRefreshing(false));
  }, [gateNotice, queryClient, range, toast]);

  return { refreshing, onRefresh };
}
