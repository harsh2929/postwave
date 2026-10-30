/**
 * hooks/useReplyMailboxes.ts — the reply-capture registry.
 *
 * ONLINE-ONLY, NEVER QUEUED. A queued disable tells the operator a failing
 * mailbox has stopped being polled while it keeps erroring every minute — and
 * "stop this thing" is the reason to reach for a phone here at all.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  deleteReplyMailbox,
  listReplyMailboxes,
  setReplyMailboxEnabled,
} from "@/api/replyMailboxes";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import type { ReplyMailbox } from "@/lib/replyMailboxes";

const KEY = "reply-mailboxes";

export function useReplyMailboxes() {
  const gate = useOnlineQueryGate();
  // The list is read:reports (viewer); the writes are admin and are gated in
  // the panel, so a viewer sees which mailbox is failing without controls.
  return useQuery({
    queryKey: [KEY, gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 30_000,
    // A workspace with no reply capture configured has nothing here and may
    // answer 4xx; retrying will not change that.
    retry: false,
    queryFn: (): Promise<ReplyMailbox[]> => listReplyMailboxes(),
  });
}

export function useSetReplyMailboxEnabled() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation<ReplyMailbox[], Error, { id: string; enabled: boolean }>({
    mutationFn: async ({ id, enabled }) => {
      if (!gate.enabled) throw new Error("Reconnect before changing reply mailboxes.");
      if (!canAccessMinimumRole("admin", gate.effectiveRole)) {
        throw new Error("Admin access is required.");
      }
      const receipt = await setReplyMailboxEnabled(id, enabled);
      if (receipt.id !== id || receipt.enabled !== enabled) {
        throw new Error("The mailbox action receipt did not match the reviewed action.");
      }
      const fresh = await listReplyMailboxes();
      if (!fresh.some((row) => row.id === id && row.enabled === enabled)) {
        throw new Error("A fresh mailbox read did not confirm the action.");
      }
      return fresh;
    },
    onSuccess: (fresh) => {
      qc.setQueryData([KEY, gate.tenantId], fresh);
    },
  });
}

export function useDeleteReplyMailbox() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation<ReplyMailbox[], Error, string>({
    mutationFn: async (id: string) => {
      if (!gate.enabled) throw new Error("Reconnect before changing reply mailboxes.");
      if (!canAccessMinimumRole("admin", gate.effectiveRole)) {
        throw new Error("Admin access is required.");
      }
      await deleteReplyMailbox(id);
      const fresh = await listReplyMailboxes();
      if (fresh.some((row) => row.id === id)) {
        throw new Error("A fresh mailbox read still contains the deleted registration.");
      }
      return fresh;
    },
    onSuccess: (fresh) => {
      qc.setQueryData([KEY, gate.tenantId], fresh);
    },
  });
}

/** Both writes sit behind ScopeAdmin on the same mount. */
export function useCanManageReplyMailboxes(): boolean {
  const gate = useOnlineQueryGate();
  return canAccessMinimumRole("admin", gate.effectiveRole);
}
