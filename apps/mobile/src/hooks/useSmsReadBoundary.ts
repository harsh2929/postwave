/**
 * useSmsReadBoundary — marks the thread's first-page inbound messages read
 * exactly once per (phone, response cutoff, id-set) boundary.
 *
 * Moved verbatim out of `app/(tabs)/sms/[phone].tsx` when the screen function
 * crossed its 300-line budget; behavior is unchanged. The boundary string
 * prevents re-marking on every render while still re-marking when a NEW
 * response cutoff delivers new inbound ids.
 */
import { useEffect, useRef } from "react";

import type { SmsInboxAccess } from "@/hooks/useSmsInbox";
import type { SmsMessage, SmsMessagesPage } from "@/lib/smsConversation";

export function useSmsReadBoundary(input: {
  phone: string;
  access: SmsInboxAccess;
  isSuccess: boolean;
  pages: SmsMessagesPage[] | undefined;
  mergedValue: { messages: SmsMessage[] } | null;
  identityFingerprint: string | null;
  markRead: {
    mutate: (
      variables: { phoneE164: string; messageIds: string[] },
      options: { onError: () => undefined },
    ) => void;
  };
}): void {
  const { phone, access, isSuccess, pages, mergedValue, markRead } = input;
  const markedRef = useRef<string | null>(null);
  useEffect(() => {
    markedRef.current = null;
  }, [input.identityFingerprint, phone]);
  useEffect(() => {
    const firstPage = Array.isArray(pages) ? pages[0] : undefined;
    if (!phone || !access.canRequest || !isSuccess || !mergedValue || !firstPage) {
      return;
    }
    const messageIds = firstPage.messages
      .filter((message) => message.direction === "inbound")
      .map((message) => message.id)
      .slice(0, 500);
    if (messageIds.length === 0) return;
    const boundary = JSON.stringify([phone, firstPage.snapshotAt, messageIds]);
    if (markedRef.current === boundary) return;
    markedRef.current = boundary;
    markRead.mutate(
      { phoneE164: phone, messageIds },
      { onError: () => undefined },
    );
  }, [access.canRequest, markRead, mergedValue, phone, pages, isSuccess]);
}
