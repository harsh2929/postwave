/**
 * hooks/useCommerce.ts — query wiring for the store-pipeline surface.
 *
 * The parsing lives in `lib/commerceRollup` (pure, unit-tested); this file is
 * only the TanStack layer, plus the cache invalidation a resume must trigger.
 *
 * OFFLINE. Every query is behind `useOnlineQueryGate`, so offline they never
 * run — which in TanStack v5 is status "pending" with fetchStatus "idle", i.e.
 * `isLoading` FALSE and `isError` FALSE. A screen that falls through that to
 * "no stores connected" is stating a fact it does not have; `QueryStates` owns
 * the offline branch instead.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchCommerceAnalytics,
  listCommerceOrders,
  listCommerceRecovery,
  listCommerceStores,
  resumeCommerceSync,
} from "@/api/commerce";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { CommerceOrdersPage } from "@/lib/commerceOrders";
import type { RecoveryKind, RecoveryPage } from "@/lib/commerceRecovery";
import type { CommerceAnalytics, CommerceStore } from "@/lib/commerceRollup";

export type {
  CommerceAttributionSlice,
  CommerceOrderLine,
  CommerceOrdersPage,
} from "@/lib/commerceOrders";
export type {
  RecoveryKind,
  RecoveryLine,
  RecoveryPage,
} from "@/lib/commerceRecovery";
export type { CommerceAnalytics, CommerceStore } from "@/lib/commerceRollup";

/**
 * A store list is a handful of rows that change when someone connects a shop —
 * minutes, not seconds. The ANALYTICS underneath it move with every order, so
 * they get a much shorter window.
 */
const STORES_STALE_MS = 60_000;
const ANALYTICS_STALE_MS = 30_000;
/**
 * Orders share the analytics window on purpose. The strip and the list answer
 * the same question at two zoom levels, and giving them different staleness is
 * how "3,120 orders" ends up sitting above a list whose newest row is older
 * than the count that counted it.
 */
const ORDERS_STALE_MS = ANALYTICS_STALE_MS;

export function useCommerceStores() {
  const gate = useOnlineQueryGate();
  return useQuery<CommerceStore[]>({
    queryKey: ["commerce", "stores", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: STORES_STALE_MS,
    queryFn: () => listCommerceStores(),
  });
}

/**
 * Analytics for ONE store. `enabled` carries the selected id, so switching
 * stores in the segmented control cancels nothing and re-uses anything already
 * cached for the store you switch back to.
 */
export function useCommerceAnalytics(integrationId: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery<CommerceAnalytics>({
    queryKey: ["commerce", "analytics", gate.tenantId, integrationId],
    enabled:
      gate.enabled && Boolean(gate.tenantId) && Boolean(integrationId),
    staleTime: ANALYTICS_STALE_MS,
    queryFn: () => fetchCommerceAnalytics(String(integrationId)),
  });
}

/**
 * The most recent orders for ONE store — page one only.
 *
 * Keyed on the store id the same way analytics is, so switching stores in the
 * list re-uses anything already cached rather than re-fetching a page the
 * device paid for thirty seconds ago.
 */
export function useCommerceOrders(integrationId: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery<CommerceOrdersPage>({
    queryKey: ["commerce", "orders", gate.tenantId, integrationId],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(integrationId),
    staleTime: ORDERS_STALE_MS,
    queryFn: () => listCommerceOrders(String(integrationId)),
  });
}

/**
 * One store's recovery queue, for ONE of the three kinds.
 *
 * Only the selected kind is fetched. Three parallel queries would triple the
 * cellular cost of a screen whose whole point is a glance, and the two lists
 * not on screen answer no question the reader has asked.
 *
 * Shares the ORDERS staleness window rather than the (longer) store window:
 * an eligible back-in-stock row is a promise with a clock on it, so it belongs
 * in the same freshness class as the newest orders, not the same class as
 * "which shops are connected".
 */
export function useCommerceRecovery(
  integrationId: string | null,
  kind: RecoveryKind,
) {
  const gate = useOnlineQueryGate();
  return useQuery<RecoveryPage>({
    queryKey: ["commerce", "recovery", gate.tenantId, integrationId, kind],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(integrationId),
    staleTime: ORDERS_STALE_MS,
    queryFn: () => listCommerceRecovery(String(integrationId), kind),
  });
}

/**
 * Resume a stalled backfill.
 *
 * NOT optimistic, and deliberately so: the server answers 202 ("accepted"),
 * not "done". Flipping the card to a green "syncing" state on the client would
 * be claiming an outcome the response does not carry. The invalidation below
 * is what makes the truth arrive — the next fetch of the list re-reads the
 * cursor the server actually holds.
 */
export function useResumeCommerceSync() {
  const client = useQueryClient();
  return useMutation<void, unknown, string>({
    mutationFn: (integrationId: string) => resumeCommerceSync(integrationId),
    onSuccess: (_data, integrationId) => {
      void client.invalidateQueries({ queryKey: ["commerce", "stores"] });
      // Analytics AND the order list: a successful pull writes new
      // `commerce_orders` rows, so leaving the list on its 30s window would
      // show a resumed store whose "recent orders" predate the resume.
      //
      // `recovery` for a subtler reason: a pull that lands new inventory is
      // exactly what flips a back-in-stock row from `waiting` to `eligible`
      // (repo.go:3563), so the queue this screen calls urgent is a direct
      // consequence of the button the operator just pressed.
      for (const family of ["analytics", "orders", "recovery"] as const) {
        void client.invalidateQueries({
          queryKey: ["commerce", family],
          predicate: (query) => query.queryKey.includes(integrationId),
        });
      }
    },
  });
}
