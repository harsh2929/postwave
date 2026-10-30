/**
 * hooks/useProductEvents.ts — TanStack wiring for the product-event catalogue.
 *
 * All parsing lives in `lib/productEvents` and all policy in
 * `lib/productEventHealth`, both pure and node-tested; this file is only the
 * query layer.
 *
 * OFFLINE. Every query sits behind `useOnlineQueryGate`, so offline they never
 * run — which in TanStack v5 is status "pending" with fetchStatus "idle", i.e.
 * `isLoading` FALSE and `isError` FALSE. A screen that fell through that to an
 * empty list would be claiming this workspace receives no product events, which
 * is exactly the claim a monitor must never invent. `QueryStates` owns the
 * offline branch.
 *
 * STALENESS. Deliberately short and IDENTICAL across the three queries. The
 * strip, the catalogue and a row's raw sample are three zoom levels on one
 * question, and giving them different windows is how "seen 4 minutes ago" ends
 * up above a row that says the event has been silent for a week. There is no
 * `refetchInterval`: this surface is read at the moment somebody asks whether
 * ingest is alive, and a background poll on a cellular connection buys nothing
 * a pull-to-refresh does not.
 */
import { useQuery } from "@tanstack/react-query";

import {
  fetchProductEventCatalog,
  fetchProductEventSample,
  fetchProductEventStats,
} from "@/api/productEvents";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type {
  ProductEventCatalog,
  ProductEventSample,
  ProductEventStats,
} from "@/lib/productEvents";

export type {
  ProductEventCatalog,
  ProductEventCatalogRow,
  ProductEventLine,
  ProductEventSample,
  ProductEventStats,
} from "@/lib/productEvents";

const PRODUCT_EVENTS_STALE_MS = 30_000;

export function useProductEventStats(days: number) {
  const gate = useOnlineQueryGate();
  return useQuery<ProductEventStats>({
    queryKey: ["product-events", "stats", gate.tenantId, days],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: PRODUCT_EVENTS_STALE_MS,
    queryFn: () => fetchProductEventStats(days),
  });
}

/**
 * The catalogue for one window.
 *
 * `days` is part of the key rather than a refetch parameter, so switching the
 * window back to one already read re-uses that payload instead of paying for it
 * twice — and, more importantly, so the `asOf` every age on screen is measured
 * against always belongs to the payload being rendered.
 */
export function useProductEventCatalog(days: number) {
  const gate = useOnlineQueryGate();
  return useQuery<ProductEventCatalog>({
    queryKey: ["product-events", "catalog", gate.tenantId, days],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: PRODUCT_EVENTS_STALE_MS,
    queryFn: () => fetchProductEventCatalog(days),
  });
}

/**
 * The newest raw rows for ONE event name — fetched only once a row is opened.
 *
 * `enabled` carries the name, so nothing is requested while the list is merely
 * scrolled. This is the one query on the surface that needs `read:subscribers`
 * as well as `read:reports` (track/handlers.go:92), which is why it is a
 * separate query with its own error surface rather than part of the catalogue:
 * an API-key session that cannot read subscribers still gets the whole
 * catalogue, and loses only the drill-down.
 */
export function useProductEventSample(eventName: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery<ProductEventSample>({
    queryKey: ["product-events", "sample", gate.tenantId, eventName],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(eventName),
    staleTime: PRODUCT_EVENTS_STALE_MS,
    queryFn: () => fetchProductEventSample(String(eventName)),
  });
}
