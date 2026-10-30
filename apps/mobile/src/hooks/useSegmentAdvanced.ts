/**
 * useSegmentAdvanced — queries behind the segment-detail evidence panels.
 * Each card passes `open` so a collapsed panel costs nothing; keys nest
 * under the `segmentsKey` root like every other segment read.
 *
 * The snapshot WRITE invalidates only its own snapshots key — a new
 * snapshot changes nothing about the catalogue, the rule, or the size
 * history, and invalidating the whole root would refetch four screens to
 * answer one card.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createSegmentSnapshot,
  fetchSegmentDefinitionHistory,
  fetchSegmentGrowthReport,
  fetchSegmentSnapshots,
  fetchSegmentUsage,
} from "@/api/segmentsAdvanced";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { segmentsKey } from "@/hooks/useSegments";

function detailKey(
  tenantId: string | null | undefined,
  id: string | undefined,
  leaf: string,
): readonly unknown[] {
  return [...segmentsKey(tenantId), "detail", id ?? null, leaf];
}

export function useSegmentSnapshots(id: string | undefined, open: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: detailKey(gate.tenantId, id, "snapshots"),
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(id) && open,
    queryFn: () => fetchSegmentSnapshots(id!),
  });
}

export function useCreateSegmentSnapshot(id: string | undefined) {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => createSegmentSnapshot(id!),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: detailKey(gate.tenantId, id, "snapshots"),
      });
    },
  });
}

export function useSegmentDefinitionHistory(
  id: string | undefined,
  open: boolean,
) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: detailKey(gate.tenantId, id, "definition-history"),
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(id) && open,
    queryFn: () => fetchSegmentDefinitionHistory(id!),
  });
}

export function useSegmentUsage(id: string | undefined, open: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: detailKey(gate.tenantId, id, "usage"),
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(id) && open,
    queryFn: () => fetchSegmentUsage(id!),
  });
}

export function useSegmentGrowthReport(
  id: string | undefined,
  open: boolean,
  days = 30,
) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: detailKey(gate.tenantId, id, `growth-report-${days}`),
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(id) && open,
    queryFn: () => fetchSegmentGrowthReport(id!, days),
  });
}
