/**
 * useSmsInboxOps — inbox-level operations: server-side search and bulk
 * lifecycle actions.
 *
 * Separate from `useSmsInbox` (the read surface, already at its source budget)
 * and from `useSmsInboxTriage` (the per-conversation writes) because these two
 * act on the LIST as a whole: one read that mints nothing, and one write whose
 * receipt invalidates every status slice at once.
 *
 * SEARCH IS SUBMIT-DRIVEN, NOT KEYSTROKE-DRIVEN. Every query is a POST the
 * server audits (`sms.inbox.search`), so firing one per keystroke would write
 * an audit row per letter typed. The screen submits an explicit query; the
 * hook keys the cache on it.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import {
  bulkSmsConversationAction,
  searchSmsConversations,
} from "@/api/smsInboxOps";
import {
  assertCurrentSmsIdentity,
  identityOrThrow,
  SMS_CONVERSATIONS_KEY,
  SMS_SEARCH_KEY,
  useRetireSmsQueries,
  type SmsInboxAccess,
} from "@/hooks/useSmsInbox";
import type {
  SmsBulkAction,
  SmsBulkActionReceipt,
  SmsBulkTarget,
} from "@/lib/smsBulkAction";
import { smsSearchQueryError } from "@/lib/smsInboxSearch";

export interface SmsBulkIntent {
  conversations: readonly SmsBulkTarget[];
  action: SmsBulkAction;
  until?: string | undefined;
}

/**
 * Pages of server-side matches for one submitted query. Disabled until the
 * query passes the server's own 3..128 safe-code-point gate, so no request
 * that is certain to 400 ever leaves the device.
 */
export function useSmsConversationSearch(
  submittedQuery: string,
  access: SmsInboxAccess,
) {
  useRetireSmsQueries(access);
  const query = submittedQuery.trim();
  const valid = query !== "" && smsSearchQueryError(query) === null;
  return useInfiniteQuery({
    queryKey: [
      SMS_SEARCH_KEY,
      access.identity?.fingerprint ?? null,
      query,
    ] as const,
    enabled: access.canRequest && valid,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const identity = identityOrThrow(access.canRequest, access.identity);
      const page = await searchSmsConversations({
        tenantId: identity.tenantId,
        query,
        ...(pageParam ? { cursor: pageParam } : {}),
        signal,
      });
      assertCurrentSmsIdentity(identity);
      return page;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 15_000,
  });
}

/**
 * One lifecycle change for the whole selection. All-or-nothing on the server:
 * a 409 `bulk_action_conflict` means some row moved since it was loaded and
 * NOTHING was applied — the screen should refresh and re-offer, not retry.
 *
 * Never queued offline, for the same reason the single-row triage writes are
 * not: a bulk archive landing twenty minutes late re-buries conversations the
 * operator has since dealt with by hand.
 */
export function useSmsBulkTriage(access: SmsInboxAccess) {
  const client = useQueryClient();
  const controllers = useRef(new Set<AbortController>());
  useEffect(
    () => () => {
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
    },
    [access.canRequest, access.identity?.fingerprint],
  );
  const withController = useCallback(
    async <T>(run: (signal: AbortSignal) => Promise<T>) => {
      const controller = new AbortController();
      controllers.current.add(controller);
      try {
        return await run(controller.signal);
      } finally {
        controllers.current.delete(controller);
      }
    },
    [],
  );
  return useMutation<SmsBulkActionReceipt, Error, SmsBulkIntent>({
    mutationKey: ["sms-bulk-triage-v1", access.identity?.fingerprint ?? null],
    mutationFn: async (intent) => {
      const identity = identityOrThrow(access.canRequest, access.identity);
      const receipt = await withController((signal) =>
        bulkSmsConversationAction({
          tenantId: identity.tenantId,
          conversations: intent.conversations,
          action: intent.action,
          ...(intent.until ? { until: intent.until } : {}),
          signal,
        }),
      );
      assertCurrentSmsIdentity(identity);
      return receipt;
    },
    onSuccess: () => {
      // A lifecycle change moves rows BETWEEN status slices and stales any
      // search page those rows appear on.
      void client.invalidateQueries({ queryKey: [SMS_CONVERSATIONS_KEY] });
      void client.invalidateQueries({ queryKey: [SMS_SEARCH_KEY] });
    },
  });
}
