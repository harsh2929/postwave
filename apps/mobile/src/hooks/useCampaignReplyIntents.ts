/**
 * hooks/useCampaignReplyIntents.ts — the intent-filtered reply list.
 *
 * Desktop's CampaignRepliesSection narrows the id-bearing list with the
 * `?intent=` param (campaign_replies.go:191 reads it), and the UNFILTERED
 * response carries `intent_counts` for the chip headers. Mobile could SET
 * intent (ReplyClassifySheet) but never filter by it, so a 200-reply thread
 * hid the five questions inside it.
 *
 * Two queries, deliberately:
 *   - the unfiltered read (intent null) is the ONLY source of counts and of
 *     the "All" list — mirroring desktop, a filtered response's counts are
 *     not trusted;
 *   - a chip's read re-fetches with `&intent=`, so the narrowing is the
 *     SERVER's answer, not a client-side guess about labels.
 *
 * GET /campaigns/{id}/replies is viewer in the routeauth manifest, so the
 * chips stay available to the reviewer who cannot change anything.
 */
import { useQuery } from "@tanstack/react-query";

import { rawRequest } from "@/api/request";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { intentFilterParam, readIntentCounts } from "@/lib/campaignReplyIntents";
import {
  parseCampaignReplies,
  type CampaignReply,
  type ReplyIntent,
} from "@/lib/replyClassification";

const KEY = "campaign-replies-intent";
const LIMIT = 25;

export interface IntentFilteredReplies {
  rows: CampaignReply[];
  /** Present only on the UNFILTERED response; {} otherwise. */
  counts: Record<string, number>;
  /** The unfiltered total, or null when this was a filtered read. */
  total: number | null;
}

export function useCampaignReplyIntents(
  campaignId: string | undefined,
  intent: ReplyIntent | null,
  options: { enabled: boolean },
) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [KEY, gate.tenantId, campaignId, intent ?? "all"],
    enabled:
      options.enabled && gate.enabled && Boolean(gate.tenantId && campaignId),
    staleTime: 60_000,
    queryFn: async (): Promise<IntentFilteredReplies> => {
      const res = await rawRequest<unknown>(
        "GET",
        `/api/v1/campaigns/${encodeURIComponent(
          campaignId!,
        )}/replies?limit=${LIMIT}${intentFilterParam(intent)}`,
      );
      if (res.error) {
        throw Object.assign(new Error(res.error.message), res.error);
      }
      const body = res.data;
      const total =
        body && typeof body === "object" &&
        typeof (body as { count?: unknown }).count === "number"
          ? ((body as { count: number }).count)
          : null;
      return {
        rows: parseCampaignReplies(body),
        counts: intent === null ? readIntentCounts(body) : {},
        total: intent === null ? total : null,
      };
    },
  });
}
