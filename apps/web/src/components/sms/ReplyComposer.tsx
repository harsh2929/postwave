// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Outbound reply composer for one SMS conversation (desktop
// components/sms/ReplyComposer.tsx). Sender select from
// GET /api/v1/sms/senders (approved US/CA live-provider profiles only),
// the exact eligible consent list and the dispatch verdict from
// GET /api/v1/sms/conversations/{phone}/context, a body with the server's
// segment/encoding math, Cmd/Ctrl+Enter to send, and one durable intent key
// per attempt through POST /api/v1/sms/conversations/{phone}/reply.
//
// Release hold: the context payload's `replyDispatchAvailable:false` (reason
// `sms_reply_dispatch_release_held` while the server's dispatch saga is held)
// keeps Send aria-disabled with the hold sentence as its description, and
// no request is made. Never bypassed here.

import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { smsBroadcastSegmentInfo } from "@/app/(dashboard)/app/sms/sms-broadcast-helpers";
import { SmsCharCount } from "@/app/(dashboard)/app/sms/sms-char-count";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api";
import { STALE } from "@/lib/query-keys";
import {
  getSmsConversationContext,
  listSmsSenders,
  recordSmsQuickReplyUse,
  type SmsReplyOutcome,
} from "@/lib/sms-api";
import type { SmsConversationContext } from "@/lib/sms-conversation-lookup-contract";
import {
  eligibleSmsSenders,
  SMS_REPLY_BODY_MAX_RUNES,
  smsReplyBodyConstraint,
  smsReplyDispatchHoldCopy,
  smsReplyReconciliationCopy,
  smsReplyRecoveryHoldCopy,
  type SmsReplyRequest,
} from "@/lib/sms-reply-intent";
import { QuickReplyPicker } from "./QuickReplyPicker";
import { useSmsReplyDispatch } from "./use-sms-reply-dispatch";

export interface ReplyComposerProps {
  tenantId: string;
  phoneE164: string;
  /** Opaque tenant + user scope for the durable intent checkpoint. */
  intentScope: string | null;
  online: string;
  /** Opaque, caller-owned key prefix (never containing the raw phone). */
  queryBase: readonly unknown[];
  onSent: (
    outcome: Extract<SmsReplyOutcome, { disposition: "persisted" }>,
  ) => void;
  /** External safety boundary the caller already knows about. */
  unavailableReason?: string;
  /** Extra controls rendered next to the saved-reply picker. */
  extraActions?: ReactNode;
}

function fmtPhone(phone: string | undefined): string {
  if (!phone) return "—";
  if (phone.startsWith("+1") && phone.length === 12) {
    return `+1 (${phone.slice(2, 5)}) ${phone.slice(5, 8)}-${phone.slice(8)}`;
  }
  return phone;
}

