// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Retry a terminally failed outbound SMS (desktop components/sms/
// MessageBubble.tsx:267-283 + pages/SMSInbox.tsx retry confirm). Confirms
// with the recipient, the retained body and an eligible-list select, then
// creates ONE new outbound intent under one durable key through
// POST /api/v1/sms/conversations/{phone}/reply — the failed record stays in
// history. The retained web message projection carries no sender_profile_id
// (sms-inbox-contract.ts drops it), so the confirm also asks for the approved
// sender to retry from instead of silently reusing an unknown one.
//
// Release hold: the conversation context's `replyDispatchAvailable:false`
// keeps the confirm disabled with the hold sentence; no request is made.

import { useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { apiErrorMessage } from "@/lib/api";
import { STALE } from "@/lib/query-keys";
import {
  getSmsConversationContext,
  listSmsSenders,
  type SmsReplyOutcome,
} from "@/lib/sms-api";
import type { SmsConversationMessage } from "@/lib/sms-inbox-contract";
import { safeSmsText } from "@/lib/sms-inbox-contract";
import {
  eligibleSmsSenders,
  smsReplyDispatchHoldCopy,
  smsReplyRecoveryHoldCopy,
  type SmsReplyRequest,
} from "@/lib/sms-reply-intent";
import { useSmsReplyDispatch } from "./use-sms-reply-dispatch";

/** Terminal provider-reported failures (desktop statusMeta "is-failed"). */
const FAILED_STATUSES = new Set(["failed", "undelivered", "error"]);

export function isRetryableSmsMessage(
  message: Pick<SmsConversationMessage, "direction" | "status" | "body_omitted_reason">,
): boolean {
  return (
    message.direction === "outbound" &&
    FAILED_STATUSES.has(message.status) &&
    !message.body_omitted_reason
  );
}

export interface RetryFailedSmsButtonProps {
  tenantId: string;
  phoneE164: string;
  message: SmsConversationMessage;
  /** Opaque tenant + user scope for the durable intent checkpoint. */
  intentScope: string | null;
  online: string;
  /** Opaque, caller-owned key prefix (never containing the raw phone). */
  queryBase: readonly unknown[];
  onRetried: (
    outcome: Extract<SmsReplyOutcome, { disposition: "persisted" }>,
  ) => void;
}

export function RetryFailedSmsButton({
  tenantId,
  phoneE164,
  message,
  intentScope,
  online,
  queryBase,
  onRetried,
}: RetryFailedSmsButtonProps) {
  const [open, setOpen] = useState(false);
  const [listId, setListId] = useState("");
  const [senderId, setSenderId] = useState("");
  const listFieldId = useId();
  const senderFieldId = useId();
  const reasonId = useId();
  const { dispatch, sending, reconciling, recoveryHold, reset } =
    useSmsReplyDispatch({ intentScope });

  const contextKey = useMemo(
    () => [...queryBase, "retry-context"] as const,
    [queryBase],
  );
  const sendersKey = useMemo(
    () => [...queryBase, "retry-senders"] as const,
    [queryBase],
  );
  const contextQuery = useQuery({
    queryKey: contextKey,
    enabled: open && online !== "offline",
    queryFn: ({ signal }) =>
      getSmsConversationContext({ tenantId, phoneE164, signal }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const sendersQuery = useQuery({
    queryKey: sendersKey,
    enabled: open && online !== "offline",
    queryFn: () => listSmsSenders(),
    staleTime: STALE.list,
    retry: false,
  });

  if (!isRetryableSmsMessage(message)) return null;

  const context = contextQuery.data ?? null;
  const senders = sendersQuery.data
    ? eligibleSmsSenders(
        Array.isArray(sendersQuery.data.items) ? sendersQuery.data.items : [],
      )
    : null;
  const eligibleLists = Array.isArray(context?.eligibleLists)
    ? context.eligibleLists
    : [];
  const effectiveListId =
    listId || (eligibleLists.length === 1 ? (eligibleLists[0]?.id ?? "") : "");
  const effectiveSenderId =
    senderId && senders?.some((sender) => sender.id === senderId)
      ? senderId
      : (senders?.[0]?.id ?? "");
  const dispatchAvailable = context?.replyDispatchAvailable === true;

  const retryUnavailableReason = sending
    ? "This retry is already being submitted."
    : reconciling
      ? "The retry outcome is being reconciled. Do not retry again."
      : recoveryHold
        ? "The stored send safeguard remains held until an authoritative terminal server result settles it."
        : online !== "online"
          ? "Reconnect before retrying. No request is made offline."
          : contextQuery.isPending
            ? "Wait for the consent context to load."
            : contextQuery.isError || context === null
              ? "Consent context could not be verified."
              : context.suppressed
                ? `This number has an authoritative ${context.suppressionReason ?? "system"} suppression. Retry is locked.`
                : !context.consentEvidenceSufficient ||
                    context.consentMixed ||
                    context.identityAmbiguous
                  ? "No complete timestamped consent evidence authorizes this retry."
                  : !dispatchAvailable
                    ? smsReplyDispatchHoldCopy(
                        context.replyDispatchUnavailableReason,
                      )
                    : eligibleLists.length === 0
                      ? "No exact eligible SMS list is recorded for this number."
                      : !effectiveListId
                        ? "Choose the exact eligible SMS list authorizing this retry."
                        : senders === null
                          ? "Wait for registered SMS senders to load."
                          : !effectiveSenderId
                            ? "No approved US/Canada sender is available to retry from."
                            : null;

  const close = () => {
    setOpen(false);
    setListId("");
    setSenderId("");
    reset();
  };

  const onConfirm = async () => {
    if (retryUnavailableReason !== null) return;
    const request: SmsReplyRequest = {
      sender_profile_id: effectiveSenderId,
      body: message.body,
      list_id: effectiveListId,
      ...(message.media_url ? { media_url: message.media_url } : {}),
    };
    const result = await dispatch(phoneE164, request);
    if (!result) return;
    if (result.kind === "persisted") {
      if (result.checkpointCleared) {
        toast.success("Retry persisted with a provider receipt");
      } else {
        toast.error("Retry persisted, but the local safeguard remains held", {
          description:
            "A persisted provider receipt was returned, but the stored checkpoint could not be cleared. Do not retry again.",
        });
      }
      onRetried(result.outcome);
      close();
      return;
    }
    if (result.kind === "reconciling") {
      toast.error("Retry outcome is being reconciled", {
        description: result.detail,
      });
      close();
      return;
    }
    if (result.kind === "held") {
      toast.error("Retry intent remains held", { description: result.detail });
      return;
    }
    toast.error(result.detail);
    close();
  };

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="min-h-11"
        disabled={online !== "online"}
        onClick={() => setOpen(true)}
      >
        Retry
      </Button>
      {open ? (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next && !sending) close();
          }}
        >
          <DialogContent closeDisabled={sending}>
            <DialogHeader>
              <DialogTitle>
                {recoveryHold
                  ? "Retry intent remains held"
                  : "Retry this failed SMS?"}
              </DialogTitle>
              <DialogDescription>
                {recoveryHold
                  ? "The stored checkpoint has no authoritative server expiry or retention guarantee. It remains held until a terminal server result settles it; another request is disabled."
                  : "This creates another outbound delivery attempt with one durable intent key and may incur another carrier charge. The failed record remains in history."}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <p>
                <span className="text-xs text-muted-foreground">Recipient</span>
                <br />
                <strong className="font-mono">
                  <bdi dir="ltr">{phoneE164}</bdi>
                </strong>
              </p>
              <p>
                <span className="text-xs text-muted-foreground">Message</span>
                <br />
                <bdi dir="auto" className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {safeSmsText(message.body, 4_800)}
                </bdi>
              </p>
              <div className="space-y-1">
                <Label htmlFor={listFieldId}>Eligible consent list</Label>
                <Select
                  id={listFieldId}
                  value={effectiveListId}
                  disabled={sending || eligibleLists.length === 0}
                  onChange={(event) => setListId(event.target.value)}
                >
                  <option value="">
                    {contextQuery.isPending
                      ? "Verifying eligibility…"
                      : eligibleLists.length === 0
                        ? "No eligible list recorded"
                        : "Choose an eligible list…"}
                  </option>
                  {eligibleLists.map((list) => (
                    <option key={list.id} value={list.id}>
                      {list.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor={senderFieldId}>Retry from sender</Label>
                <Select
                  id={senderFieldId}
                  value={effectiveSenderId}
                  disabled={sending || !senders || senders.length === 0}
                  onChange={(event) => setSenderId(event.target.value)}
                >
                  {senders === null ? (
                    <option value="">Loading senders…</option>
                  ) : senders.length === 0 ? (
                    <option value="">No approved senders available</option>
                  ) : (
                    senders.map((sender) => (
                      <option key={sender.id} value={sender.id}>
                        {sender.phone_number ?? sender.id}
                      </option>
                    ))
                  )}
                </Select>
                <p className="text-xs text-muted-foreground">
                  The retained message record does not carry its original
                  sender; the retry is sent from the approved sender chosen
                  here.
                </p>
              </div>
              {contextQuery.isError ? (
                <p role="alert" className="text-destructive">
                  Consent context could not be loaded.{" "}
                  {apiErrorMessage(contextQuery.error)}
                </p>
              ) : null}
              {sendersQuery.isError ? (
                <p role="alert" className="text-destructive">
                  Registered SMS senders could not be loaded.{" "}
                  {apiErrorMessage(sendersQuery.error)}
                </p>
              ) : null}
              {context && !dispatchAvailable ? (
                <p
                  role="status"
                  className="rounded-md border border-warning/40 bg-warning/10 p-2"
                >
                  {smsReplyDispatchHoldCopy(
                    context.replyDispatchUnavailableReason,
                  )}
                </p>
              ) : null}
              {recoveryHold ? (
                <p
                  role="alert"
                  className="rounded-md border border-warning/40 bg-warning/10 p-2"
                >
                  {smsReplyRecoveryHoldCopy(recoveryHold.reason)}
                </p>
              ) : null}
              {retryUnavailableReason ? (
                <p
                  id={reasonId}
                  role="status"
                  className="text-xs text-muted-foreground"
                >
                  {retryUnavailableReason}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="ghost" disabled={sending}>
                  Do not retry
                </Button>
              </DialogClose>
              <Button
                type="button"
                disabled={retryUnavailableReason !== null}
                aria-describedby={retryUnavailableReason ? reasonId : undefined}
                loading={sending}
                onClick={() => void onConfirm()}
              >
                {recoveryHold
                  ? "Retry held"
                  : sending
                    ? "Retrying…"
                    : "Retry SMS"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
