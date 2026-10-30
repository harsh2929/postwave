/**
 * Identity-bound queries and online-only mutations for the mobile SMS inbox.
 *
 * The freshness machinery both list queries share — the poll state, the
 * pull-to-refresh reset, and the head-replacement interval with its four rules
 * — lives in the sibling `@/hooks/useSmsInboxPoll`, which was extracted when
 * this file carried two copies of the same seventy-line effect. The lifecycle
 * and sender WRITES live in `@/hooks/useSmsInboxTriage`.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  getConversationContext,
  listConversationMessages,
  listConversations,
  listSmsSenders,
  markConversationRead,
  replyToConversation,
  type ConversationFilter,
  type ConversationStatus,
} from "@/api/smsInbox";
import { useIsOnline } from "@/hooks/useIsOnline";
import {
  assertCurrentSmsIdentity,
  identityOrThrow,
  makeIdentity,
  type SmsInboxAccess,
} from "@/hooks/smsInboxIdentity";
import {
  useSmsFirstPageRefresh,
  useSmsHeadRefresh,
  useSmsPollState,
} from "@/hooks/useSmsInboxPoll";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { onContextEpochChange, readContextEpoch } from "@/lib/contextEpoch";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import type { SmsReplyResponse } from "@/lib/smsConversation";
import {
  mergeSmsConversationPages,
  mergeSmsMessagePages,
} from "@/lib/smsConversation";
import { useAuthStore } from "@/store/auth";

export type { ConversationFilter, ConversationStatus } from "@/api/smsInbox";
export type {
  SmsConversationContext,
  SmsConversationSummary,
  SmsConversationsPage,
  SmsMessage,
  SmsMessagesPage,
  SmsSenderProfile,
} from "@/lib/smsConversation";

export const SMS_CONVERSATIONS_KEY = "sms-conversations-v2";
export const SMS_THREAD_KEY = "sms-thread-v2";
export const SMS_CONTEXT_KEY = "sms-context-v2";
export const SMS_SENDERS_KEY = "sms-senders-v2";
export const SMS_SEARCH_KEY = "sms-search-v1";
export const SMS_QUICK_REPLIES_KEY = "sms-quick-replies-v1";
export const SMS_CONVERSATION_META_KEY = "sms-conversation-meta-v1";
export const SMS_BROADCASTS_KEY = "sms-broadcasts-v1";
const SMS_QUERY_ROOTS = new Set([
  SMS_CONVERSATIONS_KEY,
  SMS_THREAD_KEY,
  SMS_CONTEXT_KEY,
  SMS_SENDERS_KEY,
  SMS_SEARCH_KEY,
  SMS_QUICK_REPLIES_KEY,
  SMS_CONVERSATION_META_KEY,
  SMS_BROADCASTS_KEY,
]);
// Re-exported so the inbox's public surface is unchanged by the poll split.
export { SMS_INBOX_POLL_MS, type SmsPollState } from "@/hooks/useSmsInboxPoll";

// Re-exported so the inbox's public surface is unchanged by the identity split.
export {
  assertCurrentSmsIdentity,
  identityOrThrow,
  SmsIdentityRetiredError,
  type SmsInboxAccess,
  type SmsInboxIdentity,
} from "@/hooks/smsInboxIdentity";

export function useSmsInboxAccess(focused = true): SmsInboxAccess {
  const gate = useOnlineQueryGate();
  const online = useIsOnline();
  const mode = useAuthStore((state) => state.mode);
  const [contextEpoch, setContextEpoch] = useState<string | null>(
    () => readContextEpoch() ?? null,
  );
  useEffect(() => onContextEpochChange((epoch) => setContextEpoch(epoch)), []);
  const roleAllowed = canAccessMinimumRole("admin", gate.effectiveRole, mode);
  const identity = useMemo(
    () =>
      makeIdentity({
        baseUrl: gate.baseUrl,
        tenantId: gate.tenantId,
        userId: gate.userId,
        effectiveRole: gate.effectiveRole,
        mode,
        contextEpoch,
      }),
    [
      gate.baseUrl,
      gate.tenantId,
      gate.userId,
      gate.effectiveRole,
      mode,
      contextEpoch,
    ],
  );
  const sessionReady = gate.enabled && Boolean(identity);
  return {
    identity,
    roleAllowed,
    online,
    sessionReady,
    canRequest: focused && online && sessionReady && roleAllowed,
    denialReason: roleAllowed
      ? null
      : mode === "api_key"
        ? "SMS Inbox requires an owner or admin session; mobile API-key scopes are not exposed."
        : "SMS Inbox is restricted to workspace owners and admins.",
  };
}

export function useRetireSmsQueries(access: SmsInboxAccess): void {
  const client = useQueryClient();
  const previous = useRef(access.identity?.fingerprint ?? null);
  useEffect(() => {
    const current = access.identity?.fingerprint ?? null;
    const isSms = (query: { queryKey: readonly unknown[] }) =>
      SMS_QUERY_ROOTS.has(String(query.queryKey[0]));
    const isRetired = (query: { queryKey: readonly unknown[] }) =>
      isSms(query) && query.queryKey[1] !== current;

    if (!access.roleAllowed || !access.identity) {
      void client.cancelQueries({ predicate: isSms });
      client.removeQueries({ predicate: isSms });
    } else if (previous.current !== current) {
      void client.cancelQueries({ predicate: isRetired });
      client.removeQueries({ predicate: isRetired });
    } else if (!access.canRequest) {
      // Offline/background: abort the socket, retain the verified page set so
      // the screen can label it stale instead of manufacturing emptiness.
      void client.cancelQueries({ predicate: isSms });
    }
    previous.current = current;
  }, [access.canRequest, access.identity, access.roleAllowed, client]);
}

export function useSmsConversations(
  filter: ConversationFilter,
  access: SmsInboxAccess,
  status: ConversationStatus = "active",
) {
  const client = useQueryClient();
  const { pollState, pollStateRef, updatePollState } = useSmsPollState();
  const gate = { enabled: access.canRequest };
  useRetireSmsQueries(access);
  const sort = filter === "unread" ? "oldest_unread" : "recent";
  const key = useMemo(
    () =>
      [
        SMS_CONVERSATIONS_KEY,
        access.identity?.fingerprint ?? null,
        filter,
        sort,
        status,
      ] as const,
    [access.identity?.fingerprint, filter, sort, status],
  );
  const query = useInfiniteQuery({
    queryKey: key,
    enabled: gate.enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const identity = identityOrThrow(access.canRequest, access.identity);
      const page = await listConversations({
        tenantId: identity.tenantId,
        filter,
        sort,
        status,
        ...(pageParam ? { cursor: pageParam } : {}),
        signal,
      });
      assertCurrentSmsIdentity(identity);
      return page;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    select: (data) => {
      mergeSmsConversationPages(data.pages);
      return data;
    },
    staleTime: 15_000,
  });
  const refreshFirstPage = useSmsFirstPageRefresh(client, key, updatePollState);
  const fetchHead = useCallback(
    async (signal: AbortSignal) => {
      const identity = identityOrThrow(access.canRequest, access.identity);
      const head = await listConversations({
        tenantId: identity.tenantId,
        filter,
        sort,
        status,
        signal,
      });
      assertCurrentSmsIdentity(identity);
      return head;
    },
    [access.canRequest, access.identity, filter, sort, status],
  );
  useSmsHeadRefresh({
    enabled: access.canRequest,
    queryKey: key,
    fetchHead,
    pollStateRef,
    updatePollState,
  });
  return { ...query, refreshFirstPage, pollState };
}

export function useSmsThread(phoneE164: string, access: SmsInboxAccess) {
  const client = useQueryClient();
  const { pollState, pollStateRef, updatePollState } = useSmsPollState();
  const gate = { enabled: access.canRequest };
  useRetireSmsQueries(access);
  const key = useMemo(
    () =>
      [
        SMS_THREAD_KEY,
        access.identity?.fingerprint ?? null,
        phoneE164,
      ] as const,
    [access.identity?.fingerprint, phoneE164],
  );
  const query = useInfiniteQuery({
    queryKey: key,
    enabled: gate.enabled && Boolean(phoneE164),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const identity = identityOrThrow(access.canRequest, access.identity);
      const page = await listConversationMessages({
        phoneE164,
        tenantId: identity.tenantId,
        ...(pageParam ? { cursor: pageParam } : {}),
        signal,
      });
      assertCurrentSmsIdentity(identity);
      return page;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    select: (data) => {
      mergeSmsMessagePages(data.pages);
      return data;
    },
  });
  const refreshFirstPage = useSmsFirstPageRefresh(client, key, updatePollState);
  const fetchHead = useCallback(
    async (signal: AbortSignal) => {
      const identity = identityOrThrow(access.canRequest, access.identity);
      const head = await listConversationMessages({
        phoneE164,
        tenantId: identity.tenantId,
        signal,
      });
      assertCurrentSmsIdentity(identity);
      return head;
    },
    [access.canRequest, access.identity, phoneE164],
  );
  useSmsHeadRefresh({
    enabled: access.canRequest && Boolean(phoneE164),
    queryKey: key,
    fetchHead,
    pollStateRef,
    updatePollState,
  });
  useEffect(
    () => () => {
      void client.cancelQueries({ queryKey: key, exact: true });
      client.removeQueries({ queryKey: key, exact: true });
    },
    [client, key],
  );
  return { ...query, refreshFirstPage, pollState };
}

export function useSmsConversationContext(
  phoneE164: string,
  access: SmsInboxAccess,
) {
  const client = useQueryClient();
  const gate = { enabled: access.canRequest };
  useRetireSmsQueries(access);
  const key = useMemo(
    () =>
      [
        SMS_CONTEXT_KEY,
        access.identity?.fingerprint ?? null,
        phoneE164,
      ] as const,
    [access.identity?.fingerprint, phoneE164],
  );
  const query = useQuery({
    queryKey: key,
    enabled: gate.enabled && Boolean(phoneE164),
    queryFn: async ({ signal }) => {
      const identity = identityOrThrow(access.canRequest, access.identity);
      const context = await getConversationContext({
        phoneE164,
        tenantId: identity.tenantId,
        signal,
      });
      assertCurrentSmsIdentity(identity);
      return context;
    },
    staleTime: 10_000,
  });
  useEffect(
    () => () => {
      void client.cancelQueries({ queryKey: key, exact: true });
      client.removeQueries({ queryKey: key, exact: true });
    },
    [client, key],
  );
  return query;
}

export function useSmsSenders(access: SmsInboxAccess) {
  const gate = { enabled: access.canRequest };
  useRetireSmsQueries(access);
  return useQuery({
    queryKey: [SMS_SENDERS_KEY, access.identity?.fingerprint ?? null],
    enabled: gate.enabled,
    queryFn: async ({ signal }) => {
      const identity = identityOrThrow(access.canRequest, access.identity);
      const senders = await listSmsSenders({
        tenantId: identity.tenantId,
        signal,
      });
      assertCurrentSmsIdentity(identity);
      return senders;
    },
    staleTime: 30_000,
  });
}

export interface SmsReplyIntent {
  body: string;
  senderProfileId: string;
  listId: string;
  idempotencyKey: string;
}

export function useSmsReply(phoneE164: string, access: SmsInboxAccess) {
  const client = useQueryClient();
  const controller = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [access.canRequest, access.identity?.fingerprint],
  );
  return useMutation<SmsReplyResponse, Error, SmsReplyIntent>({
    mutationKey: [
      "sms-reply-v2",
      access.identity?.fingerprint ?? null,
      phoneE164,
    ],
    mutationFn: async (intent) => {
      const identity = identityOrThrow(access.canRequest, access.identity);
      controller.current?.abort();
      controller.current = new AbortController();
      const result = await replyToConversation({
        phoneE164,
        tenantId: identity.tenantId,
        senderProfileId: intent.senderProfileId,
        listId: intent.listId,
        body: intent.body,
        idempotencyKey: intent.idempotencyKey,
        signal: controller.current.signal,
      });
      assertCurrentSmsIdentity(identity);
      return result;
    },
    onSuccess: () => {
      void client.resetQueries({
        queryKey: [
          SMS_THREAD_KEY,
          access.identity?.fingerprint ?? null,
          phoneE164,
        ],
        exact: true,
      });
      void client.invalidateQueries({ queryKey: [SMS_CONVERSATIONS_KEY] });
      void client.invalidateQueries({
        queryKey: [
          SMS_CONTEXT_KEY,
          access.identity?.fingerprint ?? null,
          phoneE164,
        ],
      });
    },
  });
}

export function useMarkConversationRead(access: SmsInboxAccess) {
  const client = useQueryClient();
  const controller = useRef<AbortController | null>(null);
  useEffect(
    () => () => controller.current?.abort(),
    [access.canRequest, access.identity?.fingerprint],
  );
  return useMutation<
    { ok: true; applied: number },
    Error,
    { phoneE164: string; messageIds: string[] }
  >({
    mutationFn: async ({ phoneE164, messageIds }) => {
      const identity = identityOrThrow(access.canRequest, access.identity);
      controller.current?.abort();
      controller.current = new AbortController();
      const receipt = await markConversationRead({
        phoneE164,
        messageIds,
        signal: controller.current.signal,
      });
      assertCurrentSmsIdentity(identity);
      return receipt;
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: [SMS_CONVERSATIONS_KEY] });
    },
  });
}
