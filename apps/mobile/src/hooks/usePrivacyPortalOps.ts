/**
 * hooks/usePrivacyPortalOps.ts — query wiring for the privacy-portal panels
 * on the Compliance screen (regions matrix, consent proof, double opt-in
 * pending queue).
 *
 * GATING. Both reads take `allowed` (the screen's admin check) in addition
 * to `useOnlineQueryGate`, so a session the app already knows is not
 * owner/admin never issues a guaranteed 403 — the same idiom as
 * usePrivacyIncidents.
 *
 * INVALIDATION. The double opt-in mutations invalidate the pending queue AND
 * `["privacy-portal-posture"]` — the Settings screen's posture card renders
 * `double_optin_pending` from the same server aggregate, and cancelling a row
 * changes that number. Region mutations invalidate the overview, whose
 * payload carries the regions list.
 *
 * ALL WRITES ONLINE-ONLY — consent governance never enters the offline
 * outbox (see api/privacyPortal.ts).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  cancelDoubleOptin,
  createPrivacyRegion,
  deletePrivacyRegion,
  extendDoubleOptin,
  fetchPrivacyPortalOverview,
  listDoubleOptinPending,
  type CreatePrivacyRegionInput,
} from "@/api/privacyPortal";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  parseConsentProofSummary,
  parsePrivacyRegions,
  type ConsentProofRow,
  type PrivacyRegionRow,
} from "@/lib/privacyPortalOps";

const OVERVIEW_KEY = "privacy-portal-overview";
const PENDING_KEY = "privacy-portal-doi-pending";
/** The Settings posture card's key (PrivacyRequestsSection) — same aggregate. */
const SETTINGS_POSTURE_KEY = "privacy-portal-posture";

export interface PrivacyPortalOverview {
  regions: PrivacyRegionRow[];
  /** null = the server did not include the field (older deployment). */
  consentProof: ConsentProofRow[] | null;
}

export function usePrivacyPortalOverview(allowed: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [OVERVIEW_KEY, gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId) && allowed,
    staleTime: 60_000,
    queryFn: async (): Promise<PrivacyPortalOverview> => {
      const raw = await fetchPrivacyPortalOverview();
      return {
        regions: parsePrivacyRegions(raw),
        consentProof: parseConsentProofSummary(raw),
      };
    },
  });
}

export function useDoubleOptinPending(allowed: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [PENDING_KEY, gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId) && allowed,
    staleTime: 30_000,
    queryFn: () => listDoubleOptinPending(),
  });
}

function useDoubleOptinMutation(fn: (id: string) => Promise<void>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [PENDING_KEY] });
      void queryClient.invalidateQueries({ queryKey: [SETTINGS_POSTURE_KEY] });
    },
  });
}

export function useExtendDoubleOptin() {
  return useDoubleOptinMutation(extendDoubleOptin);
}

export function useCancelDoubleOptin() {
  return useDoubleOptinMutation(cancelDoubleOptin);
}

export function useCreatePrivacyRegion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePrivacyRegionInput) => createPrivacyRegion(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [OVERVIEW_KEY] });
      void queryClient.invalidateQueries({ queryKey: [SETTINGS_POSTURE_KEY] });
    },
  });
}

export function useDeletePrivacyRegion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deletePrivacyRegion(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [OVERVIEW_KEY] });
      void queryClient.invalidateQueries({ queryKey: [SETTINGS_POSTURE_KEY] });
    },
  });
}
