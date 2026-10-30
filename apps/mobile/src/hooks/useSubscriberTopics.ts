/**
 * useSubscriberTopics — read and change one contact's preference-centre state.
 *
 *   GET  /api/v1/subscribers/{email}/topics                       (viewer)
 *   POST /api/v1/subscribers/{email}/topics/{id}/subscribe        (editor)
 *   POST /api/v1/subscribers/{email}/topics/{id}/unsubscribe      (editor)
 *
 * ONLINE-ONLY, DELIBERATELY. The toggle is a state SETTER, not an additive
 * write, so a replay that lands an hour late would overwrite whatever the
 * subscriber did in the meantime — on the hosted preference page, which is the
 * one surface that outranks an operator here. The same reasoning keeps
 * `useRemoveSubscriberFromList` out of the offline queue.
 *
 * `staleTime: 0` because this is consent-adjacent state and the subscriber can
 * change it from their own inbox at any moment: a cached "opted in" is a claim
 * about what someone consented to, and a stale one is the kind of wrong that
 * ends in mail nobody asked for.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  listSubscriberTopics,
  setSubscriberTopic,
  type SubscriberTopic,
} from "@/api/topics";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { optimisticTriad, patchRowById } from "@/lib/optimisticQueries";

export type { SubscriberTopic } from "@/api/topics";

export function subscriberTopicsKey(
  tenantId: string | null | undefined,
  email: string,
): readonly unknown[] {
  return ["subscriber-topics", tenantId ?? null, email];
}

/**
 * The route param is an address, so a row that arrived without one has nothing
 * to ask about. Deliberately looser than a full RFC check — the server
 * lower-cases and matches citext, and rejecting an address the server would
 * have accepted is the worse error here.
 */
function usableEmail(email: string | undefined): string {
  const address = (email ?? "").trim().toLowerCase();
  return address.includes("@") ? address : "";
}

export function useSubscriberTopics(email: string | undefined) {
  const gate = useOnlineQueryGate();
  const address = usableEmail(email);
  return useQuery({
    queryKey: subscriberTopicsKey(gate.tenantId, address),
    enabled: gate.enabled && Boolean(gate.tenantId) && address !== "",
    staleTime: 0,
    queryFn: async (): Promise<SubscriberTopic[]> => {
      const res = await listSubscriberTopics(address);
      if (res.error) {
        throw Object.assign(new Error(res.error.message), res.error);
      }
      return res.data ?? [];
    },
  });
}

export interface SubscriberTopicToggle {
  email: string;
  topicId: string;
  optedIn: boolean;
}

export function useSetSubscriberTopic() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SubscriberTopicToggle): Promise<void> => {
      const address = usableEmail(input.email);
      if (!address) throw new Error("This contact has no email address.");
      const res = await setSubscriberTopic(
        address,
        input.topicId,
        input.optedIn,
      );
      if (res.error) {
        throw Object.assign(new Error(res.error.message), res.error);
      }
    },
    // The switch has to move under the finger. Without the projection the
    // control snaps back for the length of the round trip, which reads as a
    // rejected change rather than a pending one.
    ...optimisticTriad<SubscriberTopic[], SubscriberTopicToggle>(
      queryClient,
      (input) =>
        subscriberTopicsKey(
          gate.tenantId,
          usableEmail(input.email),
        ) as unknown[],
      (rows, input) =>
        patchRowById(rows, input.topicId, { optedIn: input.optedIn }),
    ),
    onSettled: (_data, _error, input) => {
      void queryClient.invalidateQueries({
        queryKey: subscriberTopicsKey(gate.tenantId, usableEmail(input.email)),
      });
    },
  });
}
