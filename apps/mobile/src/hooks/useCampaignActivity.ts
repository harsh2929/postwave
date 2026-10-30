/**
 * hooks/useCampaignActivity.ts — this campaign's audit trail.
 *
 * GET /api/v1/audit accepts BOTH `resource_type` and `resource_id`
 * (apps/api/internal/handlers/audit.go:117-118 → SQL params $6 and $10), and
 * every mutating campaign route writes a row with resource_type "campaign".
 * The detail screen never asked, so "who rescheduled this, and when?" — a
 * question asked far more often on a phone than at a desk — had no answer.
 *
 * NOT routed through useAudit(): that hook's filters are actor/since only and
 * its first page is snapshot-backed under a shared vault key, which a
 * per-campaign query must not overwrite.
 *
 * Lazily enabled: the audit read is not free, and the card is collapsed until
 * asked for.
 */
import { useQuery } from "@tanstack/react-query";

import { getClient } from "@/api/client";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  campaignActivityQueryKey,
  readCampaignActivity,
  type CampaignActivityRow,
} from "@/lib/campaignActivity";

/** Rows to request. The card shows a bounded recent history, not a log. */
const ACTIVITY_LIMIT = 20;

export function useCampaignActivity(
  id: string | undefined,
  options: { enabled: boolean },
) {
  const gate = useOnlineQueryGate();
  return useQuery({
    // Keyed under the "audit" root ON PURPOSE: that root is what the
    // event-bus invalidator dirties on audit.created, which is how this card
    // updates live while open — see campaignActivityQueryKey.
    queryKey: campaignActivityQueryKey(gate.tenantId, id),
    enabled: options.enabled && gate.enabled && Boolean(gate.tenantId && id),
    staleTime: 30_000,
    queryFn: async (): Promise<CampaignActivityRow[]> => {
      const { client } = getClient();
      const res = await client.request<unknown>("GET", "/api/v1/audit", {
        query: {
          limit: ACTIVITY_LIMIT,
          resource_type: "campaign",
          resource_id: id!,
        },
      });
      return readCampaignActivity(res, ACTIVITY_LIMIT);
    },
  });
}
