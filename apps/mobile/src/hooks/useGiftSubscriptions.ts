/** TanStack wiring for the three mounted, read-only Gift archive reads. */
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import {
  fetchGiftStats,
  fetchGiftSubscription,
  GIFT_HISTORY_PAGE_SIZE,
  listGiftSubscriptions,
  nextGiftHistoryOffset,
} from "@/api/giftSubscriptions";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type {
  GiftHistoryFilter,
  GiftHistoryPage,
  GiftHistoryRecord,
  GiftHistorySort,
  GiftHistoryStats,
} from "@/lib/giftSubscriptions";

export type {
  GiftHistoryFilter,
  GiftHistoryPage,
  GiftHistoryRecord,
  GiftHistorySort,
  GiftHistoryStats,
  GiftHistoryStatus,
} from "@/lib/giftSubscriptions";

const LEDGER_STALE_MS = 60_000;
const ROLLUP_STALE_MS = 120_000;

export interface GiftHistoryQuery {
  query: string;
  filter: GiftHistoryFilter;
  sort?: GiftHistorySort;
}

export function useGiftSubscriptions({
  query,
  filter,
  sort = "newest",
}: GiftHistoryQuery) {
  const gate = useOnlineQueryGate();
  return useInfiniteQuery<GiftHistoryPage>({
    queryKey: [
      "gift-subscriptions",
      "list",
      gate.tenantId,
      query,
      filter,
      sort,
    ],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: LEDGER_STALE_MS,
    initialPageParam: 0,
    getNextPageParam: nextGiftHistoryOffset,
    queryFn: ({ pageParam }) =>
      listGiftSubscriptions({
        offset: Number(pageParam) || 0,
        limit: GIFT_HISTORY_PAGE_SIZE,
        query,
        filter,
        sort,
      }),
  });
}

export function useGiftStats() {
  const gate = useOnlineQueryGate();
  return useQuery<GiftHistoryStats>({
    queryKey: ["gift-subscriptions", "stats", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: ROLLUP_STALE_MS,
    queryFn: fetchGiftStats,
  });
}

export function useGiftSubscription(id: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery<GiftHistoryRecord | null>({
    queryKey: ["gift-subscriptions", "detail", gate.tenantId, id],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(id),
    staleTime: 0,
    retry: false,
    queryFn: () => fetchGiftSubscription(String(id)),
  });
}
