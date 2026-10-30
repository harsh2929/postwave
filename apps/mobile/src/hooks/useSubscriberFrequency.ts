/**
 * useSubscriberFrequency — write the SUB-132 per-person send-cadence.
 *
 * ONLINE-ONLY BY POLICY, and the policy predates this hook:
 * lib/offlineQueueSafety.ts lists frequency_preference / paused_until /
 * clear_paused_until / pause_days among SUBSCRIBER_ONLINE_ONLY_KEYS —
 * replaying a stale "paused" (or a stale un-pause) hours later would either
 * silence someone who asked to resume or resume someone who asked for quiet.
 * The write runs as a conditional PATCH inside the per-subscriber serial
 * queue, like every other profile write on mobile.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { updateSubscriberConditionally } from "@/api/subscriberConditionalWrite";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { subscriberWriteKey, subscriberWriteQueue } from "@/lib/serialQueue";
import { invalidateKeys } from "@/lib/subscriberQueryCache";
import { subscriberMutationInvalidationKeys } from "@/lib/subscriberQueryKeys";

export interface FrequencyWrite {
  id: string;
  /** Built by lib/subscriberFrequency's build*Body helpers — never ad hoc. */
  body: Record<string, unknown>;
}

export function useSubscriberFrequencyWrite() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: (input: FrequencyWrite) =>
      subscriberWriteQueue(subscriberWriteKey(input.id), () =>
        updateSubscriberConditionally(input.id, input.body),
      ),
    // No optimistic projection: "paused" must not show until the server
    // holds it — the whole point of the preference is what send-time does.
    onSettled: (_data, _error, input) => {
      if (!tenantId) return;
      invalidateKeys(
        queryClient,
        subscriberMutationInvalidationKeys(tenantId, input.id),
      );
    },
  });
}
