/**
 * hooks/useCampaignTranslationsEdit.ts — author per-campaign locale variants.
 *
 * PUT/DELETE /api/v1/campaigns/{id}/translations/{locale} (editor). The PUT
 * is a FULL-ROW REPLACE, so the upsert takes the wire body pre-built by
 * lib/campaignTranslations.translationUpsertBody — a subject edit must carry
 * the existing translated bodies forward or it erases them.
 *
 * Online-only (no outbox): the replace body is built from the freshest row
 * the client holds, and replaying a queued copy hours later would overwrite
 * a body someone re-translated in the meantime — the stale-map data-loss
 * class the subscribers PATCH bug taught us.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  deleteCampaignTranslation,
  upsertCampaignTranslation,
} from "@/api/campaignTranslationsApi";
import { checkedApiResult } from "@/api/request";

export function useCampaignTranslationUpsert(campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      locale: string;
      body: { subject: string; body_html: string; body_mjml: string };
    }): Promise<void> => {
      await checkedApiResult(
        upsertCampaignTranslation(campaignId, input.locale, input.body),
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["campaign-translations"],
      });
    },
  });
}

export function useCampaignTranslationDelete(campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (locale: string): Promise<void> => {
      await checkedApiResult(deleteCampaignTranslation(campaignId, locale));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["campaign-translations"],
      });
    },
  });
}
