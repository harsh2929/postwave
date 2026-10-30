/**
 * useListHygiene — queries and mutations behind the sunset-policy sheet
 * (api/listsHygiene.ts). The whole surface is ADMIN (see lib/listHygiene.ts
 * for why executions' viewer floor does not change that), and the sheet
 * passes `open` so the admin read fires only when the surface is actually
 * on screen.
 *
 * There is deliberately NO run mutation — the desktop anchor withholds
 * execution as draft mode (lib/listHygiene.ts header) and mobile matches.
 * Create/update stay online-only, never the offline outbox — a policy
 * definition materialising hours after it was typed would start suppressing
 * people at a moment nobody chose.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createSunsetPolicy,
  fetchSunsetExecutions,
  fetchSunsetPolicies,
  updateSunsetPolicy,
} from "@/api/listsHygiene";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { SunsetPolicyDraft } from "@/lib/listHygiene";

export function sunsetPoliciesKey(
  tenantId: string | null | undefined,
): readonly unknown[] {
  return ["sunset-policies", tenantId ?? null];
}

export function useSunsetPolicies(open: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: sunsetPoliciesKey(gate.tenantId),
    enabled: gate.enabled && Boolean(gate.tenantId) && open,
    queryFn: () => fetchSunsetPolicies(),
  });
}

export function useSunsetExecutions(policyId: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [
      ...sunsetPoliciesKey(gate.tenantId),
      "executions",
      policyId ?? null,
    ],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(policyId),
    queryFn: () => fetchSunsetExecutions(policyId!),
  });
}

export function useSaveSunsetPolicy() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, draft }: { id: string | null; draft: SunsetPolicyDraft }) =>
      id ? updateSunsetPolicy(id, draft) : createSunsetPolicy(draft),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sunsetPoliciesKey(gate.tenantId),
      });
    },
  });
}
