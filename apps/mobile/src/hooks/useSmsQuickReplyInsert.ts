/**
 * useSmsQuickReplyInsert — the thread screen's quick-reply insertion memory.
 *
 * Remembers the last quick reply inserted into the draft and, when the
 * composer reports a PERSISTED send whose body still equals it, records one
 * use so the picker ranking follows real sends. A failed bump is surfaced as
 * a warning — the send itself succeeded, only ranking drift occurred — and
 * uncertain/failed dispatches never record anything.
 */
import { useCallback, useRef } from "react";

import type { ToastOptions } from "@/components/Toast";
import type { SmsInboxAccess } from "@/hooks/useSmsInbox";
import { useSmsQuickReplyUse } from "@/hooks/useSmsQuickReplies";
import type { SmsQuickReply } from "@/lib/smsQuickReply";

export function useSmsQuickReplyInsert(
  access: SmsInboxAccess,
  toast: (options: ToastOptions) => void,
): {
  /** Remember the reply whose body was just placed into the draft. */
  noteInserted: (reply: SmsQuickReply) => void;
  /** Wire into `useSmsThreadComposer`'s `onPersisted`. */
  onPersisted: (body: string) => void;
} {
  const lastInserted = useRef<{ id: string; body: string } | null>(null);
  const recordUse = useSmsQuickReplyUse(access);
  const noteInserted = useCallback((reply: SmsQuickReply) => {
    lastInserted.current = { id: reply.id, body: reply.body };
  }, []);
  const onPersisted = useCallback(
    (body: string) => {
      const inserted = lastInserted.current;
      if (!inserted || inserted.body !== body) return;
      lastInserted.current = null;
      recordUse.mutate(
        { id: inserted.id },
        {
          onError: () => {
            toast({
              kind: "warning",
              message:
                "Reply sent; the quick-reply usage ranking was not updated.",
            });
          },
        },
      );
    },
    [recordUse, toast],
  );
  return { noteInserted, onPersisted };
}
