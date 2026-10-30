/**
 * hooks/useCampaignRenderedPreview.ts — the two rendered-preview services.
 *
 *   POST /api/v1/email-preview/render — per-client HTML previews
 *        (Gmail / Outlook / Apple / Dark). Session floor ADMIN in the
 *        routeauth manifest — the sheet is only offered to admins.
 *   POST /api/v1/render — the 10-environment screenshot matrix via the
 *        deliverability proxy. ADMIN as well, and PAID + SLOW upstream, so it
 *        only ever runs from its own explicit press (mirroring desktop's
 *        CrossClientPreview), never as a side effect of opening the sheet.
 *
 * Both are mutations rather than queries on purpose: neither may prefetch,
 * and a cached rendering of a body that has since changed is worse than none.
 */
import { useMutation } from "@tanstack/react-query";

import { renderAcrossClients, renderEmailPreview } from "@/api/campaignPresend";
import { checkedApiResult } from "@/api/request";
import {
  readCrossClientRenders,
  readEmailRender,
  type CrossClientTile,
  type EmailRenderReading,
} from "@/lib/campaignRenderPreview";

/** POST /api/v1/email-preview/render — press-driven. */
export function useCampaignEmailRender() {
  return useMutation({
    mutationFn: async (input: {
      mjml: string;
      vars?: Record<string, string>;
    }): Promise<EmailRenderReading> => {
      const res = await checkedApiResult(renderEmailPreview(input));
      const reading = readEmailRender(res.data);
      if (!reading) {
        throw new Error("The preview renderer answered in an unexpected shape.");
      }
      return reading;
    },
  });
}

/** POST /api/v1/render — press-driven, paid + slow. */
export function useCampaignCrossClientRender() {
  return useMutation({
    mutationFn: async (html: string): Promise<CrossClientTile[]> => {
      const res = await checkedApiResult(renderAcrossClients(html));
      return readCrossClientRenders(res.data);
    },
  });
}
