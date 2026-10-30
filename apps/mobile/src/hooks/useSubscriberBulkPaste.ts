/**
 * useSubscriberBulkPaste — the bulk-paste create, online-only BY DESIGN:
 * the verb's value is the per-row receipt (which addresses were accepted,
 * which failed), and an offline-queued paste has no one to show it to when
 * it lands. The sheet refuses to submit offline with that sentence
 * (lib/subscriberBulkPaste.bulkPasteProblem).
 *
 * Success invalidates the whole subscribers-list root, same as the single
 * create: up to a hundred rows may have appeared anywhere in the list.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { bulkPasteSubscribers } from "@/api/subscribersBulkPaste";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  parseBulkPasteResult,
  type BulkPasteResult,
} from "@/lib/subscriberBulkPaste";
import { subscriberQueryRootKey } from "@/lib/subscriberQueryKeys";

export function useSubscriberBulkPaste() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation<BulkPasteResult, Error, { emails: string; tags: string[] }>({
    mutationFn: async (input) =>
      parseBulkPasteResult(await bulkPasteSubscribers(input)),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: subscriberQueryRootKey(tenantId),
      });
    },
  });
}
