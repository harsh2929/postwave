/**
 * hooks/useOnsiteGrowth.ts — one form's onsite-growth reads, and the one
 * write the phone offers on them (the targeting status toggle).
 *
 * All three reads are read:campaigns (viewer-visible on the session path) and
 * side-effect-free, so they fetch when the section mounts. The PUT is the
 * ADMIN-floor full-replace — its body must come from
 * `buildTargetingStatusPut`, and it is ONLINE-ONLY: it changes what site
 * visitors see, and it is not on the offline-queue allowlist.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchOnsiteExperiments,
  fetchOnsiteSpinRewards,
  fetchOnsiteTargeting,
  putOnsiteTargeting,
} from "@/api/onsiteGrowth";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isProbablyOnline } from "@/lib/connectivity";
import type {
  OnsiteExperimentSummary,
  OnsiteSpinRewardSummary,
  OnsiteTargeting,
} from "@/lib/onsiteGrowth";

const STALE_MS = 60_000;

export function useOnsiteTargeting(formId: string | undefined) {
  const gate = useOnlineQueryGate();
  return useQuery<OnsiteTargeting | null>({
    queryKey: ["onsite-growth", "targeting", gate.tenantId, formId ?? ""],
    enabled: gate.enabled && Boolean(gate.tenantId && formId),
    staleTime: STALE_MS,
    queryFn: (): Promise<OnsiteTargeting | null> =>
      fetchOnsiteTargeting(formId ?? ""),
  });
}

export function useOnsiteExperiments(formId: string | undefined) {
  const gate = useOnlineQueryGate();
  return useQuery<OnsiteExperimentSummary[]>({
    queryKey: ["onsite-growth", "experiments", gate.tenantId, formId ?? ""],
    enabled: gate.enabled && Boolean(gate.tenantId && formId),
    staleTime: STALE_MS,
    queryFn: (): Promise<OnsiteExperimentSummary[]> =>
      fetchOnsiteExperiments(formId ?? ""),
  });
}

export function useOnsiteSpinRewards(formId: string | undefined) {
  const gate = useOnlineQueryGate();
  return useQuery<OnsiteSpinRewardSummary[]>({
    queryKey: ["onsite-growth", "spin", gate.tenantId, formId ?? ""],
    enabled: gate.enabled && Boolean(gate.tenantId && formId),
    staleTime: STALE_MS,
    queryFn: (): Promise<OnsiteSpinRewardSummary[]> =>
      fetchOnsiteSpinRewards(formId ?? ""),
  });
}

/** Mirrors FormsOfflineError: an honest refusal at the moment of the tap. */
export class OnsiteOfflineError extends Error {
  readonly code = "offline_write_refused";

  constructor() {
    super(
      "Changing what site visitors see needs a connection. Reconnect and try again.",
    );
    this.name = "OnsiteOfflineError";
  }
}

export function usePutOnsiteTargeting() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: async (input: {
      formId: string;
      body: Record<string, unknown>;
    }) => {
      if (!isProbablyOnline()) throw new OnsiteOfflineError();
      return putOnsiteTargeting(input.formId, input.body);
    },
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({
        queryKey: ["onsite-growth", "targeting", tenantId, input.formId],
      });
    },
  });
}
