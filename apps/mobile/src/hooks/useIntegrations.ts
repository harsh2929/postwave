/**
 * hooks/useIntegrations.ts — Slack/Discord/Teams/webhook health on mobile.
 * The question the screen answers is "are my outbound integrations OK right
 * now?", so an operator paged at 3am can see the answer at a glance.
 *
 * The parsing lives in `lib/integrationRows` (pure, unit-tested). This file is
 * only the query wiring.
 *
 * COST NOTE (COMMERCE#37), now closed on both halves. GET
 * /api/v1/integrations/connections used to return the ENTIRE catalog — ~600
 * rows, 15 fields each — with no query parameters at all, and this hook threw
 * ~99% of it away locally. Two changes fixed it:
 *
 *   - CLIENT: staleTime/gcTime below, so a screen focus does not re-download
 *     anything within the minute.
 *   - SERVER: `filterConnections` in apps/api/internal/integrations/handlers.go
 *     now reads footprint/connected/q/category/health/status. `footprint=1` is
 *     precisely this screen's question — connected, or carrying a connection
 *     count, or reporting an error — so the wire payload is now the handful of
 *     rows the screen actually renders instead of the whole catalog.
 *
 * `summary` in the response stays whole-catalog on purpose (see the server's
 * struct doc), so nothing that reads it starts counting only the filtered page.
 *
 * `normalizeIntegrationRows` still applies the same footprint predicate
 * locally. That is not redundant belt-and-braces for its own sake: this app
 * talks to whatever API version the workspace is pinned to, and against an
 * older build the parameter is simply ignored and the full catalog comes back.
 * The screen must render the same six rows either way.
 */
import { useQuery } from "@tanstack/react-query";

import { getClient } from "@/api/client";
import { fetchIntegrationHealth } from "@/api/integrations";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { IntegrationHealth } from "@/lib/integrationHealth";
import {
  normalizeIntegrationRows,
  type Integration,
} from "@/lib/integrationRows";

export type { Integration } from "@/lib/integrationRows";
export type { IntegrationHealth } from "@/lib/integrationHealth";

/** A focus refetch of the connection inventory is not worth it more than once a minute. */
const CONNECTIONS_STALE_MS = 60_000;
const CONNECTIONS_GC_MS = 10 * 60_000;

/**
 * The server-side narrowing this screen asks for. Kept as a module constant so
 * it is part of the query identity implicitly (the URL is fixed) and so the
 * one place that has to change when the screen's question changes is here.
 */
const CONNECTIONS_QUERY = "footprint=1";

export function useIntegrations() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["integrations", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: CONNECTIONS_STALE_MS,
    gcTime: CONNECTIONS_GC_MS,
    queryFn: async (): Promise<Integration[]> => {
      const { client } = getClient();
      // The bare GET /api/v1/integrations is not a registered route (only
      // sub-paths exist), which is why this points at the aggregation route
      // GET /api/v1/integrations/connections
      // → { items: Connection[], summary, returned }.
      const res = await client.request<unknown>(
        "GET",
        `/api/v1/integrations/connections?${CONNECTIONS_QUERY}`,
      );
      return normalizeIntegrationRows(res);
    },
  });
}

/**
 * The per-connection health report, fetched only while its card is EXPANDED.
 *
 * `enabled` is what keeps this honest at list scale: an integrations tab with
 * twelve connections would otherwise fire twelve tenant-scoped queries (each
 * one opens a transaction and runs `applyRuntimeStatus` server-side) to render
 * detail nobody has asked to see. One card is open at a time, so one query is
 * in flight at a time.
 *
 * `staleTime` is deliberately much shorter than the list's: the list answers
 * "is anything broken" and tolerates a minute of lag, whereas this is opened
 * BECAUSE something is broken and the reader is about to pull-to-refresh
 * anyway.
 */
const HEALTH_STALE_MS = 15_000;

export function useIntegrationHealth(slug: string, expanded: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery<IntegrationHealth>({
    queryKey: ["integrations", "health", gate.tenantId, slug],
    enabled: gate.enabled && Boolean(gate.tenantId) && expanded && Boolean(slug),
    staleTime: HEALTH_STALE_MS,
    queryFn: () => fetchIntegrationHealth(slug),
  });
}
