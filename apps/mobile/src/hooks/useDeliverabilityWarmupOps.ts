/**
 * useDeliverabilityWarmupOps — start and remove a warm-up ramp.
 *
 * A separate module from `useDeliverabilityDiagnostics` (which owns
 * list/today/pause/resume) so the existing diagnostics test factories keep
 * enumerating a stable export set. Both verbs are admin-scoped server-side
 * and ONLINE-ONLY here.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  createWarmupPlan,
  deleteWarmupPlan,
  type CreatedWarmupPlan,
} from "@/api/domainWarmupOps";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";

function useInvalidateWarmup() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({
      queryKey: ["domain-warmup", gate.tenantId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["domain-warmup-today", gate.tenantId],
    });
  };
}

export function useCreateWarmupPlan() {
  const invalidate = useInvalidateWarmup();
  return useMutation<
    CreatedWarmupPlan,
    Error,
    { domain: string; targetDaily: number; days?: number }
  >({
    mutationFn: (input) => createWarmupPlan(input),
    onSuccess: invalidate,
  });
}

export function useDeleteWarmupPlan() {
  const invalidate = useInvalidateWarmup();
  return useMutation<void, Error, string>({
    mutationFn: (domain) => deleteWarmupPlan(domain),
    onSuccess: invalidate,
  });
}
