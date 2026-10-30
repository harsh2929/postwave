/**
 * hooks/useMcpExecutionDetail.ts — TanStack wiring for the call detail sheet.
 *
 * Keyed on the row id, enabled only while a row is open. A recorded call is
 * append-only and never edited, so a fetched detail stays fresh for as long
 * as the row itself is retained; five minutes is generous without holding a
 * stale "not retained" past a pull-to-refresh of the list.
 */
import { useQuery } from "@tanstack/react-query";

import { fetchMcpExecutionDetail } from "@/api/mcpExecutionDetail";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { McpExecutionDetailEnvelope } from "@/lib/mcpExecutionDetail";

const DETAIL_STALE_MS = 300_000;

export function useMcpExecutionDetail(id: number | null, allowed: boolean) {
  const gate = useOnlineQueryGate();
  const tenantId =
    typeof gate.tenantId === "string" && gate.tenantId ? gate.tenantId : null;
  return useQuery<McpExecutionDetailEnvelope>({
    queryKey: ["mcp", "execution-detail", tenantId, id],
    enabled: gate.enabled && tenantId !== null && allowed && id !== null,
    staleTime: DETAIL_STALE_MS,
    queryFn: () => fetchMcpExecutionDetail(id ?? 0, tenantId),
  });
}
