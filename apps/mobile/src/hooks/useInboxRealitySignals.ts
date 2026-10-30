/**
 * hooks/useInboxRealitySignals.ts — the two authoritative inputs the pre-send
 * placement predictor wants, resolved through the query cache instead of
 * around it.
 *
 * The banner that consumes this re-predicts on every debounced content change.
 * Its old loader fired an uncached `Promise.all` against `/api/v1/reputation`
 * and `/api/v1/dashboard/stats` on each of those, which meant:
 *
 *  - the dashboard payload the app already holds under
 *    `["dashboard-stats", tenantId, range]` was re-fetched per keystroke burst;
 *  - neither request respected the online gate, so a cached-session device
 *    with no connectivity issued two doomed requests before every prediction;
 *  - nothing was deduped, so two mounted banners doubled the traffic.
 *
 * Both reads are now ordinary gated queries. Reputation is a slow-moving
 * domain-level fact, so it is generously stale; the dashboard query shares the
 * dashboard screen's own cache entry (`focused: false` so a send sheet never
 * starts a second 30-second poll).
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { getClient } from "@/api/client";
import {
  INBOX_REALITY_REPUTATION_PATH,
  type InboxRealityReputation,
} from "@/api/inboxReality";
import { useDashboardStatsQuery } from "@/hooks/useDashboard";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  inboxRealityHistoryFromStats,
  type InboxRealityHistory,
} from "@/lib/inboxRealityHistory";

/** Sender reputation moves on the order of days, not minutes. */
const REPUTATION_STALE_MS = 10 * 60_000;

export interface InboxRealitySignals {
  reputation: InboxRealityReputation | undefined;
  history: InboxRealityHistory | undefined;
  /**
   * True once BOTH reads have finished, whatever they found. The caller passes
   * this to `predictInboxPlacement` as `signalsResolved`, which is what stops
   * the legacy uncached loader running behind its back. Deliberately not
   * "we have data": absence is a resolved answer.
   */
  settled: boolean;
}

export function useReputation() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["reputation", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: REPUTATION_STALE_MS,
    // The predictor degrades honestly without it (see the banner's fallback
    // copy), so a missing reputation block must not become a retry storm in
    // front of a send.
    retry: false,
    queryFn: async (): Promise<InboxRealityReputation | null> => {
      const { client } = getClient();
      const res = await client.request<InboxRealityReputation | null>(
        "GET",
        INBOX_REALITY_REPUTATION_PATH,
      );
      return res ?? null;
    },
  });
}

export function useInboxRealitySignals(): InboxRealitySignals {
  const gate = useOnlineQueryGate();
  const reputation = useReputation();
  const stats = useDashboardStatsQuery({ focused: false });

  const gated = !(gate.enabled && gate.tenantId);
  // Reference stability matters more than the cost of the arithmetic: the
  // consumer keys a prediction effect on this value, and a fresh object every
  // render would re-predict on every render — the opposite of the fix.
  // `stats.data` holds its identity between renders until the query resolves
  // again, so this recomputes exactly when the payload actually changes.
  const statsData = stats.data;
  const history = useMemo(
    () => inboxRealityHistoryFromStats(statsData) ?? undefined,
    [statsData],
  );

  return {
    reputation: reputation.data ?? undefined,
    history,
    // A closed gate settles immediately: neither query will ever run, and
    // waiting on them would leave the banner spinning forever.
    settled: gated || (!reputation.isPending && !stats.isPending),
  };
}
