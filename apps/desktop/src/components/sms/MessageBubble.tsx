/**
 * MessageBubble — one chat bubble in the SMS thread.
 * Refined SMS Inbox PR 1: extracted + extended with a status pill,
 * retry-on-fail affordance, and copy-body shortcut.
 *
 * Status pill semantics (matches sms_messages.status canonical values):
 *   - queued / sending  → neutral grey (durable intent / submission)
 *   - sent              → muted grey (provider accepted)
 *   - delivered         → success green (provider-reported delivery)
 *   - failed / error    → danger red + Retry button
 *   - blocked           → amber ("gated by suppression / quiet hours")
 *
 * Inbound bubbles never show an outbound delivery pill. Raw provider error
 * notes/codes are intentionally not rendered: they are untrusted operational
 * payloads and are not safe operator-facing categories.
 *
 * Copy button: a small ⧉ glyph on hover that pops a clipboard copy of
 * the body. Useful when an inbound message is a coupon code or order
 * number the operator needs to paste somewhere else.
 */

import { type ReactElement, useEffect, useRef, useState } from "react";

import type { SMSMessage } from "../../lib/api-client";
import { writeClipboardText } from "../../lib/clipboard";
import { ExternalLink } from "../ExternalLink";
import { InlineHelp } from "../InlineHelp";
import { toast } from "../Toast";

interface Props {
  message: SMSMessage;
  /** Refined PR 1: called when the operator hits Retry on a failed
   *  outbound bubble. Parent owns the send pipeline. */
  onRetry?: (message: SMSMessage) => void | Promise<void>;
}

