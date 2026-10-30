/**
 * useGpcSignals — the GPC summary for the compliance screen's card.
 *
 * `GET /api/v1/consent/events` is admin-floor (routeauth manifest:
 * session_minimum_role "admin"), so the query is GATED on the role rather
 * than discovered through a 403 — the same call useSarRequests makes for
 * the banner this card sits beside. The auth MODE is consulted too: an
 * api_key session would need the literal `admin` scope, which mobile never
 * holds, and canAccessMinimumRole treats api_key as viewer.
 *
 * The summary is derived client-side over the most recent page (30-day
 * `since` bound), exactly as desktop derives its masthead numbers from the
 * same feed — and the card's copy says the scope is "loaded rows".
 */
import { useQuery } from "@tanstack/react-query";

import { fetchRecentConsentEvents } from "@/api/consentEvents";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  GPC_WINDOW_DAYS,
  summarizeGpcSignals,
  type GpcSignalSummary,
} from "@/lib/gpcSignals";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useAuthStore } from "@/store/auth";

export function gpcSignalsKey(
  tenantId: string | null | undefined,
): readonly unknown[] {
  return ["consent-events", tenantId ?? null, "gpc"];
}

export function useGpcSignals() {
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  // The role comes from the auth store, not the gate: the same
  // `session.effectiveRole` read CompliancePostureScreen gates on, so the
  // card and its host screen can never disagree about who may read.
  const role = useAuthStore((s) => s.session?.effectiveRole ?? null);
  const mayRead = canAccessMinimumRole("admin", role, mode);
  const query = useQuery<GpcSignalSummary>({
    queryKey: gpcSignalsKey(gate.tenantId),
    enabled: gate.enabled && Boolean(gate.tenantId) && mayRead,
    staleTime: 60_000,
    // A 4xx will not change on a second attempt, and the card is a
    // monitor, not a workflow — one honest failure line beats three
    // retries' worth of spinner.
    retry: false,
    queryFn: async (): Promise<GpcSignalSummary> => {
      const now = Date.now();
      const since = new Date(now - GPC_WINDOW_DAYS * 86_400_000).toISOString();
      return summarizeGpcSignals(await fetchRecentConsentEvents(since), now);
    },
  });
  return { mayRead, query };
}
