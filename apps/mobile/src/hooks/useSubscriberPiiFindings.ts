/**
 * useSubscriberPiiFindings — the Shadow-PII review queue on the phone.
 *
 * Reads are admin-floored server-side; the calling screens gate on the same
 * floor so the hook never fires for a role that would 403 (and when a stale
 * session does 403, lib/subscriberPiiFindings.piiFailureMessage renders it as
 * the permission rule it is).
 *
 * THE DECISION IS ONLINE-ONLY AND NEVER QUEUED. A review commits an immutable
 * compliance receipt against the row's `expected_updated_at`; one replayed
 * from an offline outbox hours later would either 409 uselessly or — worse —
 * decide a finding the on-call admin has since re-examined. `staleTime: 0` on
 * the queue for the same reason: a decided finding must not keep showing as
 * "Needs review" on the device that decided it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchPiiFindings,
  fetchSubscriberPiiFindings,
  reviewPiiFinding,
  type PiiQueueParams,
} from "@/api/subscribersPiiFindings";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  parsePiiFindingPage,
  type PiiFindingRow,
} from "@/lib/subscriberPiiFindings";

export function piiFindingsQueueKey(
  tenantId: string | null | undefined,
  params?: PiiQueueParams,
): readonly unknown[] {
  const root = ["pii-findings", tenantId ?? null] as const;
  return params
    ? [...root, params.status, params.page, params.perPage]
    : root;
}

export function subscriberPiiFindingsKey(
  tenantId: string | null | undefined,
  subscriberId: string,
): readonly unknown[] {
  return ["subscriber-pii-findings", tenantId ?? null, subscriberId];
}

export function usePiiFindingsQueue(params: PiiQueueParams, enabled: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: piiFindingsQueueKey(gate.tenantId, params),
    enabled: enabled && gate.enabled && Boolean(gate.tenantId),
    staleTime: 0,
    queryFn: async (): Promise<{ items: PiiFindingRow[]; total: number }> =>
      parsePiiFindingPage(await fetchPiiFindings(params)),
  });
}

export function useSubscriberPiiFindings(
  subscriberId: string | undefined,
  enabled: boolean,
) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: subscriberPiiFindingsKey(gate.tenantId, subscriberId ?? ""),
    enabled: enabled && gate.enabled && Boolean(gate.tenantId && subscriberId),
    staleTime: 0,
    queryFn: async (): Promise<{ items: PiiFindingRow[]; total: number }> =>
      parsePiiFindingPage(await fetchSubscriberPiiFindings(subscriberId!)),
  });
}

export interface PiiReviewWrite {
  findingId: string;
  /** For invalidating that profile's card; "" when unknown. */
  subscriberId: string;
  body: Record<string, string>;
}

export function useReviewPiiFinding() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: (input: PiiReviewWrite) =>
      reviewPiiFinding(input.findingId, input.body),
    // No optimistic projection: a finding must never SHOW decided while the
    // server may still refuse the receipt (stale expected_updated_at → 409).
    onSettled: (_data, _error, input) => {
      if (!tenantId) return;
      void queryClient.invalidateQueries({
        queryKey: piiFindingsQueueKey(tenantId),
      });
      if (input.subscriberId) {
        void queryClient.invalidateQueries({
          queryKey: subscriberPiiFindingsKey(tenantId, input.subscriberId),
        });
      }
    },
  });
}
