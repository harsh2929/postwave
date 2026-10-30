/**
 * hooks/useConversionAttribution.ts — TanStack wiring for the conversion
 * monitor.
 *
 * Every judgement lives in `lib/conversionAttribution` and
 * `lib/attributionVerdict` (pure, node-tested); this file is only the query
 * layer.
 *
 * ONE GATE, NOT TWO — AND THAT IS DELIBERATE. Unlike the agent-activity
 * monitor, both attribution routes are viewer-tier on BOTH guards (see the
 * note at the top of api/conversionAttribution.ts), so there is no role to
 * pre-empt and no `allowed` parameter here. Adding one would have meant
 * inventing a restriction the server does not impose, which is the same class
 * of error as ignoring one it does. A live 403 is still handled at the screen,
 * because a session's own scopes can narrow while the app is open.
 *
 * `useOnlineQueryGate` remains, and it matters: offline a query never runs,
 * which in TanStack v5 is status "pending" with fetchStatus "idle" —
 * `isLoading` FALSE and `isError` FALSE — so a screen falling through to "no
 * conversions" would be claiming the tracking script is dead when the phone
 * simply has no signal.
 *
 * STALENESS. Conversion aggregates are recomputed per request over a window
 * measured in days; a 60-second window is already far finer than the data
 * moves, and anything shorter just spends radio on identical bytes.
 */
import { useQuery } from "@tanstack/react-query";

import {
  fetchAttributionTimeseries,
  fetchCampaignAttribution,
} from "@/api/conversionAttribution";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type {
  AttributionTimeseries,
  AttributionWindow,
  CampaignAttribution,
} from "@/lib/conversionAttribution";

export type {
  AttributionTimeseries,
  AttributionWindow,
  CampaignAttribution,
} from "@/lib/conversionAttribution";

const ATTRIBUTION_STALE_MS = 60_000;

export function useCampaignAttribution(days: AttributionWindow) {
  const gate = useOnlineQueryGate();
  return useQuery<CampaignAttribution>({
    queryKey: ["conversions", "attribution", gate.tenantId, days],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: ATTRIBUTION_STALE_MS,
    queryFn: () => fetchCampaignAttribution(days),
  });
}

export function useAttributionTimeseries(days: AttributionWindow) {
  const gate = useOnlineQueryGate();
  return useQuery<AttributionTimeseries>({
    queryKey: ["conversions", "timeseries", gate.tenantId, days],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: ATTRIBUTION_STALE_MS,
    queryFn: () => fetchAttributionTimeseries(days),
  });
}
