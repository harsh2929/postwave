/**
 * useSmsConversationMeta — tags, internal notes, and the activity feed for one
 * SMS conversation.
 *
 * NOTES AND THE LIFECYCLE TOKEN. The notes write is CAS'd on the
 * conversation's lifecycle token, but the thread screen has no conversation
 * summary (the stamps live on the LIST row, which a deep link never loaded).
 * So the save is two press-driven steps: fetch the current token by asking
 * the server-side search for this exact phone, then write with it. A 409
 * still surfaces honestly — it means the state moved BETWEEN those two steps
 * (or the search could not see the row), which is exactly the race the CAS
 * exists to name; pressing Save again re-fetches a fresh token.
 *
 * NEVER QUEUED, like every other inbox write: a tag or handoff note landing
 * twenty minutes late describes a conversation someone else has re-triaged.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import {
  addSmsConversationTag,
  fetchSmsLifecycleToken,
  getSmsConversationActivity,
  listSmsConversationTags,
  removeSmsConversationTag,
  setSmsConversationNotes,
} from "@/api/smsConversationMeta";
import {
  assertCurrentSmsIdentity,
  identityOrThrow,
  SMS_CONVERSATION_META_KEY,
  useRetireSmsQueries,
  type SmsInboxAccess,
} from "@/hooks/useSmsInbox";
import type {
  SmsNotesReceipt,
  SmsTagMutationReceipt,
} from "@/lib/smsConversationMeta";

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

export function useSmsConversationTags(
  phoneE164: string,
  access: SmsInboxAccess,
) {
  useRetireSmsQueries(access);
  return useQuery({
    queryKey: [
      SMS_CONVERSATION_META_KEY,
      access.identity?.fingerprint ?? null,
      phoneE164,
      "tags",
    ] as const,
    enabled: access.canRequest && Boolean(phoneE164),
    queryFn: async ({ signal }) => {
      const identity = identityOrThrow(access.canRequest, access.identity);
      const page = await listSmsConversationTags({
        tenantId: identity.tenantId,
        phoneE164,
        signal,
      });
      assertCurrentSmsIdentity(identity);
      return page;
    },
    staleTime: 15_000,
  });
}

export function useSmsConversationActivity(
  phoneE164: string,
  access: SmsInboxAccess,
  enabled: boolean,
) {
  useRetireSmsQueries(access);
  return useQuery({
    queryKey: [
      SMS_CONVERSATION_META_KEY,
      access.identity?.fingerprint ?? null,
      phoneE164,
      "activity",
    ] as const,
    // `enabled` keeps the read press-driven: the collapsible section fetches
    // when opened, not on every thread mount.
    enabled: access.canRequest && Boolean(phoneE164) && enabled,
    queryFn: async ({ signal }) => {
      const identity = identityOrThrow(access.canRequest, access.identity);
      const feed = await getSmsConversationActivity({
        tenantId: identity.tenantId,
        phoneE164,
        signal,
      });
      assertCurrentSmsIdentity(identity);
      return feed;
    },
    staleTime: 30_000,
  });
}

export type SmsTagIntent =
  | { action: "add"; tag: string }
  | { action: "remove"; tag: string; expectedCreatedAt: string };

export function useSmsTagMutations(phoneE164: string, access: SmsInboxAccess) {
  const client = useQueryClient();
  const withController = useWriteControllers(access);
  return useMutation<SmsTagMutationReceipt, Error, SmsTagIntent>({
    mutationKey: [
      "sms-tag-mutation-v1",
      access.identity?.fingerprint ?? null,
      phoneE164,
    ],
    mutationFn: async (intent) => {
      const identity = identityOrThrow(access.canRequest, access.identity);
      const receipt = await withController((signal) =>
        intent.action === "add"
          ? addSmsConversationTag({
              tenantId: identity.tenantId,
              phoneE164,
              tag: intent.tag,
              signal,
            })
          : removeSmsConversationTag({
              tenantId: identity.tenantId,
              phoneE164,
              tag: intent.tag,
              expectedCreatedAt: intent.expectedCreatedAt,
              signal,
            }),
      );
      assertCurrentSmsIdentity(identity);
      return receipt;
    },
    onSettled: () => {
      // Settled, not success: a 409 means THIS device's inventory is stale,
      // so refreshing it is most needed on the failure path.
      void client.invalidateQueries({
        queryKey: [
          SMS_CONVERSATION_META_KEY,
          access.identity?.fingerprint ?? null,
          phoneE164,
          "tags",
        ],
      });
    },
  });
}

export function useSmsNotesSave(phoneE164: string, access: SmsInboxAccess) {
  const withController = useWriteControllers(access);
  return useMutation<SmsNotesReceipt, Error, { notes: string }>({
    mutationKey: [
      "sms-notes-save-v1",
      access.identity?.fingerprint ?? null,
      phoneE164,
    ],
    mutationFn: async ({ notes }) => {
      const identity = identityOrThrow(access.canRequest, access.identity);
      const receipt = await withController(async (signal) => {
        const expectedUpdatedAt = await fetchSmsLifecycleToken({
          tenantId: identity.tenantId,
          phoneE164,
          signal,
        });
        return setSmsConversationNotes({
          tenantId: identity.tenantId,
          phoneE164,
          notes,
          expectedUpdatedAt,
          signal,
        });
      });
      assertCurrentSmsIdentity(identity);
      return receipt;
    },
  });
}
