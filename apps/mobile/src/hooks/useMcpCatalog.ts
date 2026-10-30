/**
 * hooks/useMcpCatalog.ts — TanStack wiring for the tool catalogue browser.
 *
 * `wanted` is the section's expanded state. The catalogue is 289 rows the
 * monitor does not need to answer its own question, so it is not fetched
 * until the operator opens the section — the list costs nothing until asked
 * for, and the screen's pull-to-refresh does not re-read it either.
 *
 * STALENESS is an hour: the payload is a file embedded in the API binary at
 * build time (handlers.go:43-44), so it can only change with a deploy.
 */
import { useQuery } from "@tanstack/react-query";

import { fetchMcpCatalog } from "@/api/mcpCatalog";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { McpCatalogEntry } from "@/lib/mcpCatalog";

const CATALOG_STALE_MS = 3_600_000;

export function useMcpCatalog(allowed: boolean, wanted: boolean) {
  const gate = useOnlineQueryGate();
  const tenantId =
    typeof gate.tenantId === "string" && gate.tenantId ? gate.tenantId : null;
  return useQuery<McpCatalogEntry[]>({
    queryKey: ["mcp", "catalog", tenantId],
    enabled: gate.enabled && tenantId !== null && allowed && wanted,
    staleTime: CATALOG_STALE_MS,
    queryFn: fetchMcpCatalog,
  });
}
