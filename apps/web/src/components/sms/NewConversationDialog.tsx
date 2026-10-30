// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Start a brand-new outbound SMS thread (desktop pages/SMSInbox.tsx
// NewConversationModal). Recipient (US/Canada only), an approved sender from
// GET /api/v1/sms/senders, the exact eligible consent list and dispatch
// verdict from GET /api/v1/sms/conversations/{phone}/context (debounced as
// the number is typed), a body with segment math — then the same
// POST /api/v1/sms/conversations/{phone}/reply as the composer, under the
// same durable intent key and the same release hold.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { smsBroadcastSegmentInfo } from "@/app/(dashboard)/app/sms/sms-broadcast-helpers";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api";
import { STALE } from "@/lib/query-keys";
import { getSmsConversationContext, listSmsSenders } from "@/lib/sms-api";
import type { SmsConversationContext } from "@/lib/sms-conversation-lookup-contract";
import {
  eligibleSmsSenders,
  normalizeSmsUsCa,
  smsReplyBodyConstraint,
  smsReplyDispatchHoldCopy,
  smsReplyReconciliationCopy,
  smsReplyRecoveryHoldCopy,
  type SmsReplyRequest,
} from "@/lib/sms-reply-intent";
import { useSmsReplyDispatch } from "./use-sms-reply-dispatch";

const CONTEXT_DEBOUNCE_MS = 300;

export interface NewConversationDialogProps {
  tenantId: string;
  /** Opaque tenant + user scope for the durable intent checkpoint. */
  intentScope: string | null;
  online: string;
  /** Opaque, caller-owned key prefix for the sender read. */
  queryBase: readonly unknown[];
  onClose: () => void;
  onSent: (phoneE164: string) => void;
}

