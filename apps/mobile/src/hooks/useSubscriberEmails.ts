/**
 * useSubscriberEmails — the SUB-016 alternate-address list + its three
 * writes. All writes are ONLINE-ONLY (consent evidence and identity edits
 * never queue) and run inside the per-subscriber serial queue like every
 * other profile write; each settles by invalidating the emails key and the
 * subscriber root (the primary flag is mirrored onto the profile row).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  addSubscriberEmail,
  deleteSubscriberEmail,
  listSubscriberEmails,
  updateSubscriberEmail,
} from "@/api/subscribersEmails";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { subscriberWriteKey, subscriberWriteQueue } from "@/lib/serialQueue";
import {
  parseSubscriberEmails,
  type SubscriberEmailRow,
} from "@/lib/subscriberEmails";
import { subscriberQueryRootKey } from "@/lib/subscriberQueryKeys";

export function subscriberEmailsKey(
  tenantId: string | null | undefined,
  subscriberId: string,
): readonly unknown[] {
  return ["subscriber-emails", tenantId ?? null, subscriberId];
}

export function useSubscriberEmails(subscriberId: string, enabled: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: subscriberEmailsKey(gate.tenantId, subscriberId),
    enabled: enabled && gate.enabled && Boolean(gate.tenantId && subscriberId),
    queryFn: async (): Promise<SubscriberEmailRow[]> =>
      parseSubscriberEmails(await listSubscriberEmails(subscriberId)),
  });
}

export function useSubscriberEmailWrites(subscriberId: string) {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();

  const settle = () => {
    if (!tenantId) return;
    void queryClient.invalidateQueries({
      queryKey: subscriberEmailsKey(tenantId, subscriberId),
    });
    void queryClient.invalidateQueries({
      queryKey: subscriberQueryRootKey(tenantId),
    });
  };

  const add = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      subscriberWriteQueue(subscriberWriteKey(subscriberId), () =>
        addSubscriberEmail(subscriberId, body),
      ),
    onSettled: settle,
  });

  const update = useMutation({
    mutationFn: (input: {
      emailId: string;
      version: string;
      body: Record<string, unknown>;
    }) =>
      subscriberWriteQueue(subscriberWriteKey(subscriberId), () =>
        updateSubscriberEmail(
          subscriberId,
          input.emailId,
          input.version,
          input.body,
        ),
      ),
    onSettled: settle,
  });

  const remove = useMutation({
    mutationFn: (input: { emailId: string; version: string }) =>
      subscriberWriteQueue(subscriberWriteKey(subscriberId), () =>
        deleteSubscriberEmail(subscriberId, input.emailId, input.version),
      ),
    onSettled: settle,
  });

  return { add, update, remove };
}
