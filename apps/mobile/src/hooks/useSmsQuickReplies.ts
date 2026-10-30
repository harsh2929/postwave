/**
 * useSmsQuickReplies — the canned-response library behind the thread
 * composer's picker.
 *
 * The list is press-driven (`enabled` comes from the caller — the picker
 * fetches when opened, not on every thread mount) and ranked by the server
 * (use_count DESC). Mutations are online-only like every inbox write. The
 * use-recording mutation deliberately swallows nothing: a failed bump is
 * reported to its caller, which treats it as non-fatal ranking drift, not as
 * a failed send.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import {
  createSmsQuickReply,
  deleteSmsQuickReply,
  listSmsQuickReplies,
  recordSmsQuickReplyUse,
} from "@/api/smsQuickReplies";
import {
  assertCurrentSmsIdentity,
  identityOrThrow,
  SMS_QUICK_REPLIES_KEY,
  useRetireSmsQueries,
  type SmsInboxAccess,
} from "@/hooks/useSmsInbox";
import type {
  SmsQuickReply,
  SmsQuickReplyDeleteReceipt,
  SmsQuickReplyUseReceipt,
} from "@/lib/smsQuickReply";

function useWriteControllers(access: SmsInboxAccess) {
  const controllers = useRef(new Set<AbortController>());
  useEffect(
    () => () => {
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
    },
    [access.canRequest, access.identity?.fingerprint],
  );
  return useCallback(async <T>(run: (signal: AbortSignal) => Promise<T>) => {
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      return await run(controller.signal);
    } finally {
      controllers.current.delete(controller);
    }
  }, []);
}

export function useSmsQuickReplies(access: SmsInboxAccess, enabled: boolean) {
  useRetireSmsQueries(access);
  return useQuery({
    queryKey: [
      SMS_QUICK_REPLIES_KEY,
      access.identity?.fingerprint ?? null,
    ] as const,
    enabled: access.canRequest && enabled,
    queryFn: async ({ signal }) => {
      const identity = identityOrThrow(access.canRequest, access.identity);
      const page = await listSmsQuickReplies({
        tenantId: identity.tenantId,
        signal,
      });
      assertCurrentSmsIdentity(identity);
      return page;
    },
    staleTime: 30_000,
  });
}

export type SmsQuickReplyWriteIntent =
  | { action: "create"; label: string; body: string }
  | { action: "delete"; id: string };

export function useSmsQuickReplyWrites(access: SmsInboxAccess) {
  const client = useQueryClient();
  const withController = useWriteControllers(access);
  return useMutation<
    SmsQuickReply | SmsQuickReplyDeleteReceipt,
    Error,
    SmsQuickReplyWriteIntent
  >({
    mutationKey: [
      "sms-quick-reply-write-v1",
      access.identity?.fingerprint ?? null,
    ],
    mutationFn: async (intent) => {
      const identity = identityOrThrow(access.canRequest, access.identity);
      const receipt = await withController<
        SmsQuickReply | SmsQuickReplyDeleteReceipt
      >((signal) =>
        intent.action === "create"
          ? createSmsQuickReply({
              tenantId: identity.tenantId,
              label: intent.label,
              body: intent.body,
              signal,
            })
          : deleteSmsQuickReply({
              tenantId: identity.tenantId,
              id: intent.id,
              signal,
            }),
      );
      assertCurrentSmsIdentity(identity);
      return receipt;
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: [SMS_QUICK_REPLIES_KEY] });
    },
  });
}

export function useSmsQuickReplyUse(access: SmsInboxAccess) {
  const client = useQueryClient();
  const withController = useWriteControllers(access);
  return useMutation<SmsQuickReplyUseReceipt, Error, { id: string }>({
    mutationKey: [
      "sms-quick-reply-use-v1",
      access.identity?.fingerprint ?? null,
    ],
    mutationFn: async ({ id }) => {
      const identity = identityOrThrow(access.canRequest, access.identity);
      const receipt = await withController((signal) =>
        recordSmsQuickReplyUse({
          tenantId: identity.tenantId,
          id,
          signal,
        }),
      );
      assertCurrentSmsIdentity(identity);
      return receipt;
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: [SMS_QUICK_REPLIES_KEY] });
    },
  });
}
