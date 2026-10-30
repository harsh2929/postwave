/**
 * hooks/useComplianceEvidence.ts — the Compliance screen's two evidence
 * reads: retention-sweep activity and the Article 50 agent-activity window.
 *
 * Both take `allowed` (the screen's admin check) on top of the online gate —
 * the routes themselves are viewer-floored, but they render on an
 * admin-floored screen, and issuing reads for a screen the session cannot
 * see wastes a cellular round trip.
 */
import { useQuery } from "@tanstack/react-query";

import {
  fetchAgentAuditStats,
  fetchRetentionActivity,
} from "@/api/complianceEvidence";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { normalizeAuditStats } from "@/lib/auditStats";
import {
  agentEventCount,
  ARTICLE50_WINDOW_DAYS,
} from "@/lib/complianceEvidence";

export function useRetentionActivity(allowed: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["retention-activity", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId) && allowed,
    staleTime: 5 * 60_000,
    queryFn: () => fetchRetentionActivity(),
  });
}

/**
 * Agent-actor event count over the Article 50 window. Returns null (not an
 * error) when the stats endpoint is absent or refuses — the readiness card
 * then says the count is unavailable rather than failing the whole panel.
 */
export function useAgentEventWindow(allowed: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["article50-agent-window", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId) && allowed,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async (): Promise<number | null> => {
      const since = new Date(
        Date.now() - ARTICLE50_WINDOW_DAYS * 86_400_000,
      ).toISOString();
      try {
        const raw = await fetchAgentAuditStats(since);
        return agentEventCount(normalizeAuditStats(raw));
      } catch {
        return null;
      }
    },
  });
}
