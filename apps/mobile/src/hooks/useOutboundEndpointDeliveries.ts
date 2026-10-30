/**
 * hooks/useOutboundEndpointDeliveries.ts — one receiver's delivery history,
 * paged, for the OutboundDeliveriesSheet.
 *
 * Fetched ONLY while a sheet is open (`id` null otherwise): the Webhooks
 * screen already runs three queries, and a fourth firing for every row on
 * mount would be the on-call surface paying for a drill-down nobody opened.
 *
 * Online-only like the rest of the outbound surface — it is a live
 * diagnostic, and a cached page of "recent attempts" from yesterday is
 * exactly the wrong answer to "is it delivering right now?".
 */
import { useInfiniteQuery } from "@tanstack/react-query";

import {
  listWebhookDeliveries,
  OUTBOUND_ENDPOINT_DELIVERIES_LIMIT,
} from "@/api/outboundWebhookDeliveries";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { OutboundDeliveryPage } from "@/lib/outboundDeliveryPage";

/**
 * Shares the "outbound-webhook-" prefix with the endpoint list, the global
 * feed and the health rollup, so the bulk controller's prefix invalidation
 * reaches this page too after a pause/resume/delete.
 */
export const OUTBOUND_ENDPOINT_DELIVERIES_KEY = "outbound-webhook-endpoint-deliveries";

export function useOutboundEndpointDeliveries(id: string | null) {
  const gate = useOnlineQueryGate();
  return useInfiniteQuery({
    queryKey: [OUTBOUND_ENDPOINT_DELIVERIES_KEY, gate.tenantId, id],
    enabled: gate.enabled && Boolean(gate.tenantId && id),
    staleTime: 15_000,
    initialPageParam: "",
    // "" is the server's own last-page sentinel; undefined tells TanStack
    // there is nothing further, so "Load older" disappears honestly.
    getNextPageParam: (last: OutboundDeliveryPage) =>
      last.nextCursor ? last.nextCursor : undefined,
    queryFn: ({ pageParam }): Promise<OutboundDeliveryPage> => {
      if (!id) throw new Error("No webhook selected.");
      return listWebhookDeliveries(id, {
        limit: OUTBOUND_ENDPOINT_DELIVERIES_LIMIT,
        ...(pageParam ? { cursor: pageParam } : {}),
      });
    },
  });
}
