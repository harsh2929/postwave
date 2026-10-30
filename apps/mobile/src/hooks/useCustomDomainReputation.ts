/**
 * useCustomDomainReputation — the 14-day per-domain reputation trend.
 *
 * Enabled only while the domain row is expanded, so the domains list never
 * fans out one history request per row on mount.
 */
import { useQuery } from "@tanstack/react-query";

import {
  fetchReputationHistory,
  type ReputationHistoryPoint,
} from "@/api/customDomainReputation";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";

export function useCustomDomainReputationHistory(
  domain: string,
  armed: boolean,
) {
  const gate = useOnlineQueryGate();
  const target = domain.trim().toLowerCase();
  return useQuery({
    queryKey: ["sender-reputation-history", gate.tenantId, target],
    enabled:
      armed && gate.enabled && Boolean(gate.tenantId) && target.length > 0,
    staleTime: 5 * 60_000,
    queryFn: (): Promise<ReputationHistoryPoint[]> =>
      fetchReputationHistory(target),
  });
}
