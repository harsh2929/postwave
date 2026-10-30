/**
 * Segment queries. Gated on `useOnlineQueryGate` like every other read, so
 * a restored-but-unvalidated session shows a reconnect notice rather than a
 * confident "no segments".
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchSegment,
  fetchSegments,
  fetchSegmentSizeHistory,
  recomputeSegment,
  type MobileSegment,
  type SegmentSizeHistory,
} from "@/api/segments";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";

export function segmentsKey(
  tenantId: string | null | undefined,
): readonly unknown[] {
  return ["segments", tenantId ?? null];
}

export function useSegments() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: segmentsKey(gate.tenantId),
    enabled: gate.enabled && Boolean(gate.tenantId),
    queryFn: (): Promise<MobileSegment[]> => fetchSegments(),
  });
}

export function useSegment(id: string | undefined) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [...segmentsKey(gate.tenantId), "detail", id ?? null],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(id),
    queryFn: (): Promise<MobileSegment | null> => fetchSegment(id!),
  });
}

export function useSegmentSizeHistory(id: string | undefined, windowDays = 90) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [...segmentsKey(gate.tenantId), "size-history", id ?? null, windowDays],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(id),
    queryFn: (): Promise<SegmentSizeHistory> =>
      fetchSegmentSizeHistory(id!, windowDays),
  });
}

/**
 * Refresh a segment's stored size.
 *
 * ONLINE-ONLY AND NEVER QUEUED. A queued recompute is a promise that the
 * number on screen is about to become true, and the whole point of the control
 * is that the number on screen is currently NOT true. Failing honestly beats
 * a count that silently refreshes at some later moment nobody saw.
 *
 * The response carries the new count, so the caches are invalidated rather than
 * hand-patched: the list row also renders `lastEvaluatedAt`, which only the
 * server knows, and patching the count while leaving the timestamp stale would
 * produce a row claiming a fresh number evaluated three days ago.
 */
export function useRecomputeSegment() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => recomputeSegment(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: segmentsKey(gate.tenantId),
      });
    },
  });
}
