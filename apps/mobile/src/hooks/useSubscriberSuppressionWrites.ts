/**
 * useSuppressSubscriber / useUnsuppressSubscriber — the suppression pair.
 *
 * Split out of hooks/useSubscribers.ts, which was over its file budget once
 * the list became offline-capable. Re-exported from there so every existing
 * import keeps working.
 *
 * These two belong TOGETHER and nowhere else: suppressing touches TWO things
 * (it writes a deliverability suppression row AND blocklists the subscriber),
 * so an undo that only deleted the suppression row would leave the person
 * blocklisted and silently un-mailable. Keeping the pair in one module is
 * what makes that invariant reviewable.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { getClient } from "@/api/client";
import { updateSubscriberConditionally } from "@/api/subscriberConditionalWrite";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  subscriberWriteKey,
  subscriberWriteQueue,
} from "@/lib/serialQueue";
import {
  invalidateKeys,
  rollbackPatchedQueries,
  subscriberRowPatch,
} from "@/lib/subscriberQueryCache";
import { subscriberMutationInvalidationKeys } from "@/lib/subscriberQueryKeys";

/** Subscriber `status` values the API's PATCH accepts. */
export type SubscriberWriteStatus =
  | "enabled"
  | "disabled"
  | "blocklisted"
  | "unconfirmed";

export function useSuppressSubscriber() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    // Serialised with every other write to this subscriber row: suppress
    // lands a status change, and an unqueued one can commit after a queued
    // unsubscribe/resubscribe the user asked for later.
    mutationFn: (id: string) =>
      subscriberWriteQueue(subscriberWriteKey(id), async () => {
        const { client } = getClient();
        return client.subscribers.suppress(id);
      }),
    // Suppress is a single-row status change with a first-class undo
    // (useUnsuppressSubscriber below), so the pill flips now and reverts if
    // the request fails.
    onMutate: (id) =>
      optimisticSubscriberPatch(queryClient, tenantId, id, {
        status: "blocklisted",
      }),
    onError: (_err, _id, context) =>
      rollbackPatchedQueries(queryClient, context),
    onSettled: (_data, _err, id) => {
      // Suppressing writes a DELIVERABILITY row as well as flipping status,
      // so the "suppressions" cache root must refresh too — that is what
      // drives the profile's suppression card (useSubscriberSuppression) and
      // the suppressions screen. Only the unsuppress half used to do this,
      // so a suppress made from the profile left the card saying "clean".
      void queryClient.invalidateQueries({ queryKey: ["suppressions"] });
      invalidateSubscriber(queryClient, tenantId, id);
    },
  });
}

/**
 * useUnsuppressSubscriber — the undo half of Suppress.
 *
 * Suppression IS reversible server-side (DELETE
 * /api/v1/deliverability/suppressions/{email}) but mobile offered no way
 * back, so the destructive action was presented behind a scary confirm
 * dialog and then took the operator off the screen with no receipt. Pair
 * this with a toast + Undo instead.
 *
 * Keyed by EMAIL, not id — that is the suppression table's identity.
 *
 * Suppressing touches TWO things: it writes a deliverability suppression
 * row AND blocklists the subscriber. An undo that only deleted the
 * suppression row would leave the person blocklisted and silently
 * un-mailable, so callers pass `restoreStatus` (the engine status the row
 * carried before they suppressed) and both are reverted.
 */
export function useUnsuppressSubscriber() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      email: string;
      restoreStatus?: SubscriberWriteStatus;
    }) => {
      const { client } = getClient();
      const result = await client.request(
        "DELETE",
        `/api/v1/deliverability/suppressions/${encodeURIComponent(input.email)}`,
      );
      if (input.restoreStatus && input.restoreStatus !== "blocklisted") {
        await subscriberWriteQueue(subscriberWriteKey(input.id), () =>
          // Conditional: the server 428s an unconditional subscriber PATCH
          // (handlers.go:590-594), so un-suppressing silently failed to restore
          // the status half — the suppression came off and the person stayed
          // blocklisted.
          updateSubscriberConditionally(input.id, {
            status: input.restoreStatus!,
          }),
        );
      }
      return result;
    },
    // Only project when the caller told us what to restore TO — inventing a
    // status here would be a guess, and "blocklisted" is what we are undoing.
    onMutate: (input) =>
      input.restoreStatus && input.restoreStatus !== "blocklisted"
        ? optimisticSubscriberPatch(queryClient, tenantId, input.id, {
            status: input.restoreStatus,
          })
        : Promise.resolve({ previous: [] }),
    onError: (_err, _input, context) =>
      rollbackPatchedQueries(queryClient, context),
    onSettled: (_data, _err, input) => {
      void queryClient.invalidateQueries({ queryKey: ["suppressions"] });
      invalidateSubscriber(queryClient, tenantId, input.id);
    },
  });
}

function optimisticSubscriberPatch(
  queryClient: ReturnType<typeof useQueryClient>,
  tenantId: string | null,
  id: string,
  patch: Record<string, unknown>,
) {
  return subscriberRowPatch<Record<string, unknown>>(
    queryClient,
    tenantId,
    id,
    patch,
  );
}

function invalidateSubscriber(
  queryClient: ReturnType<typeof useQueryClient>,
  tenantId: string | null,
  id: string,
): void {
  if (!tenantId) return;
  invalidateKeys(queryClient, subscriberMutationInvalidationKeys(tenantId, id));
}