export function NewConversationDialog({
  tenantId,
  intentScope,
  online,
  queryBase,
  onClose,
  onSent,
}: NewConversationDialogProps) {
  const [phone, setPhone] = useState("");
  const [senderId, setSenderId] = useState("");
  const [listId, setListId] = useState("");
  const [body, setBody] = useState("");
  const [context, setContext] = useState<SmsConversationContext | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const contextSeq = useRef(0);
  const phoneId = useId();
  const senderFieldId = useId();
  const listFieldId = useId();
  const bodyFieldId = useId();
  const counterId = useId();
  const availabilityId = useId();
  const { dispatch, sending, reconciling, recoveryHold } = useSmsReplyDispatch({
    intentScope,
  });

  const sendersKey = useMemo(
    () => [...queryBase, "new-conversation", "senders"] as const,
    [queryBase],
  );
  const sendersQuery = useQuery({
    queryKey: sendersKey,
    enabled: online !== "offline",
    queryFn: () => listSmsSenders(),
    staleTime: STALE.list,
    retry: false,
  });
  const senders = useMemo(
    () =>
      sendersQuery.data
        ? eligibleSmsSenders(
            Array.isArray(sendersQuery.data.items)
              ? sendersQuery.data.items
              : [],
          )
        : null,
    [sendersQuery.data],
  );
  useEffect(() => {
    if (!senders) return;
    setSenderId((current) =>
      current && senders.some((sender) => sender.id === current)
        ? current
        : (senders[0]?.id ?? ""),
    );
  }, [senders]);

  const normalizedPhone = normalizeSmsUsCa(phone);
  useEffect(() => {
    contextSeq.current += 1;
    setContext(null);
    setContextError(null);
    setListId("");
    if (!normalizedPhone || online === "offline") {
      setContextLoading(false);
      return;
    }
    const seq = contextSeq.current;
    const controller = new AbortController();
    setContextLoading(true);
    const timer = window.setTimeout(() => {
      void getSmsConversationContext({
        tenantId,
        phoneE164: normalizedPhone,
        signal: controller.signal,
      })
        .then((verified) => {
          if (controller.signal.aborted || seq !== contextSeq.current) return;
          setContext(verified);
          const lists = Array.isArray(verified.eligibleLists)
            ? verified.eligibleLists
            : [];
          if (lists.length === 1) setListId(lists[0]?.id ?? "");
        })
        .catch((caught: unknown) => {
          if (controller.signal.aborted || seq !== contextSeq.current) return;
          setContextError(
            `Consent eligibility could not be verified for this number. ${apiErrorMessage(caught)}`,
          );
        })
        .finally(() => {
          if (!controller.signal.aborted && seq === contextSeq.current) {
            setContextLoading(false);
          }
        });
    }, CONTEXT_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [normalizedPhone, online, tenantId]);

  const e164 = normalizedPhone ?? "";
  const validPhone = normalizedPhone !== null;
  const bodyConstraint = smsReplyBodyConstraint(body);
  const segment = smsBroadcastSegmentInfo(body);
  const optedOut = context?.consentStatus === "opted_out";
  const suppressed = context?.suppressed === true;
  const eligibleLists = Array.isArray(context?.eligibleLists)
    ? context.eligibleLists
    : [];
  const sendEligible =
    !sending &&
    !reconciling &&
    online === "online" &&
    validPhone &&
    context !== null &&
    !contextLoading &&
    contextError === null &&
    !optedOut &&
    !suppressed &&
    !context.consentMixed &&
    !context.identityAmbiguous &&
    context.consentEvidenceSufficient &&
    context.replyDispatchAvailable &&
    eligibleLists.some((list) => list.id === listId) &&
    bodyConstraint.error === null &&
    senderId !== "";
  const canSend = sendEligible && recoveryHold === null;
  const sendAvailability = sending
    ? "The send intent is being submitted. Keep this window open until its outcome is known."
    : reconciling
      ? smsReplyReconciliationCopy()
      : recoveryHold
        ? "The stored send safeguard remains held until an authoritative terminal server result settles it."
        : online !== "online"
          ? "Reconnect before sending. No request is made offline."
          : !validPhone
            ? "Enter a US/Canada phone with 10 digits (country code +1 is optional)."
            : contextLoading
              ? "Verifying authoritative consent eligibility…"
              : contextError
                ? contextError
                : context === null
                  ? "Wait for consent eligibility to be verified."
                  : suppressed
                    ? `This number has an authoritative ${context.suppressionReason ?? "system"} suppression.`
                    : context.identityAmbiguous
                      ? "Multiple subscriber identities are linked to this phone. Outbound SMS is locked."
                      : context.consentMixed
                        ? "Conflicting consent evidence is recorded for this phone. Outbound SMS is locked."
                        : !context.consentEvidenceSufficient
                          ? "No complete timestamped consent evidence authorizes outbound SMS."
                          : !context.replyDispatchAvailable
                            ? smsReplyDispatchHoldCopy(
                                context.replyDispatchUnavailableReason,
                              )
                            : optedOut
                              ? "The loaded consent record is revoked. A new outbound message is unavailable."
                              : eligibleLists.length === 0
                                ? "No exact eligible SMS list is recorded for this number."
                                : !listId
                                  ? "Choose the exact eligible SMS list authorizing this message."
                                  : bodyConstraint.error
                                    ? bodyConstraint.error
                                    : !senderId
                                      ? senders === null
                                        ? "Wait for approved sender profiles to load."
                                        : "Pick an approved US/Canada sender before sending."
                                      : null;

  const onSend = async () => {
    setError(null);
    if (!canSend) return;
    const request: SmsReplyRequest = {
      sender_profile_id: senderId,
      body: bodyConstraint.trimmed,
      list_id: listId,
    };
    const result = await dispatch(e164, request);
    if (!result) return;
    if (result.kind === "persisted") {
      if (!result.checkpointCleared) {
        setError(
          "The message persisted with a provider receipt, but the stored checkpoint could not be cleared. Do not resend it.",
        );
        return;
      }
      toast.success("Message persisted with a provider receipt");
      setPhone("");
      setBody("");
      onSent(e164);
      return;
    }
    setError(result.detail);
  };

  const closeDisabled = sending || reconciling;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !closeDisabled) onClose();
      }}
    >
      <DialogContent closeDisabled={closeDisabled}>
        <DialogHeader>
          <DialogTitle>New SMS conversation</DialogTitle>
          <DialogDescription>
            New outbound messages always send one exact list id to the
            authoritative consent gate. Aggregate status is not enough.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void onSend();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor={phoneId}>Recipient (US/Canada only)</Label>
            <Input
              id={phoneId}
              type="tel"
              placeholder="+1 202 555 0118"
              value={phone}
              autoComplete="off"
              disabled={closeDisabled}
              aria-invalid={phone.trim() !== "" && !validPhone}
              onChange={(event) => setPhone(event.target.value)}
            />
            {phone.trim() !== "" && !validPhone ? (
              <p className="text-xs text-destructive">
                Enter 10 US/Canada digits, optionally prefixed with country code
                +1 — for example +1 202 555 0118.
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={senderFieldId}>From sender</Label>
            <Select
              id={senderFieldId}
              value={senderId}
              disabled={
                senders === null || senders.length === 0 || closeDisabled
              }
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
            {sendersQuery.isError ? (
              <p role="alert" className="text-xs text-destructive">
                Couldn&apos;t load senders: {apiErrorMessage(sendersQuery.error)}
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={listFieldId}>Eligible consent list</Label>
            <Select
              id={listFieldId}
              value={listId}
              disabled={
                closeDisabled ||
                contextLoading ||
                suppressed ||
                eligibleLists.length === 0
              }
              onChange={(event) => setListId(event.target.value)}
            >
              <option value="">
                {contextLoading
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
          <div className="space-y-1.5">
            <Label htmlFor={bodyFieldId}>Message</Label>
            <Textarea
              id={bodyFieldId}
              rows={4}
              placeholder="Type the first message…"
              value={body}
              disabled={closeDisabled}
              aria-invalid={body.length > 0 && bodyConstraint.error !== null}
              aria-describedby={counterId}
              onChange={(event) => setBody(event.target.value)}
            />
            <p
              id={counterId}
              className="text-xs tabular-nums text-muted-foreground"
            >
              {bodyConstraint.runes.toLocaleString()} characters ·{" "}
              {bodyConstraint.bytes.toLocaleString()} UTF-8 bytes ·{" "}
              {segment.segments} billable segment
              {segment.segments === 1 ? "" : "s"}
              {segment.encoding === "ucs2" ? " · UCS-2 encoding" : ""}
            </p>
          </div>
          {context && !context.replyDispatchAvailable ? (
            <p
              role="status"
              className="rounded-md border border-warning/40 bg-warning/10 p-2 text-sm"
            >
              {smsReplyDispatchHoldCopy(context.replyDispatchUnavailableReason)}
            </p>
          ) : null}
          {recoveryHold ? (
            <p
              role="alert"
              className="rounded-md border border-warning/40 bg-warning/10 p-2 text-sm"
            >
              <strong>Stored send safeguard is holding this draft.</strong>{" "}
              {smsReplyRecoveryHoldCopy(recoveryHold.reason)}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {sendAvailability ? (
            <p
              id={availabilityId}
              role="status"
              className="text-xs text-muted-foreground"
            >
              {sendAvailability}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              className="min-h-10"
              disabled={closeDisabled}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="min-h-10"
              disabled={!canSend}
              aria-describedby={sendAvailability ? availabilityId : undefined}
              loading={sending}
            >
              {sending ? "Sending…" : "Send"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
