/**
 * useMergedSmsConversations — the inbox screen's guarded merge of
 * conversation pages.
 *
 * A merge that throws (a page from another response cutoff, an overlap, an
 * ordering violation) becomes an error STATE the screen renders, never a
 * crash or partially-trusted rows. Its own module so route tests exercise the
 * REAL merge rather than a mock's shape.
 */
import { useMemo } from "react";

import {
  mergeSmsConversationPages,
  type SmsConversationsPage,
} from "@/lib/smsConversation";

export function useMergedSmsConversations(pages: unknown): {
  value: ReturnType<typeof mergeSmsConversationPages> | null;
  error: unknown;
} {
  return useMemo(() => {
    if (!Array.isArray(pages) || pages.length === 0) {
      return { value: null, error: null };
    }
    try {
      return {
        value: mergeSmsConversationPages(pages as SmsConversationsPage[]),
        error: null,
      };
    } catch (error) {
      return { value: null, error };
    }
  }, [pages]);
}
