/**
 * hooks/useMcpQuotas.ts — TanStack wiring for the per-tool quota card.
 *
 * Same two gates as hooks/useMcpActivity: the online/auth gate decides
 * whether a request can run at all, and `allowed` carries the owner/admin
 * decision so a viewer never spends a round trip to be told 403.
 *
 * STALENESS matches the stats aggregate (30s): `usedToday` is a live count
 * since UTC midnight, and an operator checking whether an agent is about to
 * hit its cap wants the number to move on pull-to-refresh. No polling, for
 * the reason the monitor gives — a quota is a thing you go and check.
 */
import { useQuery } from "@tanstack/react-query";

import { fetchMcpQuotas } from "@/api/mcpQuotas";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { McpQuotaSnapshot } from "@/lib/mcpQuotas";

const QUOTAS_STALE_MS = 30_000;

export function useMcpQuotas(allowed: boolean) {
  const gate = useOnlineQueryGate();
  const tenantId =
    typeof gate.tenantId === "string" && gate.tenantId ? gate.tenantId : null;
  return useQuery<McpQuotaSnapshot>({
    queryKey: ["mcp", "quotas", tenantId],
    enabled: gate.enabled && tenantId !== null && allowed,
    staleTime: QUOTAS_STALE_MS,
    queryFn: () => fetchMcpQuotas(tenantId),
  });
}
