/**
 * hooks/useSendTimeSegmentHeatmap.ts — one segment's send-time week.
 *
 * SAME FLOOR AS THE SCREEN'S MAIN READ, AND FOR THE SAME REASON.
 * `/send-time-opt/heatmap` is mounted alongside `/best-time-analysis` behind
 * `RequireScope(ScopeReadReports, ScopeAdmin)`, so on the session path it
 * demands owner/admin (see api/sendTimeSegmentHeatmap.ts for the walk and for
 * the manifest row that understates it). `useCanReadSendTimeAnalysis` already
 * encodes that policy; reusing it keeps ONE statement of the rule rather than a
 * second copy free to drift.
 *
 * `null` segment = no scope chosen, and the query simply does not fire. The
 * screen's tenant-wide grid IS the unscoped answer; there is nothing to ask for.
 *
 * FIFTEEN MINUTES, LIKE ITS SIBLING. The pattern is rebuilt from up to 180 days
 * of `subscriber_events` across up to 2,000 subscribers on every call
 * (dow_pattern.go:227-296) — the most expensive read on this screen and one
 * whose answer cannot meaningfully move inside a quarter of an hour.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import {
  fetchSegmentSendTimeHeatmap,
  type SegmentHeatmapOutcome,
} from "@/api/sendTimeSegmentHeatmap";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useCanReadSendTimeAnalysis } from "@/hooks/useSendTimeAnalysis";

const SEGMENT_HEATMAP_KEY = "send-time-segment-heatmap";

const SEGMENT_HEATMAP_STALE_MS = 15 * 60 * 1000;

export function segmentSendTimeHeatmapQueryKey(
  tenantId: string | null | undefined,
  segmentId: string | null,
): readonly unknown[] {
  return [SEGMENT_HEATMAP_KEY, tenantId ?? null, segmentId ?? null];
}

export function useSendTimeSegmentHeatmap(
  segmentId: string | null,
): UseQueryResult<SegmentHeatmapOutcome> {
  const gate = useOnlineQueryGate();
  const allowed = useCanReadSendTimeAnalysis();
  return useQuery({
    queryKey: segmentSendTimeHeatmapQueryKey(gate.tenantId, segmentId),
    enabled:
      gate.enabled && Boolean(gate.tenantId) && allowed && Boolean(segmentId),
    staleTime: SEGMENT_HEATMAP_STALE_MS,
    queryFn: (): Promise<SegmentHeatmapOutcome> =>
      fetchSegmentSendTimeHeatmap(segmentId!),
  });
}
