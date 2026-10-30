// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * One send attempt through the durable intent safeguard, shared by the reply
 * composer, the new-conversation dialog and the failed-message retry so the
 * three surfaces cannot diverge on what an unknown outcome means. Mirrors the
 * desktop ReplyComposer.onSend / NewConversationModal.onSend / SMSInbox.onRetry
 * sequence:
 *
 *   prepare checkpoint → POST with that key → classify →
 *     persisted            settle the checkpoint, report the receipt
 *     reconciliation       keep the checkpoint as `unknown`; the surface locks
 *     durable server hold  keep the checkpoint in that state; never replay
 *     explicit refusal     nothing reached a provider; settle and report why
 */

import { useCallback, useRef, useState } from "react";

import { replySmsConversation, type SmsReplyOutcome } from "@/lib/sms-api";
import {
  classifySmsReplyUncertainty,
  smsReplyReconciliationCopy,
  smsReplyRecoveryHoldCopy,
  smsReplyRefusalCopy,
  smsReplyUncertaintyCopy,
  type SmsReplyRequest,
} from "@/lib/sms-reply-intent";
import {
  smsReplyRecovery,
  type SmsReplyRecoveryHold,
  type SmsReplyRecoveryStore,
} from "@/lib/sms-reply-recovery";

export type SmsReplyDispatchResult =
  | {
      kind: "persisted";
      outcome: Extract<SmsReplyOutcome, { disposition: "persisted" }>;
      /** False when the receipt returned but the checkpoint could not be cleared. */
      checkpointCleared: boolean;
    }
  | { kind: "reconciling"; detail: string }
  | { kind: "held"; hold: SmsReplyRecoveryHold; detail: string }
  | { kind: "refused"; detail: string };

export function useSmsReplyDispatch({
  intentScope,
  store = smsReplyRecovery,
}: {
  /** Opaque tenant + user scope for the checkpoint; null = identity unresolved. */
  intentScope: string | null;
  store?: SmsReplyRecoveryStore;
}) {
  const [sending, setSending] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [recoveryHold, setRecoveryHold] = useState<SmsReplyRecoveryHold | null>(
    null,
  );
  const inFlight = useRef(false);

  const reset = useCallback(() => {
    setReconciling(false);
    setRecoveryHold(null);
  }, []);

  const dispatch = useCallback(
    async (
      phoneE164: string,
      request: SmsReplyRequest,
    ): Promise<SmsReplyDispatchResult | null> => {
      if (inFlight.current) return null;
      inFlight.current = true;
      setSending(true);
      try {
        const prepared = await store.prepare(intentScope, {
          phone: phoneE164,
          request,
        });
        if (prepared.status === "held") {
          setRecoveryHold(prepared);
          return {
            kind: "held",
            hold: prepared,
            detail: smsReplyRecoveryHoldCopy(prepared.reason),
          };
        }
        setRecoveryHold(null);
        const intent = prepared;
        let outcome: SmsReplyOutcome;
        try {
          outcome = await replySmsConversation({
            phoneE164,
            request,
            idempotencyKey: intent.idempotencyKey,
          });
        } catch (error) {
          const uncertainty = classifySmsReplyUncertainty(error);
          if (uncertainty) {
            const checkpointed =
              uncertainty === "request-identity-conflict"
                ? await store.markRequestIdentityConflict(
                    intentScope,
                    intent.signature,
                  )
                : uncertainty === "another-intent-pending"
                  ? await store.markAnotherIntentPending(
                      intentScope,
                      intent.signature,
                    )
                  : await store.markUnknown(intentScope, intent.signature);
            const hold: SmsReplyRecoveryHold | null = !checkpointed
              ? {
                  status: "held",
                  signature: intent.signature,
                  idempotencyKey: intent.idempotencyKey,
                  reason: "checkpoint-update-failed",
                }
              : uncertainty !== "outcome-unknown"
                ? {
                    status: "held",
                    signature: intent.signature,
                    idempotencyKey: intent.idempotencyKey,
                    reason: uncertainty,
                  }
                : null;
            setRecoveryHold(hold);
            setReconciling(uncertainty === "outcome-unknown");
            const detail = smsReplyUncertaintyCopy(uncertainty);
            return hold
              ? { kind: "held", hold, detail }
              : { kind: "reconciling", detail };
          }
          const cleared = await store.settle(intentScope, intent.signature);
          if (!cleared) {
            setRecoveryHold({
              status: "held",
              signature: intent.signature,
              idempotencyKey: intent.idempotencyKey,
              reason: "checkpoint-clear-failed",
            });
          }
          return { kind: "refused", detail: smsReplyRefusalCopy(error) };
        }
        if (outcome.disposition === "reconciliation_required") {
          const checkpointed = await store.markUnknown(
            intentScope,
            intent.signature,
          );
          if (!checkpointed) {
            setRecoveryHold({
              status: "held",
              signature: intent.signature,
              idempotencyKey: intent.idempotencyKey,
              reason: "checkpoint-update-failed",
            });
          }
          setReconciling(true);
          return { kind: "reconciling", detail: smsReplyReconciliationCopy() };
        }
        const cleared = await store.settle(intentScope, intent.signature);
        if (!cleared) {
          setRecoveryHold({
            status: "held",
            signature: intent.signature,
            idempotencyKey: intent.idempotencyKey,
            reason: "checkpoint-clear-failed",
          });
        }
        return { kind: "persisted", outcome, checkpointCleared: cleared };
      } catch {
        // The checkpoint itself could not be prepared (no storage, no
        // crypto). Nothing was sent.
        const hold: SmsReplyRecoveryHold = {
          status: "held",
          reason: "vault-unavailable",
        };
        setRecoveryHold(hold);
        return {
          kind: "held",
          hold,
          detail: smsReplyRecoveryHoldCopy("vault-unavailable"),
        };
      } finally {
        inFlight.current = false;
        setSending(false);
      }
    },
    [intentScope, store],
  );

  return { dispatch, sending, reconciling, recoveryHold, reset };
}
