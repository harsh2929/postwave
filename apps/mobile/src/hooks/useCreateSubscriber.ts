/**
 * useCreateSubscriber — POST /api/v1/subscribers from a phone.
 *
 * The body is built by src/lib/subscriberDraft.ts, which documents WHY it
 * sends no `status`: the server's create path only accepts a bare email for
 * an `unconfirmed` contact, and anything sendable requires a reviewed consent
 * envelope that must not be thumb-typed.
 *
 * A successful create invalidates the whole subscribers-list root so the new
 * row appears wherever the operator is looking, rather than being optimistically
 * inserted into a filtered/sorted page where it may not belong.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { getClient } from "@/api/client";
import {
  codeFromError,
  messageFromError,
  statusFromError,
} from "@/api/request";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { subscriberQueryRootKey } from "@/lib/subscriberQueryKeys";
import {
  createSubscriberErrorMessage,
  subscriberCreateBody,
  type SubscriberDraft,
} from "@/lib/subscriberDraft";

export interface CreatedSubscriber {
  id?: string;
  email?: string;
  status?: string;
}

export function useCreateSubscriber() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation<CreatedSubscriber, Error, SubscriberDraft>({
    mutationFn: async (draft) => {
      const { client } = getClient();
      try {
        const res = await client.request<unknown>("POST", "/api/v1/subscribers", {
          body: subscriberCreateBody(draft),
        });
        return (res ?? {}) as CreatedSubscriber;
      } catch (error) {
        // Re-thrown as a sentence the operator can act on. The raw
        // "email_taken" / "erasure_blocked" codes are meaningless in a toast.
        throw new Error(
          createSubscriberErrorMessage(
            statusFromError(error),
            codeFromError(error),
            messageFromError(error),
          ),
        );
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: subscriberQueryRootKey(tenantId),
      });
    },
  });
}
