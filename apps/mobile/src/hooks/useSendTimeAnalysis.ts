/**
 * hooks/useSendTimeAnalysis.ts — the send-time heatmap query.
 *
 * ADMIN, AND THE HOOK REFUSES TO FIRE BELOW IT. `GET
 * /api/v1/send-time-opt/best-time-analysis` sits behind
 * `RequireScope(ScopeReadReports, ScopeAdmin)`, and on the session path the
 * presence of `ScopeAdmin` in that list forces `sessionRoleAllowsScopes` to
 * demand owner/admin — see the header of `api/sendTimeAnalysis.ts` for the
 * middleware walk. Firing anyway below admin would be a guaranteed 403 on every
 * screen open, so `enabled` carries the role check and the screen renders an
 * honest locked state instead. `useSubscriberBestSendTime` gates the sibling
 * per-subscriber route the same way and for the same reason.
 *
 * `mode === "api_key"` fails `canAccessMinimumRole("admin", …)` by construction
 * — an API-key session carries no role claim. A key holding `read:reports`
 * WOULD in fact be admitted by the server, so this is a false negative we take
 * on purpose rather than inventing a role for a principal that has none.
 *
 * THE CADENCE. The counts behind the grid come from `campaign_report_events`
 * over a 30-to-180-day window, and the `subscriber_signal` half is written by
 * the STO compute worker (main.go:3212) on its own schedule. Nothing about that
 * moves inside a minute, and the query aggregates the whole window on every
 * call — 168 groups over months of events — so this is deliberately one of the
 * app's longest stale windows. Pull-to-refresh remains the escape hatch.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { fetchSendTimeAnalysis } from "@/api/sendTimeAnalysis";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import {
  DEFAULT_SEND_TIME_LOOKBACK,
  type SendTimeAnalysis,
  type SendTimeLookback,
} from "@/lib/sendTimeAnalysis";
import { useAuthStore } from "@/store/auth";

const SEND_TIME_ANALYSIS_KEY = "send-time-analysis";

/** Fifteen minutes: the underlying aggregation cannot meaningfully move faster. */
const SEND_TIME_ANALYSIS_STALE_MS = 15 * 60 * 1000;

export function sendTimeAnalysisQueryKey(
  tenantId: string | null | undefined,
  days: number,
): readonly unknown[] {
  return [SEND_TIME_ANALYSIS_KEY, tenantId ?? null, days];
}

/** Exposed so the screen can render a locked state without restating policy. */
export function useCanReadSendTimeAnalysis(): boolean {
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  return canAccessMinimumRole("admin", gate.effectiveRole, mode);
}

export function useSendTimeAnalysis(
  days: SendTimeLookback = DEFAULT_SEND_TIME_LOOKBACK,
): UseQueryResult<SendTimeAnalysis> {
  const gate = useOnlineQueryGate();
  const allowed = useCanReadSendTimeAnalysis();
  return useQuery({
    queryKey: sendTimeAnalysisQueryKey(gate.tenantId, days),
    enabled: gate.enabled && Boolean(gate.tenantId) && allowed,
    staleTime: SEND_TIME_ANALYSIS_STALE_MS,
    queryFn: (): Promise<SendTimeAnalysis> => fetchSendTimeAnalysis(days),
  });
}