function fmtTime(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

interface StatusMeta {
  className: string;
  label: string;
  /** Tooltip body explaining what this status actually means. */
  description: string;
}

function statusMeta(status: string): StatusMeta | null {
  switch (status.trim().toLowerCase()) {
    case "queued":
    case "scheduled":
      return {
        className: "is-pending",
        label: "recorded",
        description:
          "A durable outbound intent was recorded. Provider acceptance is not yet confirmed.",
      };
    case "sending":
      return {
        className: "is-pending",
        label: "submitting",
        description:
          "Submission is in progress. Provider acceptance and carrier delivery are not yet confirmed.",
      };
    case "sent":
    case "accepted":
      return {
        className: "is-sent",
        label: "provider accepted",
        description:
          "The SMS provider accepted the message and is attempting carrier delivery. This is not proof of device receipt.",
      };
    case "delivered":
      return {
        className: "is-delivered",
        label: "provider-reported delivered",
        description:
          "The provider reported a carrier delivery receipt. This is the latest recorded delivery signal, not absolute proof that a person received or read it.",
      };
    case "reconciliation_required":
    case "reconciling":
    case "unknown":
      return {
        className: "is-pending",
        label: "reconciling",
        description:
          "The delivery outcome is unknown while the original send intent is reconciled. Do not send it again.",
      };
    case "failed":
    case "undelivered":
    case "error":
      return {
        className: "is-failed",
        label: "provider-reported failed",
        description:
          "The latest provider record reports a terminal delivery failure. A separate confirmed retry creates a new billed send intent.",
      };
    case "blocked":
    case "rejected":
    case "gated":
      return {
        className: "is-blocked",
        label: "blocked before send",
        description:
          "The send gate blocked this attempt. Verify consent, suppression, sender registration, and policy state before creating any new intent.",
      };
    case "":
      return null;
    default:
      return {
        className: "is-pending",
        label: "status unavailable",
        description:
          "The retained record has a status this client cannot safely interpret. Refresh after updating the application; do not infer delivery.",
      };
  }
}

export function MessageBubble({ message: m, onRetry }: Props): ReactElement {
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const copyBusyRef = useRef(false);
  const retryBusyRef = useRef(false);
  const copiedTimerRef = useRef<number | null>(null);
  const activeRef = useRef(true);
  const isInbound = m.direction === "inbound";
  const bodyOmittedReason = m.body_omitted_reason;
  const bodyAvailable = bodyOmittedReason === undefined;
  const dispatchStatus =
    m.dispatch_state === "reserved"
      ? {
          className: "is-pending",
          label: "intent reserved",
          description:
            "A durable reply intent is reserved locally. Provider submission is not established; wait for a terminal dispatch state before taking another action.",
        }
      : m.dispatch_state === "reconciliation_required"
        ? statusMeta("reconciliation_required")
        : m.dispatch_state === "provider_failed"
          ? statusMeta("failed")
          : statusMeta(m.status);
  const status = !isInbound ? dispatchStatus : null;
  const failed =
    status?.className === "is-failed" &&
    (m.dispatch_state === undefined || m.dispatch_state === "provider_failed");

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  const onCopy = async (): Promise<void> => {
    if (copyBusyRef.current) return;
    copyBusyRef.current = true;
    setCopying(true);
    try {
      const result = await writeClipboardText(m.body, {
        contentClass: "personal",
        label: "SMS message",
      });
      if (!activeRef.current) return;
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setCopied(true);
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(() => {
        if (activeRef.current) setCopied(false);
        copiedTimerRef.current = null;
      }, 1200);
    } catch (error) {
      if (activeRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Message could not be copied.",
        );
      }
    } finally {
      copyBusyRef.current = false;
      if (activeRef.current) setCopying(false);
    }
  };

  const retry = async (): Promise<void> => {
    if (!onRetry || retryBusyRef.current) return;
    retryBusyRef.current = true;
    setRetrying(true);
    try {
      await onRetry(m);
    } catch (error) {
      if (activeRef.current) {
        toast.error(
          error instanceof Error ? error.message : "Message retry failed.",
        );
      }
    } finally {
      retryBusyRef.current = false;
      if (activeRef.current) setRetrying(false);
    }
  };

  return (
    <div
      className={`sms-bubble ${isInbound ? "is-inbound" : "is-outbound"}${
        failed ? " is-failed" : ""
      }`}
    >
      <div className="sms-bubble-body">
        {bodyAvailable ? (
          <>
            <bdi className="sms-message-text" dir="auto">
              {m.body}
            </bdi>
            <button
              type="button"
              className="sms-bubble-copy"
              onClick={() => void onCopy()}
              aria-label={copied ? "Message body copied" : "Copy message body"}
              aria-disabled={copying || undefined}
              aria-busy={copying || undefined}
              aria-live="polite"
            >
              {copying ? "Copying…" : copied ? "Copied" : "Copy"}
            </button>
          </>
        ) : (
          <span className="sms-message-body-unavailable" role="note">
            {bodyOmittedReason === "legacy_body_unavailable"
              ? "Legacy message content unavailable. No historical body evidence is available for display or copying."
              : "Message body unavailable: the retained content exceeded the inbox evidence limit. The record was not truncated for display."}
          </span>
        )}
      </div>
      {m.media_url ? (
        <div className="sms-bubble-media">
          <ExternalLink href={m.media_url}>View attachment</ExternalLink>
        </div>
      ) : null}
      <div className="sms-bubble-meta">
        <span className="muted small tabular">{fmtTime(m.created_at)}</span>
        {status ? (
          <>
            <span className={`sms-status-pill ${status.className}`}>
              {status.label}
            </span>
            <InlineHelp
              text={status.description}
              ariaLabel={`What "${status.label}" means`}
            />
          </>
        ) : null}
        {failed && onRetry ? (
          <>
            <button
              type="button"
              className="sms-bubble-retry"
              onClick={() => void retry()}
              aria-disabled={retrying || undefined}
              aria-busy={retrying || undefined}
            >
              {retrying ? "Retrying…" : "Retry"}
            </button>
            <InlineHelp
              text="After confirmation, this creates a separate outbound intent and may incur another carrier charge. It is available only for a terminal provider-reported failure."
              ariaLabel="Why a retry might be needed"
            />
          </>
        ) : null}
        {isInbound && (m.error_code || m.error_message) ? (
          <span className="sms-status-pill is-blocked">
            Inbound processing issue recorded
          </span>
        ) : null}
      </div>
    </div>
  );
}
