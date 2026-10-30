/**
 * useSmsThreadComposer — the reply half of the SMS thread screen.
 *
 * `app/(tabs)/sms/[phone].tsx` renders a thread AND owns a send path with a
 * persistent, encrypted safety hold. Those are two jobs, and the second one is
 * by far the larger: choosing a sender and an opted-in list, inspecting the
 * held reply intent, dispatching, and then honestly reporting an outcome the
 * provider may have left uncertain. This hook is that second job.
 *
 * WHAT LIVES WHERE. Everything here needs react state or the intent store, so
 * it is a hook. Everything it needs to DECIDE — the lock sentence, the failure
 * sentence — is in the pure `@/lib/smsThreadCopy`, which imports no react and
 * is unit-tested in the node vitest environment.
 *
 * THE INVARIANT THIS HOOK EXISTS TO KEEP: a reply is never sent while an
 * unresolved hold exists, and a hold is only cleared on evidence. Every branch
 * below either retires the hold because the server gave a DEFINITIVE
 * pre-provider refusal, or leaves it standing and says sending is locked. There
 * is no branch that clears a hold to make the screen look tidier.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ToastOptions } from "@/components/Toast";
import type { SmsReplyIntent } from "@/hooks/useSmsInbox";
import { haptics } from "@/lib/haptics";
import {
  isDefinitivePreProviderSmsReplyError,
  isSupportedSmsReplyPhone,
  type SmsMessage,
  type SmsReplyResponse,
  type SmsSenderProfile,
} from "@/lib/smsConversation";
import {
  completeSmsReplyIntent,
  inspectSmsReplyIntent,
  markSmsReplyIntentReconciliation,
  prepareSmsReplyIntent,
  type SmsReplyIntentInspection,
  type SmsReplyIntentScope,
} from "@/lib/smsReplyIntentStore";
import {
  smsReplyFailureCopy,
  smsReplyIntentReason,
  smsReplySelectionReason,
} from "@/lib/smsThreadCopy";

/** Clears the encrypted hold, reporting which of the two outcomes happened. */
async function retireHold(
  scope: SmsReplyIntentScope,
  idempotencyKey: string,
): Promise<"retired" | "failed"> {
  try {
    await completeSmsReplyIntent(scope, idempotencyKey);
    return "retired";
  } catch {
    return "failed";
  }
}

export interface SmsThreadComposer {
  draft: string;
  setDraft: (value: string) => void;
  senderId: string;
  setSenderId: (value: string) => void;
  listId: string;
  setListId: (value: string) => void;
  /** The one sentence under the composer, or null when sending is available. */
  selectionReason: string | null;
  /** True when no encrypted reply hold and no storage failure is in the way. */
  holdsClear: boolean;
  send: () => Promise<void>;
}

