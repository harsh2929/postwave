/**
 * useSegmentCompare — the reads behind the compare sheet. Keys are sorted so
 * "A vs B" and "B vs A" share a cache entry (the server's answer is
 * symmetric), and both queries stay disabled until the selection satisfies
 * the server's own bounds (lib/segmentCompareRows.compareSelection) so an
 * invalid selection can never fire a guaranteed 400.
 */
import { useQuery } from "@tanstack/react-query";

import { fetchSegmentOverlap, fetchSegmentPnlCompare } from "@/api/segmentsCompare";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { segmentsKey } from "@/hooks/useSegments";
import { compareSelection } from "@/lib/segmentCompareRows";

export function useSegmentOverlap(ids: readonly string[]) {
  const gate = useOnlineQueryGate();
  const sorted = [...new Set(ids)].sort();
  const ready = compareSelection(sorted).canOverlap;
  return useQuery({
    queryKey: [...segmentsKey(gate.tenantId), "overlap", ...sorted],
    enabled: gate.enabled && Boolean(gate.tenantId) && ready,
    queryFn: () => fetchSegmentOverlap(sorted[0]!, sorted[1]!),
  });
}

export function useSegmentPnlCompare(ids: readonly string[], days = 30) {
  const gate = useOnlineQueryGate();
  const sorted = [...new Set(ids)].sort();
  const ready = compareSelection(sorted).canCompare;
  return useQuery({
    queryKey: [...segmentsKey(gate.tenantId), "pnl-compare", days, ...sorted],
    enabled: gate.enabled && Boolean(gate.tenantId) && ready,
    queryFn: () => fetchSegmentPnlCompare(sorted, days),
  });
}
