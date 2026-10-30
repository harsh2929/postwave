/**
 * hooks/useCampaignCounts.ts — the real, workspace-wide per-status counts
 * behind the campaign list's filter chips.
 *
 * The chips previously counted only the pages fetched so far, so a workspace
 * with 900 campaigns showed "Draft 100 / Scheduled 0 / Sent 0" on first paint
 * — next to a header reading "more available" — and the numbers grew as you
 * scrolled. GET /api/v1/campaigns/count answers this exactly, in a single
 * GROUP BY (Repo.CountFiltered), honouring the SAME name/subject ILIKE filter
 * the list uses. Callers fall back to the page-local count when it errors.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { getClient } from "@/api/client";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  bucketCounts,
  type CampaignStatusCounts,
} from "@/lib/campaignStatusFilter";

/** Wire shape of GET /api/v1/campaigns/count (Go: CountByStatus). */
export interface CampaignCountResponse {
  total?: number;
  by_status?: Record<string, number>;
}

/**
 * Workspace-wide per-status counts, honouring the SAME name/subject ILIKE
 * filter the list uses (Repo.CountFiltered — a single GROUP BY).
 *
 * The chips previously counted only the pages fetched so far, so a workspace
 * with 900 campaigns showed "Draft 100 / Scheduled 0 / Sent 0" on first paint
 * next to a header saying "more available", and the numbers grew as you
 * scrolled. Callers fall back to the page-local count when this errors.
 */
export function useCampaignCounts(query: string) {
  const gate = useOnlineQueryGate();
  const normalizedQuery = query.trim();
  return useQuery({
    queryKey: ["campaign-counts", gate.tenantId, normalizedQuery],
    enabled: gate.enabled && Boolean(gate.tenantId),
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<CampaignStatusCounts> => {
      const { client } = getClient();
      const res = await client.request<CampaignCountResponse>(
        "GET",
        "/api/v1/campaigns/count",
        normalizedQuery ? { query: { query: normalizedQuery } } : {},
      );
      return bucketCounts(res?.by_status, res?.total);
    },
  });
}