export function ReplyComposer({
  tenantId,
  phoneE164,
  intentScope,
  online,
  queryBase,
  onSent,
  unavailableReason,
  extraActions,
}: ReplyComposerProps) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const [senderId, setSenderId] = useState("");
  const [listId, setListId] = useState("");
  const [sourceQuickReplyId, setSourceQuickReplyId] = useState<string | null>(
    null,
  );
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const senderFieldId = useId();
  const listFieldId = useId();
  const bodyFieldId = useId();
  const counterId = useId();
  const sendDescriptionId = useId();
  const { dispatch, sending, reconciling, recoveryHold, reset } =
    useSmsReplyDispatch({ intentScope });

  const contextKey = useMemo(
    () => [...queryBase, "context"] as const,
    [queryBase],
  );
  const sendersKey = useMemo(
    () => [...queryBase, "senders"] as const,
    [queryBase],
  );
  const quickRepliesKey = useMemo(
    () => [...queryBase, "quick-replies"] as const,
    [queryBase],
  );

  const contextQuery = useQuery({
    queryKey: contextKey,
    enabled: online !== "offline",
    queryFn: ({ signal }) =>
      getSmsConversationContext({ tenantId, phoneE164, signal }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const sendersQuery = useQuery({
    queryKey: sendersKey,
    enabled: online !== "offline",
    queryFn: () => listSmsSenders(),
    staleTime: STALE.list,
    retry: false,
  });

  const context: SmsConversationContext | null = contextQuery.data ?? null;
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
  const eligibleLists = useMemo(
    () => (Array.isArray(context?.eligibleLists) ? context.eligibleLists : []),
    [context],
  );

  // A stale draft must never follow the operator to a different number.
  useEffect(() => {
    setBody("");
    setSourceQuickReplyId(null);
    reset();
  }, [phoneE164, reset]);

  useEffect(() => {
    if (!senders) return;
    setSenderId((current) =>
      current && senders.some((sender) => sender.id === current)
        ? current
        : (senders[0]?.id ?? ""),
    );
  }, [senders]);

  const eligibleListSignature = eligibleLists.map((list) => list.id).join("\0");
  useEffect(() => {
    setListId((current) => {
      if (eligibleLists.length === 1) return eligibleLists[0]?.id ?? "";
      return eligibleLists.some((list) => list.id === current) ? current : "";
    });
    // The stable id signature prevents context object churn from resetting a
    // deliberate selection while still clearing it when eligibility changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligibleListSignature, phoneE164]);

  const optedOut = context?.consentStatus === "opted_out";
  const suppressed = context?.suppressed === true;
  const consentBlocked =
    context !== null &&
    (context.consentMixed ||
      context.identityAmbiguous ||
      !context.consentEvidenceSufficient);
  const dispatchAvailable = context?.replyDispatchAvailable === true;
  const bodyConstraint = smsReplyBodyConstraint(body);
  const segment = smsBroadcastSegmentInfo(body);
  const activeSender = senders?.find((sender) => sender.id === senderId) ?? null;
  const noSenders = senders !== null && senders.length === 0;

  const sendUnavailableReason = sending
    ? "This reply is already being sent."
    : reconciling
      ? smsReplyReconciliationCopy()
      : recoveryHold
        ? "The stored send safeguard remains held until an authoritative terminal server result settles it."
        : unavailableReason
          ? unavailableReason
          : online !== "online"
            ? "Reconnect before sending. No request is made offline."
            : contextQuery.isPending
              ? "Wait for the consent context to load before replying."
              : contextQuery.isError || context === null
                ? "Consent context could not be verified. Retry the context before replying."
                : suppressed
                  ? `This number has an authoritative ${context.suppressionReason ?? "system"} suppression. Reply is locked.`
                  : context.identityAmbiguous
                    ? "Multiple subscriber identities are linked to this phone. Reply is locked."
                    : context.consentMixed
                      ? "Conflicting consent evidence is recorded for this phone. Reply is locked."
                      : !context.consentEvidenceSufficient
                        ? "No complete timestamped consent evidence authorizes this reply."
                        : !dispatchAvailable
                          ? smsReplyDispatchHoldCopy(
                              context.replyDispatchUnavailableReason,
                            )
                          : optedOut
                            ? "This number is recorded as opted out. A new verified consent event is required before replying."
                            : eligibleLists.length === 0
                              ? "No exact eligible SMS list is recorded for this number."
                              : !listId
                                ? "Choose the exact eligible SMS list authorizing this reply."
                                : bodyConstraint.error
                                  ? bodyConstraint.error
                                  : senders === null
                                    ? "Wait for registered SMS senders to load."
                                    : !senderId
                                      ? "Choose a registered SMS sender before sending."
                                      : null;

  const onSend = useCallback(async () => {
    if (sendUnavailableReason !== null) return;
    const request: SmsReplyRequest = {
      sender_profile_id: senderId,
      body: bodyConstraint.trimmed,
      list_id: listId,
    };
    const result = await dispatch(phoneE164, request);
    if (!result) return;
    if (result.kind === "persisted") {
      setBody("");
      if (result.checkpointCleared) {
        toast.success("Reply persisted with a provider receipt");
      } else {
        toast.error("Reply persisted, but the local safeguard remains held", {
          description:
            "A persisted provider receipt was returned, but the stored checkpoint could not be cleared. Do not resend this draft.",
        });
      }
      const usedQuickReply = sourceQuickReplyId;
      setSourceQuickReplyId(null);
      if (usedQuickReply) {
        void recordSmsQuickReplyUse(usedQuickReply)
          .then(() =>
            queryClient.invalidateQueries({
              queryKey: quickRepliesKey,
              exact: true,
            }),
          )
          .catch((error: unknown) => {
            toast.error("Saved-reply use count was not recorded", {
              description: apiErrorMessage(error),
            });
          });
      }
      onSent(result.outcome);
      return;
    }
    if (result.kind === "reconciling") {
      toast.error("Reply outcome is being reconciled", {
        description: result.detail,
      });
      return;
    }
    if (result.kind === "held") {
      toast.error("Reply remains held by the resend safeguard", {
        description: result.detail,
      });
      return;
    }
    toast.error(result.detail);
  }, [
    bodyConstraint.trimmed,
    dispatch,
    listId,
    onSent,
    phoneE164,
    queryClient,
    quickRepliesKey,
    senderId,
    sendUnavailableReason,
    sourceQuickReplyId,
  ]);

  // Cmd/Ctrl+Enter sends; plain Enter inserts a newline.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
      return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void onSend();
    }
  };

  const insertQuickReply = (reply: { id: string; body: string }) => {
    setBody(reply.body);
    setSourceQuickReplyId(reply.id);
    window.requestAnimationFrame(() => {
      const element = textareaRef.current;
      if (element) {
        element.focus();
        element.setSelectionRange(reply.body.length, reply.body.length);
      }
    });
  };

  return (
    <section
      aria-label="Reply composer"
      className="space-y-3 rounded-md border bg-muted/20 p-3 text-sm"
    >
      {contextQuery.isError ? (
        <div role="alert" className="space-y-2">
          <p className="text-destructive">
            Consent context could not be loaded.{" "}
            {apiErrorMessage(contextQuery.error)}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void contextQuery.refetch()}
          >
            Retry context
          </Button>
        </div>
      ) : null}
      {sendersQuery.isError ? (
        <div role="alert" className="space-y-2">
          <p className="text-destructive">
            Registered SMS senders could not be loaded.{" "}
            {apiErrorMessage(sendersQuery.error)}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void sendersQuery.refetch()}
          >
            Retry senders
          </Button>
        </div>
      ) : null}
      {noSenders ? (
        <p role="status" className="text-muted-foreground">
          No approved US/Canada SMS sender on a supported live provider. Finish
          sender registration in the Registration tab before replying.
        </p>
      ) : null}
      {optedOut ? (
        <p role="status" className="rounded-md border border-warning/40 bg-warning/10 p-2">
          This number is <strong>opted out</strong>. Reply is unavailable until
          a new verified consent event is recorded.
        </p>
      ) : null}
      {suppressed ? (
        <p role="status" className="rounded-md border border-warning/40 bg-warning/10 p-2">
          This number has an <strong>authoritative system suppression</strong>.
          Reply and retry are unavailable.
        </p>
      ) : null}
      {consentBlocked && !suppressed ? (
        <p role="status" className="rounded-md border border-warning/40 bg-warning/10 p-2">
          {context?.identityAmbiguous
            ? "Multiple subscriber identities are linked to this phone. Reply is locked."
            : context?.consentMixed
              ? "Conflicting consent evidence is recorded for this phone. Reply is locked."
              : "Complete timestamped list consent evidence is not available. Reply is locked."}
        </p>
      ) : null}
      {context && !dispatchAvailable ? (
        <p role="status" className="rounded-md border border-warning/40 bg-warning/10 p-2">
          {smsReplyDispatchHoldCopy(context.replyDispatchUnavailableReason)}
          {context.replyDispatchUnavailableReason ? (
            <>
              {" "}
              <code className="text-[11px]">
                {context.replyDispatchUnavailableReason}
              </code>
            </>
          ) : null}
        </p>
      ) : null}
      {reconciling ? (
        <p role="alert" className="rounded-md border border-warning/40 bg-warning/10 p-2">
          {smsReplyReconciliationCopy()}
        </p>
      ) : null}
      {recoveryHold ? (
        <p role="alert" className="rounded-md border border-warning/40 bg-warning/10 p-2">
          <strong>Stored send safeguard is holding this draft.</strong>{" "}
          {smsReplyRecoveryHoldCopy(recoveryHold.reason)}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={senderFieldId}>
            Sending from{" "}
            <span className="font-mono text-xs text-muted-foreground">
              {fmtPhone(activeSender?.phone_number)}
            </span>
          </Label>
          <Select
            id={senderFieldId}
            value={senderId}
            disabled={sending || reconciling || !senders || senders.length === 0}
            onChange={(event) => setSenderId(event.target.value)}
          >
            {senders === null ? (
              <option value="">Loading senders…</option>
            ) : senders.length === 0 ? (
              <option value="">No approved senders available</option>
            ) : (
              senders.map((sender) => (
                <option key={sender.id} value={sender.id}>
                  {sender.phone_number ||
                    `${sender.provider} · ${sender.id.slice(0, 8)}…`}
                </option>
              ))
            )}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={listFieldId}>Eligible consent list</Label>
          <Select
            id={listFieldId}
            value={listId}
            disabled={
              sending || reconciling || suppressed || eligibleLists.length === 0
            }
            onChange={(event) => setListId(event.target.value)}
          >
            <option value="">
              {eligibleLists.length === 0
                ? "No eligible list recorded"
                : "Choose an eligible list…"}
            </option>
            {eligibleLists.map((list) => (
              <option key={list.id} value={list.id}>
                {list.name}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">
            The selected list id is sent to the authoritative consent gate.
          </p>
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor={bodyFieldId}>Reply</Label>
        <Textarea
          ref={textareaRef}
          id={bodyFieldId}
          rows={3}
          placeholder="Type a reply…   (⌘↵ to send)"
          value={body}
          disabled={sending || reconciling || suppressed}
          aria-invalid={bodyConstraint.error !== null && body.length > 0}
          aria-describedby={counterId}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <p
          id={counterId}
          className="flex flex-wrap items-center gap-x-2 text-xs tabular-nums text-muted-foreground"
        >
          <span>
            {bodyConstraint.runes.toLocaleString()} characters ·{" "}
            {bodyConstraint.bytes.toLocaleString()} UTF-8 bytes ·{" "}
            {segment.segments} segment{segment.segments === 1 ? "" : "s"} ·{" "}
            {segment.remaining} left in segment
            {segment.encoding === "ucs2" ? " · UCS-2 encoding" : ""}
          </span>
          <SmsCharCount body={body} max={SMS_REPLY_BODY_MAX_RUNES} />
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {!sending && !reconciling && !suppressed ? extraActions : null}
        <QuickReplyPicker
          queryKey={quickRepliesKey}
          disabled={sending || reconciling || suppressed}
          onPick={insertQuickReply}
        />
        <Button
          type="button"
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          aria-disabled={sendUnavailableReason !== null}
          aria-describedby={sendDescriptionId}
          aria-keyshortcuts="Meta+Enter Control+Enter"
          aria-busy={sending || undefined}
          title={sendUnavailableReason ?? undefined}
          onClick={() => {
            if (sendUnavailableReason === null) void onSend();
          }}
        >
          {sending ? "Sending…" : "Send reply"}
        </Button>
        <span id={sendDescriptionId} className="sr-only">
          {sendUnavailableReason ??
            "Send this reply. Keyboard shortcut: Command or Control plus Enter."}
        </span>
      </div>
    </section>
  );
}
