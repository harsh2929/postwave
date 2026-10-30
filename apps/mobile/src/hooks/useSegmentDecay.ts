/**
 * Segment decay radar queries.
 *
 * Gated on `useOnlineQueryGate` like every other read here, so a
 * restored-but-unvalidated session shows the reconnect notice rather than a
 * confident "no anomalies" about a segment nobody asked the server about.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  dismissSegmentDecayEvent,
  fetchSegmentDecayEvents,
  type SegmentDecayEvent,
} from "@/api/segmentDecay";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";

export function segmentDecayKey(
  tenantId: string | null | undefined,
  segmentId: string | null | undefined,
): readonly unknown[] {
  return ["segment-decay", tenantId ?? null, segmentId ?? null];
}

/**
 * Undismissed anomalies for one segment.
 *
 * `undismissed: true` deliberately: this card is an ALERT surface, and a
 * dismissed event is one an operator has already answered. The dismissed
 * history stays reachable on the desktop journal rather than re-litigating
 * itself on a phone every time the screen opens.
 */
export function useSegmentDecayEvents(id: string | undefined) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [...segmentDecayKey(gate.tenantId, id), "undismissed"],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(id),
    queryFn: (): Promise<SegmentDecayEvent[]> =>
      fetchSegmentDecayEvents(id!, { undismissed: true }),
  });
}

/**
 * Dismiss one anomaly. `write:subscribers` — editor and above.
 *
 * ONLINE-ONLY AND NEVER QUEUED, for the same reason the recompute is: there is
 * no un-dismiss route, so a queued dismissal is an irreversible write replayed
 * from a phone whose view of the segment may be days old. The screen confirms
 * first and reports the failure rather than promising it later.
 */
export function useDismissSegmentDecayEvent(segmentId: string | undefined) {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (eventId: string) =>
      dismissSegmentDecayEvent(segmentId!, eventId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: segmentDecayKey(gate.tenantId, segmentId),
      });
    },
  });
}
