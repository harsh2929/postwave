/**
 * useSubscriberDemographics — the SUB-063 inferred-demographics read.
 * Viewer-scoped, lazy (enabled on card open), parsed in the lib sibling.
 */
import { useQuery } from "@tanstack/react-query";

import { fetchSubscriberDemographics } from "@/api/subscribersDemographics";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  parseDemographics,
  type DemographicTraitRow,
} from "@/lib/subscriberDemographics";

export function subscriberDemographicsKey(
  tenantId: string | null | undefined,
  subscriberId: string,
): readonly unknown[] {
  return ["subscriber-demographics", tenantId ?? null, subscriberId];
}

export function useSubscriberDemographics(
  subscriberId: string | undefined,
  enabled: boolean,
) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: subscriberDemographicsKey(gate.tenantId, subscriberId ?? ""),
    enabled: enabled && gate.enabled && Boolean(gate.tenantId && subscriberId),
    queryFn: async (): Promise<DemographicTraitRow[]> =>
      parseDemographics(await fetchSubscriberDemographics(subscriberId!)),
  });
}
