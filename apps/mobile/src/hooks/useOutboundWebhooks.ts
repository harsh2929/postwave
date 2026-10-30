/**
 * hooks/useOutboundWebhooks.ts — queries and mutations for the Webhooks screen.
 *
 * The Settings section this replaces bypassed TanStack Query entirely: a
 * hand-rolled `useState` + `useEffect` refresh with no cache, no refetch on
 * focus, no online gating, no participation in pull-to-refresh, no generation
 * guard for overlapping refreshes, and no unmount safety for its setState.
 * Every one of those is free here.
 *
 * Everything is online-only on purpose. A paused/re-enabled endpoint or a
 * replayed delivery queued offline and fired hours later would act on state
 * the operator has long since moved past — for a delivery replay that means
 * re-sending an event the receiver already handled.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";

import {
  fetchWebhookHealth,
  listDeliveries,
  reEnableOutboundWebhook,
  replayDelivery,
  setOutboundWebhookActive,
  type DeliveryStatus,
  type OutboundHealth,
} from "@/api/outboundWebhooks";
import { listOutboundWebhooks, type OutboundWebhook } from "@/api/settings";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { OptimisticSnapshot } from "@/lib/optimisticQueries";
import {
  OUTBOUND_WEBHOOKS_KEY,
  webhookActiveTriad,
} from "@/lib/optimisticWrites";

export type { OutboundWebhook } from "@/api/settings";
export type {
  DeliveryStatus,
  OutboundDelivery,
  OutboundHealth,
} from "@/api/outboundWebhooks";

// Shared with the optimistic projection in lib/optimisticWrites.ts — a
// projection aimed at a key the query does not use fails silently, so there is
// exactly one definition.
const ENDPOINTS_KEY = OUTBOUND_WEBHOOKS_KEY;
const DELIVERIES_KEY = "outbound-webhook-deliveries";
const HEALTH_KEY = "outbound-webhook-health";

export function useOutboundWebhooks() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [ENDPOINTS_KEY, gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 30_000,
    queryFn: async (): Promise<OutboundWebhook[]> => {
      const res = await listOutboundWebhooks();
      if (res.error) {
        const err = new Error(res.error.message || "Couldn't load webhooks.");
        // Keep the status inspectable so a 403 renders as a permission
        // verdict rather than a retryable "something went wrong".
        Object.assign(err, { status: res.error.status });
        throw err;
      }
      // Array.isArray, not `?? []`: the nullish guard passes a `webhooks` that
      // arrived as an object straight through to `patchRowById`'s `.map` in
      // the optimistic pause/resume triad and to the screen's badge memo.
      return Array.isArray(res.data?.webhooks) ? res.data.webhooks : [];
    },
  });
}

export function useOutboundDeliveries(status: DeliveryStatus | "all") {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [DELIVERIES_KEY, gate.tenantId, status],
    enabled: gate.enabled && Boolean(gate.tenantId),
    // Deliveries are a live diagnostic — short staleness, but not a poll:
    // an operator watching this screen pulls to refresh deliberately.
    staleTime: 15_000,
    queryFn: () =>
      listDeliveries(status === "all" ? {} : { status, limit: 50 }),
  });
}

/** 24h health rollup for one endpoint. Only fetched when a row is expanded. */
export function useOutboundWebhookHealth(id: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [HEALTH_KEY, gate.tenantId, id],
    enabled: gate.enabled && Boolean(gate.tenantId && id),
    staleTime: 30_000,
    queryFn: (): Promise<OutboundHealth> => {
      if (!id) throw new Error("No webhook selected.");
      return fetchWebhookHealth(id);
    },
  });
}

export interface WebhookActions {
  replay: UseMutationResult<void, Error, string>;
  reEnable: UseMutationResult<void, Error, string>;
  // The fourth type argument is the optimistic rollback context; without it
  // TContext defaults to `unknown` and the triad below stops type-checking.
  setActive: UseMutationResult<
    void,
    Error,
    { id: string; active: boolean },
    OptimisticSnapshot
  >;
}

/**
 * The three write actions the screen offers. Each invalidates every view that
 * could now be stale — the endpoint list, the delivery feed, and any open
 * health rollup — so the UI cannot keep showing the state the user just
 * changed.
 */
export function useOutboundWebhookActions(): WebhookActions {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();

  const invalidateAll = () => {
    void qc.invalidateQueries({ queryKey: [ENDPOINTS_KEY, gate.tenantId] });
    void qc.invalidateQueries({ queryKey: [DELIVERIES_KEY, gate.tenantId] });
    void qc.invalidateQueries({ queryKey: [HEALTH_KEY, gate.tenantId] });
  };

  const replay = useMutation<void, Error, string>({
    mutationFn: (deliveryId: string) => replayDelivery(deliveryId),
    onSuccess: invalidateAll,
  });

  const reEnable = useMutation<void, Error, string>({
    mutationFn: (id: string) => reEnableOutboundWebhook(id),
    onSuccess: invalidateAll,
  });

  // Pause/resume is the one write here whose result the client already knows:
  // the server stores the boolean verbatim. The switch therefore moves on tap
  // and moves back if the PATCH fails (the screen raises the error toast), so
  // the row stops disagreeing with the control the user just used. Replay and
  // re-enable are NOT projected — a replay's outcome and the circuit
  // breaker's `consecutive_failures` are both computed server-side.
  const setActive = useMutation<
    void,
    Error,
    { id: string; active: boolean },
    OptimisticSnapshot
  >({
    mutationFn: ({ id, active }) => setOutboundWebhookActive(id, active),
    ...webhookActiveTriad<OutboundWebhook>(qc, gate.tenantId),
    onSettled: invalidateAll,
  });

  return { replay, reEnable, setActive };
}
