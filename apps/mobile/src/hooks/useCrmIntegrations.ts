/**
 * hooks/useCrmIntegrations.ts — read CRM connections and run a lifecycle verb.
 *
 * Every route in this family is admin (reviewed), so the list query is gated on the
 * role as well as the online gate: asking as a viewer would spend a request to
 * collect a guaranteed 403 and then render an empty state that reads as "you have
 * no CRM connections", which is a different and wrong claim.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { fetchCrmIntegrations, runCrmVerb } from "@/api/crmIntegrations";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { CrmIntegrationRow, CrmVerb } from "@/lib/crmLifecycle";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";

const KEY = "crm-integrations";

export function useCrmIntegrations() {
  const gate = useOnlineQueryGate();
  const mayRead = canAccessMinimumRole("admin", gate.effectiveRole);
  return useQuery({
    queryKey: [KEY, gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId) && mayRead,
    staleTime: 30_000,
    queryFn: (): Promise<CrmIntegrationRow[]> => fetchCrmIntegrations(),
  });
}

export function useRunCrmVerb() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; verb: CrmVerb }): Promise<void> =>
      runCrmVerb(input),
    onSettled: () => {
      // Refetch on success AND on failure: a 409 integration_disconnected means
      // the row moved underneath the operator, so the stale status on screen is
      // exactly what must not survive the error.
      void queryClient.invalidateQueries({ queryKey: [KEY] });
    },
  });
}
