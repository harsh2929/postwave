/**
 * hooks/useAssuranceLegalHolds.ts — the assurance legal-hold verbs.
 *
 * Gated on `admin`, matching the manifest floor for all three routes, so a lower
 * role is never shown a panel whose every action 403s.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchAssuranceLegalHolds,
  placeAssuranceLegalHold,
  releaseAssuranceLegalHold,
} from "@/api/assuranceLegalHolds";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { AssuranceLegalHold } from "@/lib/assuranceLegalHold";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";

const KEY = "assurance-legal-holds";

export function useAssuranceLegalHolds() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [KEY, gate.tenantId],
    enabled:
      gate.enabled &&
      Boolean(gate.tenantId) &&
      canAccessMinimumRole("admin", gate.effectiveRole),
    staleTime: 30_000,
    queryFn: (): Promise<AssuranceLegalHold[]> => fetchAssuranceLegalHolds(),
  });
}

export function usePlaceAssuranceLegalHold() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { reason: string; campaignId?: string }) =>
      placeAssuranceLegalHold(input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useReleaseAssuranceLegalHold() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { holdId: string; reason: string }) =>
      releaseAssuranceLegalHold(input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [KEY] }),
  });
}