export function useSmsThreadComposer(input: {
  phoneE164: string;
  identityFingerprint: string | null;
  roleAllowed: boolean;
  messages: readonly SmsMessage[];
  eligibleSenders: readonly SmsSenderProfile[];
  eligibleLists: readonly { id: string }[];
  blockReason: string | null;
  reply: { mutateAsync: (intent: SmsReplyIntent) => Promise<SmsReplyResponse> };
  toast: (options: ToastOptions) => void;
  /**
   * Called exactly once per PERSISTED send with the body that was sent.
   * Uncertain (reconciliation) and failed dispatches never fire it — the
   * quick-reply use counter must count real sends only.
   */
  onPersisted?: ((body: string) => void) | undefined;
}): SmsThreadComposer {
  const {
    phoneE164,
    identityFingerprint,
    roleAllowed,
    messages,
    eligibleSenders,
    eligibleLists,
    blockReason,
    reply,
    toast,
    onPersisted,
  } = input;

  const [draft, setDraft] = useState("");
  const [senderId, setSenderId] = useState("");
  const [listId, setListId] = useState("");
  const [intentInspection, setIntentInspection] =
    useState<SmsReplyIntentInspection>({
      status: "none",
    });
  const [intentLoading, setIntentLoading] = useState(false);
  const [intentStorageError, setIntentStorageError] = useState<string | null>(
    null,
  );
  const mountedRef = useRef(true);

  const intentScope = useMemo(
    () =>
      identityFingerprint && isSupportedSmsReplyPhone(phoneE164)
        ? { identityFingerprint, phoneE164 }
        : null,
    [identityFingerprint, phoneE164],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    setDraft("");
    setSenderId("");
    setListId("");
    setIntentStorageError(null);
  }, [identityFingerprint, phoneE164]);
  useEffect(() => {
    let active = true;
    if (!intentScope || !roleAllowed) {
      setIntentInspection({ status: "none" });
      setIntentLoading(false);
      return () => {
        active = false;
      };
    }
    setIntentLoading(true);
    void inspectSmsReplyIntent(intentScope).then(
      (inspection) => {
        if (!active) return;
        setIntentInspection(inspection);
        setIntentStorageError(null);
        setIntentLoading(false);
      },
      () => {
        if (!active) return;
        setIntentStorageError(
          "Secure reply recovery is unavailable — nothing can be sent",
        );
        setIntentLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [roleAllowed, intentScope]);
  useEffect(() => {
    const preferred = [...messages]
      .reverse()
      .find(
        (message) => message.direction === "inbound" && message.senderProfileId,
      )?.senderProfileId;
    setSenderId((current) => {
      if (eligibleSenders.some((sender) => sender.id === current))
        return current;
      if (
        preferred &&
        eligibleSenders.some((sender) => sender.id === preferred)
      )
        return preferred;
      return eligibleSenders.length === 1 ? (eligibleSenders[0]?.id ?? "") : "";
    });
  }, [eligibleSenders, messages]);
  useEffect(() => {
    setListId((current) => {
      if (eligibleLists.some((list) => list.id === current)) return current;
      return eligibleLists.length === 1 ? (eligibleLists[0]?.id ?? "") : "";
    });
  }, [eligibleLists]);

  const intentReason = smsReplyIntentReason({
    storageError: intentStorageError,
    loading: intentLoading,
    inspection: intentInspection,
  });
  const selectionReason = smsReplySelectionReason({
    intentReason,
    blockReason,
    senderId,
    senderCount: eligibleSenders.length,
    listId,
    listCount: eligibleLists.length,
  });

  const send = useCallback(async () => {
    const body = draft.trim();
    if (!body || selectionReason || !senderId || !listId || !intentScope)
      return;
    let prepared: Awaited<ReturnType<typeof prepareSmsReplyIntent>> | null =
      null;
    let networkStarted = false;
    try {
      prepared = await prepareSmsReplyIntent({
        scope: intentScope,
        senderProfileId: senderId,
        listId,
        body,
      });
      if (!mountedRef.current) return;
      setIntentInspection({
        status: "current",
        record: prepared,
      });
      networkStarted = true;
      const result = await reply.mutateAsync({
        body,
        senderProfileId: senderId,
        listId,
        idempotencyKey: prepared.idempotencyKey,
      });
      if (result.disposition === "reconciliation_required") {
        let held: Awaited<ReturnType<typeof markSmsReplyIntentReconciliation>> =
          {
            ...prepared,
            state: "reconciliation_required",
          };
        try {
          held = await markSmsReplyIntentReconciliation(
            intentScope,
            prepared.idempotencyKey,
          );
        } catch {
          if (mountedRef.current) {
            setIntentStorageError(
              "Provider outcome is reconciling and the encrypted hold could not be updated. Do not retry.",
            );
          }
        }
        if (!mountedRef.current) return;
        setIntentInspection({
          status: "current",
          record: held,
        });
        haptics.error();
        toast({
          kind: "warning",
          message: `${result.providerReceipt.provider} returned an uncertain dispatch receipt. Keep the draft visible and do not retry it.`,
        });
        return;
      }
      try {
        await completeSmsReplyIntent(intentScope, prepared.idempotencyKey);
      } catch {
        if (!mountedRef.current) return;
        setIntentStorageError(
          "Reply persisted, but its encrypted safety record could not be cleared. Do not send another reply yet.",
        );
        toast({
          kind: "warning",
          message: `${result.providerReceipt.provider} persisted the reply, but local safety cleanup failed.`,
        });
        return;
      }
      if (!mountedRef.current) return;
      setDraft("");
      setIntentInspection({ status: "none" });
      haptics.success();
      toast({
        kind: "success",
        message: `${result.providerReceipt.provider} recorded the reply as ${result.providerReceipt.status}.`,
      });
      onPersisted?.(body);
    } catch (error) {
      if (!networkStarted) {
        if (!mountedRef.current) return;
        setIntentStorageError(
          error instanceof Error
            ? error.message
            : "Secure reply recovery is unavailable — nothing was sent",
        );
        haptics.error();
        toast({
          kind: "error",
          message:
            "Reply was not sent because its encrypted recovery key could not be committed.",
        });
        return;
      }
      haptics.error();
      let holdRetired = false;
      let holdCleanupFailed = false;
      if (prepared && isDefinitivePreProviderSmsReplyError(error)) {
        const outcome = await retireHold(intentScope, prepared.idempotencyKey);
        holdRetired = outcome === "retired";
        holdCleanupFailed = outcome === "failed";
        if (mountedRef.current) {
          if (holdRetired) {
            setIntentInspection({ status: "none" });
            setIntentStorageError(null);
          } else {
            setIntentStorageError(
              "Nothing was sent, but the encrypted safety hold could not be cleared. Sending remains locked.",
            );
          }
        }
      }
      if (!mountedRef.current) return;
      toast(smsReplyFailureCopy({ error, holdRetired, holdCleanupFailed }));
    }
  }, [
    draft,
    intentScope,
    listId,
    onPersisted,
    reply,
    selectionReason,
    senderId,
    toast,
  ]);

  return {
    draft,
    setDraft,
    senderId,
    setSenderId,
    listId,
    setListId,
    selectionReason,
    holdsClear:
      !intentStorageError &&
      !intentLoading &&
      intentInspection.status === "none",
    send,
  };
}
