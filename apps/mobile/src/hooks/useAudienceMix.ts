/**
 * useAudienceMix — the workspace audience rollup, read on demand.
 *
 * COST IS WHY THIS IS A HOOK AND NOT A SECTION-LEVEL QUERY. The rollup is
 * `campaigns × 3` aggregate queries on the gateway (five campaigns = fifteen
 * requests), so it must never run because someone scrolled past. The section
 * mounts this hook only once the reader has asked for it, which is also why
 * the campaigns list read lives in here rather than at the screen level.
 *
 * The query key carries the campaign ids, not just the tenant: if a new
 * campaign sends while the screen is open, the rollup is a different question
 * and must not answer from the previous set's cache.
 */
import { useQuery } from "@tanstack/react-query";

import { fetchAudienceMix } from "@/api/audienceMix";
import { useCampaignsList } from "@/hooks/useCampaigns";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  audienceMixSources,
  buildAudienceMix,
  type AudienceMixView,
} from "@/lib/audienceMix";

export interface AudienceMixQuery {
  view: AudienceMixView | undefined;
  loading: boolean;
  error: unknown;
  refetch: () => void;
  /** Campaigns actually read (sent, capped) and rows the list returned. */
  campaignsUsed: number;
  campaignsListed: number;
  /** The list itself failed — the rollup has no campaigns to read. */
  listError: unknown;
}

export function useAudienceMix(): AudienceMixQuery {
  const gate = useOnlineQueryGate();
  const campaigns = useCampaignsList();
  const listed = Array.isArray(campaigns.data) ? campaigns.data : [];
  const ids = audienceMixSources(listed).map((campaign) => campaign.id);
  const query = useQuery({
    queryKey: ["audience-mix", gate.tenantId, ids.join("|")],
    enabled: gate.enabled && Boolean(gate.tenantId) && ids.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<AudienceMixView> =>
      buildAudienceMix(await fetchAudienceMix(ids)),
  });
  return {
    view: query.data,
    loading: campaigns.isLoading || (ids.length > 0 && query.isLoading),
    error: query.error,
    refetch: () => {
      void campaigns.refetch();
      void query.refetch();
    },
    campaignsUsed: ids.length,
    campaignsListed: listed.length,
    listError: campaigns.error,
  };
}
