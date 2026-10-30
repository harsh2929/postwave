/**
 * hooks/useDashboardAnomalies.ts — the persisted anomaly log.
 *
 * `GET /api/v1/dashboard/anomalies?limit=N` (verified at
 * apps/api/internal/server/analytics_realtime_routes.go:49, behind
 * `read:reports`) returns rows written whenever a metric spiked past its
 * z-score threshold, newest first and unique per (tenant, metric, day).
 *
 * Worth knowing: the WRITE happens inside the dashboard-stats handler, and only
 * when it is called with `sparklines=true`. Mobile now asks for that flag (it
 * is the same flag that feeds the subscribers trend line and the bounce badge),
 * so the phone both READS this history and CONTRIBUTES to it — where before it
 * could only read what a desktop session happened to have detected. An operator
 * who gets paged sees what fired, when, and how bad without opening a laptop.
 */
import { useQuery } from "@tanstack/react-query";

import { getClient } from "@/api/client";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { parseAnomalies, type AnomalyEvent } from "@/lib/anomalies";

/** Rows worth a glance on a phone. The desk shows the full history. */
export const MOBILE_ANOMALY_LIMIT = 8;

export function dashboardAnomaliesPath(limit: number): string {
  return `/api/v1/dashboard/anomalies?limit=${limit}`;
}

export function useDashboardAnomalies(limit = MOBILE_ANOMALY_LIMIT) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["dashboard-anomalies", gate.tenantId, limit],
    enabled: gate.enabled && Boolean(gate.tenantId),
    // Detections are day-bucketed; re-reading them every 30s would tell nobody
    // anything new.
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<AnomalyEvent[]> => {
      const { client } = getClient();
      const res = await client.request<unknown>(
        "GET",
        dashboardAnomaliesPath(limit),
      );
      return parseAnomalies(res);
    },
  });
}
