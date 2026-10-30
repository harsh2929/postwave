/**
 * Hooks for the mobile list detail screen: paginated members, the growth
 * series, and the server-computed health grade.
 *
 * Every query goes through `useOnlineQueryGate` — a restored-from-disk
 * session that has not been re-validated online must not fire requests,
 * and the screen renders a reconnect notice instead of a fake empty list.
 */
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import {
  fetchListDeliverability,
  fetchListGrowth,
  fetchListMembers,
  type ListGrowth,
  type ListMembersPage,
} from "@/api/listDetail";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { listCatalogueKey } from "@/hooks/useListOptions";
import { normalizeListHealth, type ListHealthSummary } from "@/lib/listHealth";
import { getClient } from "@/api/sdkClient";
import {
  parseGrowthSources,
  type GrowthSourceMix,
} from "@/lib/listGrowthSources";

/** Key prefix for everything scoped to one list. */
export function listDetailKey(
  tenantId: string | null | undefined,
  listId: string | undefined,
): readonly unknown[] {
  return [...listCatalogueKey(tenantId), "detail", listId ?? null];
}

export function useListMembers(listId: string | undefined, query: string) {
  const gate = useOnlineQueryGate();
  return useInfiniteQuery({
    queryKey: [...listDetailKey(gate.tenantId, listId), "members", query],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(listId),
    initialPageParam: 1,
    queryFn: ({ pageParam }): Promise<ListMembersPage> =>
      fetchListMembers(listId!, pageParam, query),
    getNextPageParam: (last, all) => {
      // Same termination guard the subscribers list uses: an empty page
      // stops paging even when a stale `total` still claims more rows,
      // otherwise every scroll-to-end re-requests the same empty page.
      if (last.items.length === 0) return undefined;
      const seen = all.reduce((n, p) => n + p.items.length, 0);
      return seen < last.total ? all.length + 1 : undefined;
    },
  });
}

export function useListGrowth(listId: string | undefined, windowDays = 30) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [...listDetailKey(gate.tenantId, listId), "growth", windowDays],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(listId),
    queryFn: (): Promise<ListGrowth> => fetchListGrowth(listId!, windowDays),
  });
}

export function useListHealth(listId: string | undefined, windowDays = 30) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [...listDetailKey(gate.tenantId, listId), "health", windowDays],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(listId),
    queryFn: async (): Promise<ListHealthSummary> =>
      normalizeListHealth(await fetchListDeliverability(listId!, windowDays)),
  });
}

/**
 * Where the people on this list came from.
 *
 * GET /api/v1/lists/{id}/growth-sources, RequireScope(ScopeReadSubscribers)
 * — a read-only scope, so every authenticated role may see it. The parser
 * preserves the server's `fallback: "live_count"` flag, which marks a
 * DIFFERENT measurement (current membership rather than cumulative
 * acquisition); see lib/listGrowthSources.ts.
 */
export function useListGrowthSources(listId: string | undefined) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [...listDetailKey(gate.tenantId, listId), "growth-sources"],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(listId),
    queryFn: async (): Promise<GrowthSourceMix> => {
      const { client } = getClient();
      return parseGrowthSources(
        await client.request<unknown>(
          "GET",
          `/api/v1/lists/${encodeURIComponent(listId!)}/growth-sources`,
        ),
      );
    },
  });
}
