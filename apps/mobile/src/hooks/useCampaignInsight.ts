/**
 * hooks/useCampaignInsight.ts — one lazily-enabled read per analytics
 * drilldown on the campaign report.
 *
 * Every one of these endpoints runs a real aggregate query on the gateway, and
 * a phone opens the campaign detail screen far more often than it wants any
 * one of these breakdowns. So the query is `enabled` only while its card is
 * EXPANDED: opening a campaign costs the same as it did before, and asking
 * "which links got clicked?" costs one request.
 *
 * A deployment that does not expose a given endpoint answers 404/405/501; that
 * resolves to `null` and the card says so, rather than surfacing a red error
 * for a feature that simply isn't installed. Every other failure — auth, 5xx,
 * transport — propagates so the card offers a retry.
 */
import { useQuery } from "@tanstack/react-query";

import { getClient } from "@/api/client";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { campaignErrorStatus } from "@/lib/campaignErrors";

/** 404/405/501 = "this deployment doesn't expose it", not a failure. */
function isAbsentEndpoint(err: unknown): boolean {
  const status = campaignErrorStatus(err);
  return status === 404 || status === 405 || status === 501;
}

/**
 * The per-campaign sub-resources this hook can read. Keeping them in one map
 * means a card cannot invent a path, and the query key is derived from the
 * same token so two cards can never collide.
 */
export const CAMPAIGN_INSIGHT_PATHS = {
  links: "link-report",
  devices: "devices",
  geography: "geography",
  bounces: "bounces",
  goal: "goal-results",
  holdoutLift: "holdout/lift",
  // "How did this compare with our own last 90 days?" — the tenant's rolling
  // baseline, not a published industry average
  // (apps/api/internal/campaign_benchmarks/campaign_benchmarks.go:60).
  benchmark: "benchmark",
  // Human vs raw opens with the machine share separated out, plus the
  // AI-surfacing estimate and open-decoupled conversions
  // (apps/api/internal/analytics/engagement.go:33, viewer).
  engagement: "engagement",
  // Hour-by-hour opens/clicks/unsubs after the send
  // (apps/api/internal/analytics/campaign_timeseries.go:204, viewer).
  timeseries: "timeseries",
  // Per-locale sent/opens/clicks for a translated send
  // (apps/api/internal/campaign_translations/campaign_translations.go:135).
  localeReport: "locale-report",
} as const;

export type CampaignInsightKey = keyof typeof CAMPAIGN_INSIGHT_PATHS;

export function useCampaignInsight<T>(
  key: CampaignInsightKey,
  id: string | undefined,
  options: { enabled: boolean },
) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["campaign-insight", gate.tenantId, id, key],
    enabled: options.enabled && gate.enabled && Boolean(gate.tenantId && id),
    staleTime: 60_000,
    queryFn: async (): Promise<T | null> => {
      const { client } = getClient();
      try {
        const res = await client.request<T>(
          "GET",
          `/api/v1/campaigns/${encodeURIComponent(id!)}/${CAMPAIGN_INSIGHT_PATHS[key]}`,
        );
        return res ?? null;
      } catch (err) {
        // The holdout endpoints 404 when no holdout was ever configured,
        // which is the common case and is not an error.
        if (isAbsentEndpoint(err)) return null;
        throw err;
      }
    },
  });
}
