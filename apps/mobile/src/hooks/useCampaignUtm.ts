/**
 * hooks/useCampaignUtm.ts — the campaign's link tagging, read and previewed.
 *
 * The list read is lazy (`enabled` follows the card's disclosure) so the
 * detail screen costs exactly what it did before this card existed, matching
 * every other insight card on that screen.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  deleteUtmTemplate,
  listUtmTemplates,
  previewUtmLink,
  upsertCampaignUtm,
  upsertDefaultUtm,
  type UtmPreview,
} from "@/api/campaignUtm";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { utmOverrideBody, type UtmTemplate } from "@/lib/campaignUtm";

export function useUtmTemplates(enabled: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery<UtmTemplate[]>({
    queryKey: ["utm-templates", gate.tenantId],
    enabled: enabled && gate.enabled && Boolean(gate.tenantId),
    queryFn: listUtmTemplates,
  });
}

/** POST /api/v1/utm-templates/preview — read scope, so a viewer may use it. */
export function useUtmPreview(campaignId: string) {
  return useMutation<UtmPreview, unknown, string>({
    mutationFn: (url: string) => previewUtmLink(url, campaignId),
  });
}

/**
 * Copy the workspace default down onto this campaign as its own override.
 *
 * This is the closest true thing to "apply the saved template": the upsert
 * route takes the five VALUES, never a template id. Admin-only — see the
 * scope note in api/campaignUtm.ts.
 */
export function useApplyDefaultUtm(campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (fallback: UtmTemplate) =>
      upsertCampaignUtm(campaignId, utmOverrideBody(fallback)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["utm-templates"] });
    },
  });
}

/**
 * Save five values as the WORKSPACE default (POST /utm-templates,
 * UpsertDefault). Admin-only at the mount — the card renders this for
 * canAdmin sessions only. Online-only: the default governs how EVERY future
 * campaign's links are attributed, and a queued stale copy replayed later
 * would silently re-point workspace-wide attribution.
 */
export function useSaveDefaultUtm() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (values: UtmTemplate) =>
      upsertDefaultUtm(utmOverrideBody(values)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["utm-templates"] });
    },
  });
}

/** Remove one template row (DELETE /utm-templates/{id}). Admin-only. */
export function useDeleteUtmTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteUtmTemplate(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["utm-templates"] });
    },
  });
}
