/**
 * useSubscriberEngagement — the score-explorer queries + the admin rules
 * write. All lazy on the sheet being open; the browse query re-keys on the
 * applied band so a tapped decile is its own cache entry. The PUT
 * invalidates the rules key only — scores themselves are worker-computed
 * and will not change until the next cycle (the sheet's note says so).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchScoreDistribution,
  fetchScoredSubscribers,
  fetchScoringRules,
  putScoringRules,
} from "@/api/subscribersEngagement";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  parseScoreDistribution,
  parseScoredPage,
  parseScoringRules,
  type ScoreBucketRow,
  type ScoredPage,
  type ScoringRulesView,
} from "@/lib/subscriberEngagement";

export function useScoreDistribution(enabled: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["engagement-distribution", gate.tenantId],
    enabled: enabled && gate.enabled && Boolean(gate.tenantId),
    queryFn: async (): Promise<ScoreBucketRow[]> =>
      parseScoreDistribution(await fetchScoreDistribution()),
  });
}

export interface ScoreBand {
  min: number | null;
  max: number | null;
}

export function useScoredSubscribers(
  enabled: boolean,
  band: ScoreBand,
  page: number,
) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [
      "engagement-scored",
      gate.tenantId,
      band.min,
      band.max,
      page,
    ],
    enabled: enabled && gate.enabled && Boolean(gate.tenantId),
    queryFn: async (): Promise<ScoredPage> =>
      parseScoredPage(
        await fetchScoredSubscribers({ min: band.min, max: band.max, page }),
      ),
  });
}

export function scoringRulesKey(
  tenantId: string | null | undefined,
): readonly unknown[] {
  return ["scoring-rules", tenantId ?? null];
}

export function useScoringRules(enabled: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: scoringRulesKey(gate.tenantId),
    enabled: enabled && gate.enabled && Boolean(gate.tenantId),
    queryFn: async (): Promise<ScoringRulesView> =>
      parseScoringRules(await fetchScoringRules()),
  });
}

export function useSaveScoringRules() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => putScoringRules(body),
    onSettled: () => {
      if (!tenantId) return;
      void queryClient.invalidateQueries({
        queryKey: scoringRulesKey(tenantId),
      });
    },
  });
}
