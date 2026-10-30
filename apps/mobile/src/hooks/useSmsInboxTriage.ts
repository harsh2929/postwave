/**
 * useSmsInboxTriage — the SMS inbox's lifecycle and sender-state writes.
 *
 * Separate from `useSmsInbox` for the same reason `useSmsPolicies` is: that
 * module is the inbox's READ surface plus its reply path, and it is already
 * past this app's 450-line source budget. These are a different concern —
 * moving a conversation between the Active / Snoozed / Archived filters the
 * list already renders, and stopping a sender — so they get their own file.
 *
 * ROUTES, READ FROM THE MOUNT BLOCKS, NOT FROM A DOC:
 *   POST /api/v1/sms/conversations/{phone}/snooze|unsnooze|archive|unarchive|assign
 *        inbox_extras.go:54-58 — protectSMSInboxResponse + RequireExactTenantAdmin,
 *        the same chain `GET /api/v1/sms/conversations` already passes.
 *   POST /api/v1/sms/senders/{id}/pause|resume
 *        handlers.go:152-153 — RequireScope(ScopeAdmin).
 *
 * NONE OF THEM IS RELEASE-HELD. The SMS holds in handlers.go:83-119 are
 * dispatch (`smsLegacyDispatchReleaseReady`, `smsDispatchSagaReleaseReady`),
 * auto-reply, A2P registration, MMS readiness, the support mirror, provider
 * callbacks and the click resolver. `upsertConversationState` and
 * `setSenderPaused` carry no readiness guard, and mobile already performs a
 * write on the conversation route family (`replyToConversation`).
 *
 * NEVER QUEUED. The inbox is online-only by construction — `identityOrThrow`
 * refuses whenever `useSmsInboxAccess` has not cleared the current session —
 * and a lifecycle change that lands twenty minutes late re-buries a
 * conversation the operator has already dealt with by hand.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import {
  archiveConversation,
  assignConversation,
  setSmsSenderPaused,
  snoozeConversation,
  unarchiveConversation,
  unsnoozeConversation,
  type SmsConversationStateReceipt,
} from "@/api/smsInbox";
import {
  assertCurrentSmsIdentity,
  identityOrThrow,
  SMS_CONVERSATIONS_KEY,
  SMS_SENDERS_KEY,
  type SmsInboxAccess,
} from "@/hooks/useSmsInbox";

/**
 * Abort-on-unmount WITHOUT abort-on-next-call.
 *
 * `useSmsReply` and `useMarkConversationRead` abort the previous request before
 * starting the next one, which is right for them: a superseded read boundary or
 * a superseded draft has no value. It is WRONG for a lifecycle write. Archiving
 * three conversations in a row must archive three conversations, and aborting a
 * POST the server may already have committed would leave the operator believing
 * a row did not move when it did. So each call gets its own controller, and
 * only an identity change or unmount cancels them.
 */
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

/** The verbs behind the Active / Snoozed / Archived filters the inbox renders. */
export type SmsTriageIntent =
  | { action: "snooze"; phoneE164: string; until: string }
  | { action: "unsnooze"; phoneE164: string }
  | { action: "archive"; phoneE164: string }
  | { action: "unarchive"; phoneE164: string }
  | { action: "assign"; phoneE164: string; userId: string | null };

export function useSmsConversationTriage(access: SmsInboxAccess) {
  const client = useQueryClient();
  const withController = useWriteControllers(access);
  return useMutation<SmsConversationStateReceipt, Error, SmsTriageIntent>({
    mutationKey: [
      "sms-conversation-triage-v1",
      access.identity?.fingerprint ?? null,
    ],
    mutationFn: async (intent) => {
      const identity = identityOrThrow(access.canRequest, access.identity);
      const receipt = await withController(async (signal) => {
        const base = {
          phoneE164: intent.phoneE164,
          tenantId: identity.tenantId,
          signal,
        };
        switch (intent.action) {
          case "snooze":
            return snoozeConversation({ ...base, until: intent.until });
          case "unsnooze":
            return unsnoozeConversation(base);
          case "archive":
            return archiveConversation(base);
          case "unarchive":
            return unarchiveConversation(base);
          case "assign":
            return assignConversation({ ...base, userId: intent.userId });
        }
      });
      assertCurrentSmsIdentity(identity);
      return receipt;
    },
    onSuccess: () => {
      // Lifecycle moves a row BETWEEN filters, so every status slice is stale,
      // not only the one on screen.
      void client.invalidateQueries({ queryKey: [SMS_CONVERSATIONS_KEY] });
    },
  });
}

/**
 * Pause / resume one sender profile.
 *
 * Admin-only on the server and admin-only here: `identityOrThrow` refuses any
 * session `useSmsInboxAccess` did not clear for the inbox, so a viewer is never
 * shown a control whose only possible outcome is a 403.
 */
export function useSmsSenderPaused(access: SmsInboxAccess) {
  const client = useQueryClient();
  const withController = useWriteControllers(access);
  return useMutation<
    { id: string; paused: boolean },
    Error,
    { senderId: string; paused: boolean; reason?: string }
  >({
    mutationKey: ["sms-sender-paused-v1", access.identity?.fingerprint ?? null],
    mutationFn: async ({ senderId, paused, reason }) => {
      const identity = identityOrThrow(access.canRequest, access.identity);
      const result = await withController((signal) =>
        setSmsSenderPaused({
          senderId,
          tenantId: identity.tenantId,
          paused,
          ...(reason ? { reason } : {}),
          signal,
        }),
      );
      assertCurrentSmsIdentity(identity);
      return result;
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: [SMS_SENDERS_KEY] });
    },
  });
}
