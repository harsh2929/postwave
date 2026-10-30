/**
 * ReplyComposer — outbound message composer at the bottom of the
 * thread. Refined SMS Inbox PR 1: extracted from SMSInbox.tsx and
 * polished:
 *
 *   - Cmd/Ctrl+Enter sends (Enter alone inserts a newline — long
 *     SMS bodies routinely need them).
 *   - Live segment + cost estimate: an SMS is 160 chars (or 70 for
 *     GSM-extended / unicode). We estimate by character count; the
 *     real per-message cost surface lives in cost_caps.go and is
 *     out of scope here.
 *   - Sender chip shows which phone you're replying FROM, not just
 *     a select tucked in the corner.
 *   - Compliance hint when the consent posture is "opted_out": a
 *     non-blocking warning ("This number opted out — send only if
 *     they re-consented in another channel"). The backend will gate
 *     the send either way; the UI surfaces it pre-emptively.
 */

import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  type SMSConversationContext,
  type SMSSender,
  api,
} from "../../lib/api-client";
import { toast } from "../Toast";
import { registerLifecycleGuard } from "../../lib/lifecycle-coordinator";
import { smsSegmentInfo } from "./broadcasts/broadcast-helpers";
import {
  classifySMSReplyUncertainty,
  eligibleSMSSenders,
  smsReplyBodyConstraint,
  smsReplyDispatchHoldCopy,
  smsReplyReconciliationCopy,
  smsReplyUncertaintyCopy,
  type SMSReplyRequest,
} from "./sms-reply-intent";
import {
  smsReplyRecovery,
  type SMSReplyPrepareResult,
} from "./sms-reply-recovery";
import { useSMSDocumentVisible } from "./sms-page-activity";

interface Props {
  phone: string;
  /** Opaque user + tenant scope for the encrypted idempotency checkpoint. */
  intentScope: string | null;
  /** Subscriber + consent context. Optional — composer still works
   *  when context is loading or unknown; just no warnings. */
  context: SMSConversationContext | null;
  onSent: () => void;
  /** Refined PR 3: insert this string into the composer body when it
   *  changes (e.g. from a quick-reply pick). The composer treats it
   *  as a one-shot insertion + clears the prop via onPrefillConsumed
   *  so a re-render doesn't re-insert. */
  prefillBody?: string;
  onPrefillConsumed?: () => void;
  /** Refined PR 3: optional extra controls rendered next to the
   *  segment counter — typically a QuickReplyPicker. */
  extraActions?: ReactNode;
  /** External safety boundary (offline or unverified consent context). */
  unavailableReason?: string;
}

function fmtPhone(p: string | undefined): string {
  if (!p) return "—";
  if (p.startsWith("+1") && p.length === 12) {
    return `+1 (${p.slice(2, 5)}) ${p.slice(5, 8)}-${p.slice(8)}`;
  }
  return p;
}

