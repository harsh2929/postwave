/**
 * useAudienceGrowth — `GET /api/v1/subscribers/growth?days=` (SUB-124).
 *
 * Exact UTC-calendar audience snapshots over the trailing window, written
 * by the daily snapshot worker. `days` is validated server-side (1..365)
 * and a malformed value is a 400 rather than a clamp, so the caller's
 * window is normalised here instead.
 *
 * The response carries its own honesty contract (`note`, `partial_metrics`,
 * `unavailable_metrics`); src/lib/audienceGrowth.ts owns the rules and the
 * card renders them. Do NOT chart anything listed in `unavailable_metrics`.
 */
import { useQuery } from "@tanstack/react-query";

import { getClient } from "@/api/sdkClient";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  parseAudienceGrowth,
  type AudienceGrowth,
} from "@/lib/audienceGrowth";

export const AUDIENCE_GROWTH_DEFAULT_DAYS = 30;

/** Clamp to the server's documented range so a bad window is never a 400. */
export function normalizeGrowthDays(days: number): number {
  if (!Number.isFinite(days)) return AUDIENCE_GROWTH_DEFAULT_DAYS;
  return Math.min(365, Math.max(1, Math.trunc(days)));
}

export function audienceGrowthKey(
  tenantId: string | null | undefined,
  days: number,
): readonly unknown[] {
  return ["audience-growth", tenantId ?? null, days];
}

export function useAudienceGrowth(days = AUDIENCE_GROWTH_DEFAULT_DAYS) {
  const gate = useOnlineQueryGate();
  const window = normalizeGrowthDays(days);
  return useQuery({
    queryKey: audienceGrowthKey(gate.tenantId, window),
    enabled: gate.enabled && Boolean(gate.tenantId),
    // A daily snapshot cannot change between two pull-to-refreshes; don't
    // spend a phone's radio re-fetching it on every screen focus.
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<AudienceGrowth> => {
      const { client } = getClient();
      return parseAudienceGrowth(
        await client.request<unknown>(
          "GET",
          `/api/v1/subscribers/growth?days=${window}`,
        ),
      );
    },
  });
}
