/**
 * hooks/useCampaignTranslations.ts — which languages a campaign sends in.
 *
 * UNLIKE the insight reads, this one is NOT gated on a card being expanded. It
 * is a review-safety signal, and a signal that only appears once you go looking
 * for it has already failed: the reviewer who does not know translations exist
 * is exactly the reviewer who will not tap a collapsed card labelled
 * "Translations". So it loads with the screen, and the card renders nothing at
 * all for the overwhelmingly common single-language campaign.
 *
 * That is affordable because the handler is one indexed SELECT over
 * `campaign_translations` by (tenant_id, campaign_id) — no aggregate, no join —
 * and it returns at most a handful of rows.
 *
 * 404/405/501 resolves to `null`: a deployment without the translations
 * subsystem is not a failure, and the card simply stays invisible.
 */
import { useQuery } from "@tanstack/react-query";

import { getClient } from "@/api/client";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { campaignErrorStatus } from "@/lib/campaignErrors";
import type { TranslationsListWire } from "@/lib/campaignTranslations";

export function useCampaignTranslations(id: string | undefined) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["campaign-translations", gate.tenantId, id],
    enabled: gate.enabled && Boolean(gate.tenantId && id),
    staleTime: 60_000,
    queryFn: async (): Promise<TranslationsListWire | null> => {
      const { client } = getClient();
      try {
        const res = await client.request<TranslationsListWire>(
          "GET",
          `/api/v1/campaigns/${encodeURIComponent(id ?? "")}/translations`,
        );
        return res ?? null;
      } catch (err) {
        const status = campaignErrorStatus(err);
        if (status === 404 || status === 405 || status === 501) return null;
        throw err;
      }
    },
  });
}
