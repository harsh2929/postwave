/**
 * hooks/useDashboardLayout.ts — the per-user card order the desktop saved.
 *
 * `GET /api/v1/dashboard/layout` (apps/api/internal/analytics/handlers.go
 * mounts it at analytics_realtime_routes.go:52 behind the `read:reports`
 * scope). The handler NEVER 404s: a user with no saved row gets the default
 * order back, so an absent preference and a fresh account look the same.
 *
 * READ ONLY, deliberately. The stored row is a single flat list shared with
 * the desktop's card SECTIONS as well as its stat cards, and the desktop
 * resolver discards keys it does not recognise — so a write from the phone
 * would erase whichever half of the list the phone does not model. The
 * reasoning is spelled out in lib/dashboardLayout.ts; what the phone wants
 * from this row is the order, and the order is exactly what it can read
 * safely.
 *
 * Keyed on the USER as well as the tenant: this is a per-user preference and
 * two people sharing a device must not inherit each other's grid.
 *
 * Cached for half an hour. A card order changes when somebody drags a card,
 * which is roughly never, and the pull-to-refresh on the dashboard refetches
 * every active query anyway — so a shorter window would buy nothing but
 * requests.
 */
import { useQuery } from "@tanstack/react-query";

import { getClient } from "@/api/client";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { parseDashboardLayoutOrder } from "@/lib/dashboardLayout";

export const DASHBOARD_LAYOUT_PATH = "/api/v1/dashboard/layout";

const LAYOUT_STALE_MS = 30 * 60_000;

export function useDashboardLayoutOrder() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["dashboard-layout", gate.tenantId, gate.userId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: LAYOUT_STALE_MS,
    // A missing layout is not an error worth retrying hard: the grid renders
    // its default order perfectly well without one.
    retry: 1,
    queryFn: async (): Promise<string[] | null> => {
      const { client } = getClient();
      const res = await client.request<unknown>("GET", DASHBOARD_LAYOUT_PATH);
      return parseDashboardLayoutOrder(res);
    },
  });
}