export function ReplyComposer({
  phone,
  intentScope,
  context,
  onSent,
  prefillBody,
  onPrefillConsumed,
  extraActions,
  unavailableReason,
}: Props): ReactElement {
  const [body, setBody] = useState("");
  const [senders, setSenders] = useState<SMSSender[] | null>(null);
  const [senderID, setSenderID] = useState("");
  const [listID, setListID] = useState("");
  const [sending, setSending] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [recoveryHold, setRecoveryHold] = useState<Extract<
    SMSReplyPrepareResult,
    { status: "held" }
  > | null>(null);
  const [sendersError, setSendersError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const sendInFlightRef = useRef(false);
  const senderAbortRef = useRef<AbortController | null>(null);
  const sendDescriptionId = useId();
  const documentVisible = useSMSDocumentVisible();

  // Reset draft body when the conversation changes so a stale reply
  // doesn't get sent to the wrong person. Sender selection persists.
  useEffect(() => {
    setBody("");
    setReconciling(false);
    setRecoveryHold(null);
  }, [phone]);

  const hardenedContext = context as
    | (SMSConversationContext & {
        eligibleLists?: Array<{
          id: string;
          name: string;
          description?: string;
          consentSource?: string;
          consentAt?: string;
        }>;
        suppressed?: boolean;
        suppressionReason?: string;
        consentMixed?: boolean;
        identityAmbiguous?: boolean;
        consentEvidenceSufficient?: boolean;
        replyDispatchAvailable?: boolean;
        replyDispatchUnavailableReason?: string;
      })
    | null;
  const eligibleLists = hardenedContext?.eligibleLists ?? [];
  const eligibleListSignature = eligibleLists
    .map((list) => list.id)
    .join("\u0000");
  useEffect(() => {
    setListID((current) => {
      if (eligibleLists.length === 1) return eligibleLists[0]?.id ?? "";
      return eligibleLists.some((list) => list.id === current) ? current : "";
    });
    // The stable id signature prevents context object churn from resetting a
    // deliberate selection while still clearing it when eligibility changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligibleListSignature, phone]);

  // Refined PR 3: prefillBody applies on prop change. The parent
  // clears the prop via onPrefillConsumed so subsequent re-renders
  // don't re-insert.
  useEffect(() => {
    if (prefillBody && prefillBody !== body) {
      setBody(prefillBody);
      // Focus + put the caret at end so the operator can keep typing.
      window.requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(prefillBody.length, prefillBody.length);
        }
      });
      onPrefillConsumed?.();
    }
    // body excluded — we explicitly want the prop change to drive
    // the insert, not body itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillBody]);

  // Lazy-load registered senders so the composer can offer a picker.
  useEffect(() => {
    if (!documentVisible) {
      senderAbortRef.current?.abort();
      return;
    }
    let cancelled = false;
    senderAbortRef.current?.abort();
    const controller = new AbortController();
    senderAbortRef.current = controller;
    setSenders(null);
    setSendersError(null);
    void (async () => {
      try {
        const res = await api.listSMSSenders({ signal: controller.signal });
        if (cancelled || controller.signal.aborted) return;
        if (res.error) {
          setSendersError("Registered SMS senders could not be loaded.");
          return;
        }
        const list = eligibleSMSSenders(res.data?.items ?? []);
        setSenders(list);
        const first = list[0];
        if (first) setSenderID(first.id);
      } catch {
        if (!cancelled && !controller.signal.aborted) {
          setSendersError(
            "Registered SMS senders could not be loaded. Check the connection and retry.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [documentVisible]);

  const optedOut = context?.consentStatus === "opted_out";
  const suppressed = hardenedContext?.suppressed === true;
  const consentBlocked =
    hardenedContext?.consentMixed === true ||
    hardenedContext?.identityAmbiguous === true ||
    hardenedContext?.consentEvidenceSufficient !== true;
  const dispatchAvailable = hardenedContext?.replyDispatchAvailable === true;
  const onSend = useCallback(async () => {
    const bodyConstraint = smsReplyBodyConstraint(body);
    const text = bodyConstraint.trimmed;
    if (
      bodyConstraint.error !== null ||
      !senderID ||
      !listID ||
      unavailableReason ||
      optedOut ||
      suppressed ||
      consentBlocked ||
      !dispatchAvailable ||
      reconciling ||
      recoveryHold !== null ||
      sendInFlightRef.current
    ) {
      return;
    }
    sendInFlightRef.current = true;
    setSending(true);
    const request: SMSReplyRequest = {
      sender_profile_id: senderID,
      body: text,
      list_id: listID,
    };
    const recoveryInput = {
      phone,
      request,
    };
    let intent: Extract<SMSReplyPrepareResult, { status: "ready" }> | null =
      null;
    try {
      const prepared = await smsReplyRecovery.prepare(
        intentScope,
        recoveryInput,
      );
      if (prepared.status === "held") {
        setRecoveryHold(prepared);
        toast.error({
          message: "Reply remains held by the resend safeguard",
          detail:
            prepared.reason === "outcome-unknown" ||
            prepared.reason === "recovered-after-restart"
              ? "The recovered intent remains held until an authoritative terminal server result settles it. No replay request was made."
              : "The encrypted reply checkpoint is unavailable. No send request was made.",
        });
        return;
      }
      intent = prepared;
      setRecoveryHold(null);
      const res = await api.replySMSConversation(
        phone,
        request,
        intent.idempotencyKey,
      );
      if (res.error) {
        const uncertainty = classifySMSReplyUncertainty(res.error);
        if (uncertainty) {
          const checkpointed =
            uncertainty === "request-identity-conflict"
              ? await smsReplyRecovery.markRequestIdentityConflict(
                  intentScope,
                  intent.signature,
                )
              : uncertainty === "another-intent-pending"
                ? await smsReplyRecovery.markAnotherIntentPending(
                    intentScope,
                    intent.signature,
                  )
                : await smsReplyRecovery.markUnknown(
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
          } else if (uncertainty !== "outcome-unknown") {
            setRecoveryHold({
              status: "held",
              signature: intent.signature,
              idempotencyKey: intent.idempotencyKey,
              reason: uncertainty,
            });
          }
          setReconciling(uncertainty === "outcome-unknown");
          toast.error({
            message:
              uncertainty === "request-identity-conflict"
                ? "Reply intent identity conflict"
                : uncertainty === "another-intent-pending"
                  ? "Another reply intent is still pending"
                  : "Reply outcome is being reconciled",
            detail: smsReplyUncertaintyCopy(uncertainty),
          });
          return;
        }
        const cleared = await smsReplyRecovery.settle(
          intentScope,
          intent.signature,
        );
        if (!cleared) {
          setRecoveryHold({
            status: "held",
            signature: intent.signature,
            idempotencyKey: intent.idempotencyKey,
            reason: "checkpoint-clear-failed",
          });
        }
        toast.error(
          res.error.code === "sms_reply_dispatch_release_held"
            ? "SMS reply dispatch is release-held while durable provider reconciliation and budget settlement are unavailable. No provider send was attempted."
            : res.error.code === "sms_financial_reservation_unavailable"
              ? "SMS sending is unavailable because a durable financial reservation could not be established. No provider send was attempted."
              : res.error.code === "consent_required"
                ? "Reply was blocked because no eligible SMS list consent is recorded."
                : res.error.code === "list_selection_required"
                  ? "Choose one exact eligible SMS list before replying."
                  : "Reply was not accepted. No persisted/provider receipt was returned.",
        );
        return;
      }
      if (res.data.disposition === "reconciliation_required") {
        const checkpointed = await smsReplyRecovery.markUnknown(
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
        toast.error({
          message: "Reply outcome is being reconciled",
          detail: smsReplyReconciliationCopy(),
        });
        return;
      }
      const cleared = await smsReplyRecovery.settle(
        intentScope,
        intent.signature,
      );
      if (!cleared) {
        setRecoveryHold({
          status: "held",
          signature: intent.signature,
          idempotencyKey: intent.idempotencyKey,
          reason: "checkpoint-clear-failed",
        });
        toast.error({
          message: "Reply persisted, but the local safeguard remains held",
          detail:
            "A persisted provider receipt was returned, but the encrypted local checkpoint could not be cleared. Do not resend this draft.",
        });
        onSent();
        return;
      }
      setBody("");
      toast.success("Reply persisted with a provider receipt");
      onSent();
    } catch {
      if (intent) {
        const checkpointed = await smsReplyRecovery.markUnknown(
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
        toast.error({
          message: "Reply outcome is unknown",
          detail: smsReplyReconciliationCopy(),
        });
      } else {
        setRecoveryHold({
          status: "held",
          reason: "vault-unavailable",
        });
        toast.error(
          "The encrypted reply checkpoint could not be prepared. No send request was made.",
        );
      }
    } finally {
      sendInFlightRef.current = false;
      setSending(false);
    }
  }, [
    body,
    consentBlocked,
    dispatchAvailable,
    intentScope,
    listID,
    onSent,
    optedOut,
    phone,
    recoveryHold,
    reconciling,
    senderID,
    suppressed,
    unavailableReason,
  ]);

  useEffect(() => {
    if (body.trim().length === 0 && !sending && !reconciling) return;
    return registerLifecycleGuard({
      id: "sms-reply-draft",
      label: "SMS reply draft",
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : sending || reconciling
            ? {
                level: "blocking",
                detail: reconciling
                  ? "The SMS reply outcome is being reconciled. Do not resend it."
                  : "The SMS reply is still being submitted.",
                canDiscard: false,
              }
            : {
                level: "blocking",
                detail:
                  "The SMS reply exists only in this conversation composer.",
              },
      discard: () => setBody(""),
    });
  }, [body, reconciling, sending]);

  // Cmd/Ctrl + Enter sends. Plain Enter inserts a newline — long SMS
  // bodies (1600 char limit on Twilio) routinely span multiple lines.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void onSend();
    }
  };

  const noSenders = senders !== null && senders.length === 0;
  const activeSender = senders?.find((s) => s.id === senderID) ?? null;
  const segment = smsSegmentInfo(body);
  const bodyConstraint = smsReplyBodyConstraint(body);

  const sendUnavailableReason = sending
    ? "This reply is already being sent."
    : reconciling
      ? smsReplyReconciliationCopy()
      : recoveryHold
        ? "The stored send safeguard remains held until an authoritative terminal server result settles it."
        : unavailableReason
          ? unavailableReason
          : suppressed
            ? `This number has an authoritative ${hardenedContext?.suppressionReason ?? "system"} suppression. Reply is locked.`
            : hardenedContext?.identityAmbiguous
              ? "Multiple subscriber identities are linked to this phone. Reply is locked."
              : hardenedContext?.consentMixed
                ? "Conflicting consent evidence is recorded for this phone. Reply is locked."
                : hardenedContext?.consentEvidenceSufficient !== true
                  ? "No complete timestamped consent evidence authorizes this reply."
                  : !dispatchAvailable
                    ? smsReplyDispatchHoldCopy(
                        hardenedContext?.replyDispatchUnavailableReason,
                      )
                    : optedOut
                      ? "This number is recorded as opted out. A new verified consent event is required before replying."
                      : eligibleLists.length === 0
                        ? "No exact eligible SMS list is recorded for this number."
                        : eligibleLists.length > 1 && !listID
                          ? "Choose the exact eligible SMS list authorizing this reply."
                          : !listID
                            ? "Wait for an exact eligible SMS list to be selected."
                            : bodyConstraint.error
                              ? bodyConstraint.error
                              : senders === null
                                ? "Wait for registered SMS senders to load."
                                : !senderID
                                  ? "Choose a registered SMS sender before sending."
                                  : null;

  if (sendersError) {
    return (
      <div className="sms-composer">
        <div className="notice" role="alert">
          {sendersError} Close and reopen the conversation to retry.
        </div>
      </div>
    );
  }

  if (noSenders) {
    return (
      <div className="sms-composer">
        <div className="notice">
          No approved US/Canada SMS sender on a supported live provider. Finish
          sender registration in Settings → SMS before replying.
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="sms-composer">
        {optedOut ? (
          <div className="sms-composer-warning" role="status">
            This number is <strong>opted out</strong>. Reply is unavailable
            until a new verified consent event is recorded.
          </div>
        ) : null}
        {suppressed ? (
          <div className="sms-composer-warning" role="status">
            This number has an <strong>authoritative system suppression</strong>
            . Reply and retry are unavailable.
          </div>
        ) : null}
        {consentBlocked && !suppressed ? (
          <div className="sms-composer-warning" role="status">
            {hardenedContext?.identityAmbiguous
              ? "Multiple subscriber identities are linked to this phone. Reply is locked."
              : hardenedContext?.consentMixed
                ? "Conflicting consent evidence is recorded for this phone. Reply is locked."
                : "Complete timestamped list consent evidence is not available. Reply is locked."}
          </div>
        ) : null}
        {!dispatchAvailable ? (
          <div className="sms-composer-warning" role="status">
            {smsReplyDispatchHoldCopy(
              hardenedContext?.replyDispatchUnavailableReason,
            )}
          </div>
        ) : null}
        {reconciling ? (
          <div className="sms-composer-warning" role="alert">
            {smsReplyReconciliationCopy()}
          </div>
        ) : null}
        {recoveryHold ? (
          <div className="sms-composer-warning" role="alert">
            <strong>Stored send safeguard is holding this draft.</strong>{" "}
            {recoveryHold.reason === "request-identity-conflict"
              ? "The server and encrypted vault disagree about this key's request identity. Operator reconciliation is required; checking it again is disabled."
              : recoveryHold.reason === "another-intent-pending"
                ? "Another intent for this phone is unresolved. This checkpoint was not reported as sent and remains blocked pending operator reconciliation."
                : recoveryHold.reason === "checkpoint-clear-failed"
                  ? "The authoritative response returned, but the encrypted local checkpoint could not be cleared. Do not resend."
                  : recoveryHold.reason === "checkpoint-update-failed"
                    ? "The outcome is unknown and the encrypted checkpoint state could not be updated. Do not resend."
                    : "No new key or replay request will be created. This intent remains held pending an authoritative terminal server result."}
          </div>
        ) : null}
        <div className="sms-composer-from">
          <span className="muted small">Sending from</span>
          <span className="sms-composer-from-phone mono">
            {fmtPhone(activeSender?.phone_number)}
          </span>
          {senders && senders.length > 1 ? (
            <select
              className="input sms-composer-from-select"
              value={senderID}
              onChange={(e) => setSenderID(e.target.value)}
              aria-label="Choose sender"
              disabled={sending || reconciling}
            >
              {senders.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label ||
                    s.phone_number ||
                    `${s.provider ?? "sender"} · ${s.id.slice(0, 8)}…`}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        <label className="sms-composer-consent-list">
          <span className="muted small">Eligible consent list</span>
          <select
            value={listID}
            onChange={(event) => setListID(event.target.value)}
            disabled={
              sending || reconciling || suppressed || eligibleLists.length === 0
            }
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
          </select>
          <span className="muted small">
            The selected list id is sent to the authoritative consent gate. This
            aggregate view does not override suppressions or revocation review.
          </span>
        </label>
        <textarea
          ref={textareaRef}
          className="sms-composer-body"
          placeholder="Type a reply…   (⌘↵ to send)"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          aria-invalid={bodyConstraint.error !== null && body.length > 0}
          disabled={sending || reconciling || suppressed}
        />
        <div className="sms-composer-actions">
          <span
            className="muted small tabular"
            title="Standard SMS segments are 160 chars (153 when split). Carriers bill per segment."
          >
            {bodyConstraint.runes.toLocaleString()} characters ·{" "}
            {bodyConstraint.bytes.toLocaleString()} UTF-8 bytes ·{" "}
            {segment.segments} segment
            {segment.segments === 1 ? "" : "s"} · {segment.remaining} left in
            segment{segment.encoding === "unicode" ? " · Unicode encoding" : ""}
          </span>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {!sending && !reconciling && !suppressed ? extraActions : null}
            <button
              type="button"
              className={`btn btn-primary${sendUnavailableReason ? " pw-discoverable-unavailable" : ""}`}
              onClick={() => {
                if (!sendUnavailableReason) void onSend();
              }}
              aria-disabled={sendUnavailableReason !== null}
              aria-describedby={sendDescriptionId}
              aria-keyshortcuts="Meta+Enter Control+Enter"
              aria-busy={sending || undefined}
            >
              {sending ? "Sending…" : "Send reply"}
            </button>
            <span id={sendDescriptionId} className="visually-hidden">
              {sendUnavailableReason ??
                "Send this reply. Keyboard shortcut: Command or Control plus Enter."}
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
