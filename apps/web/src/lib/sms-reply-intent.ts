// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Reply-intent vocabulary shared by the conversation composer, the
 * new-conversation dialog and the failed-message retry. Mirrors desktop
 * apps/desktop/src/components/sms/sms-reply-intent.ts: the same constants,
 * body boundary, sender eligibility rule, uncertainty classes and hold copy,
 * so the three surfaces cannot drift from each other or from desktop.
 *
 * Server: apps/api/internal/sms/inbox.go ReplyConversation. While
 * `smsDispatchSagaReleaseReady` is false every reply is refused with a 503
 * `sms_reply_dispatch_release_held`; the conversation context payload reports
 * the same verdict up front as `replyDispatchAvailable:false`, and that is the
 * signal every composer disables its Send control on.
 */

import { isApiError } from "./api";

export const SMS_REPLY_DISPATCH_RELEASE_HELD_CODE =
  "sms_reply_dispatch_release_held" as const;
export const SMS_REPLY_RECONCILIATION_REQUIRED =
  "reply_reconciliation_required" as const;
export const SMS_REPLY_IDEMPOTENCY_CONFLICT =
  "idempotency_key_request_mismatch" as const;
export const SMS_REPLY_ANOTHER_INTENT_PENDING =
  "reply_reconciliation_pending" as const;

/** POST body of /api/v1/sms/conversations/{phone}/reply (ReplyInput). */
export interface SmsReplyRequest {
  sender_profile_id: string;
  body: string;
  list_id: string;
  media_url?: string;
}

export type SmsReplyUncertaintyKind =
  | "outcome-unknown"
  | "request-identity-conflict"
  | "another-intent-pending";

const LIVE_SMS_PROVIDERS = new Set(["twilio", "telnyx", "bandwidth"]);
const SMS_US_CA_E164_RE = /^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u;

export function isCanonicalSmsUsCa(phone: string): boolean {
  return SMS_US_CA_E164_RE.test(phone);
}

/** Loose operator input → canonical +1NXXNXXXXXX, or null when not US/CA. */
export function normalizeSmsUsCa(raw: string): string | null {
  const reviewed = raw.replace(/^ +| +$/gu, "");
  if (!reviewed) return null;
  let digits = "";
  for (let index = 0; index < reviewed.length; index += 1) {
    const character = reviewed[index] ?? "";
    if (character >= "0" && character <= "9") {
      digits += character;
    } else if (character === "+" && index === 0) {
      continue;
    } else if ([" ", "(", ")", "-", "."].includes(character)) {
      continue;
    } else {
      return null;
    }
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }
  const canonical = digits.length === 10 ? `+1${digits}` : "";
  return isCanonicalSmsUsCa(canonical) ? canonical : null;
}

export interface SmsReplyBodyConstraint {
  bytes: number;
  error: string | null;
  runes: number;
  trimmed: string;
}

/** Server reply-body boundary: 4,800 Unicode code points / 16 KiB UTF-8. */
export const SMS_REPLY_BODY_MAX_RUNES = 4_800;

/** Mirrors the reply handler's 4,800-rune / 16 KiB UTF-8 boundary. */
export function smsReplyBodyConstraint(body: string): SmsReplyBodyConstraint {
  const trimmed = body.trim();
  const runes = Array.from(trimmed).length;
  const bytes = new TextEncoder().encode(trimmed).byteLength;
  const error =
    trimmed.length === 0
      ? "Enter a message body."
      : trimmed.includes("\u0000")
        ? "Message text cannot contain a null control character."
        : runes > SMS_REPLY_BODY_MAX_RUNES
          ? "Message text exceeds the 4,800-character server limit."
          : bytes > 16 * 1024
            ? "Message text exceeds the 16 KiB UTF-8 server limit."
            : null;
  return { bytes, error, runes, trimmed };
}

/**
 * Only an approved US/Canada sender on a live provider can dispatch a reply;
 * every other profile is a draft or a paused/suspended record.
 */
export function eligibleSmsSenders<
  T extends {
    phone_number?: string;
    provider?: string;
    registration_status?: string;
  },
>(senders: readonly T[]): T[] {
  return senders.filter(
    (sender) =>
      sender.registration_status?.trim().toLowerCase() === "approved" &&
      LIVE_SMS_PROVIDERS.has(sender.provider?.trim().toLowerCase() ?? "") &&
      isCanonicalSmsUsCa(sender.phone_number?.trim() ?? ""),
  );
}

/**
 * A reply intent gets one cryptographically random identity. Callers retain
 * this value until the server returns an authoritative terminal outcome.
 */
export function createSmsReplyIntentKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Separates "this request's outcome is unknown" (a response-less failure or
 * the server's explicit reconciliation code) from two durable server holds. A
 * key/request mismatch must never be freed, and a pending earlier intent does
 * not mean this newly checkpointed request was itself dispatched. Returns
 * null for an explicit refusal, where nothing reached a provider.
 */
export function classifySmsReplyUncertainty(
  error: unknown,
): SmsReplyUncertaintyKind | null {
  if (!isApiError(error)) {
    // A thrown non-transport error after the request left (for example a
    // receipt that failed its contract decode) cannot prove the provider was
    // never reached.
    return error instanceof Error ? "outcome-unknown" : null;
  }
  if (
    error.code === SMS_REPLY_DISPATCH_RELEASE_HELD_CODE ||
    error.code === "sms_financial_reservation_unavailable" ||
    error.kind === "offline"
  ) {
    return null;
  }
  if (error.code === SMS_REPLY_IDEMPOTENCY_CONFLICT) {
    return "request-identity-conflict";
  }
  if (error.code === SMS_REPLY_ANOTHER_INTENT_PENDING) {
    return "another-intent-pending";
  }
  return error.code === SMS_REPLY_RECONCILIATION_REQUIRED ||
    error.code === "idempotency_complete_failed" ||
    error.kind === "network" ||
    error.kind === "timeout" ||
    error.kind === "aborted" ||
    error.status >= 500
    ? "outcome-unknown"
    : null;
}

export function smsReplyReconciliationCopy(): string {
  return "The delivery outcome is not yet known. Do not send this message again. Refresh the retained message records after the service reconciles the original attempt.";
}

export function smsReplyUncertaintyCopy(kind: SmsReplyUncertaintyKind): string {
  if (kind === "request-identity-conflict") {
    return "The server reports that this idempotency key is bound to a different request. No replacement key was created. Keep this intent held for operator reconciliation.";
  }
  if (kind === "another-intent-pending") {
    return "Another reply intent for this phone is unresolved. This newly checkpointed intent was not reported as sent; keep it held until the earlier intent is reconciled.";
  }
  return smsReplyReconciliationCopy();
}

/** The disabled-Send reason, keyed on the context payload's unavailable code. */
export function smsReplyDispatchHoldCopy(reason?: string): string {
  if (reason === SMS_REPLY_DISPATCH_RELEASE_HELD_CODE) {
    return "Live SMS reply dispatch is release-held while durable provider reconciliation and budget settlement are unavailable. No provider request can be started.";
  }
  return reason === "sms_financial_reservation_unavailable"
    ? "Live SMS sending is release-held because a durable financial reservation is unavailable. No provider request can be started."
    : "Live SMS dispatch is unavailable. No provider request can be started.";
}

/** Sentence for an explicit server refusal (nothing reached a provider). */
export function smsReplyRefusalCopy(error: unknown): string {
  const code = isApiError(error) ? error.code : "";
  if (code === SMS_REPLY_DISPATCH_RELEASE_HELD_CODE) {
    return "SMS reply dispatch is release-held while durable provider reconciliation and budget settlement are unavailable. No provider send was attempted.";
  }
  if (code === "sms_financial_reservation_unavailable") {
    return "SMS sending is unavailable because a durable financial reservation could not be established. No provider send was attempted.";
  }
  if (code === "consent_required") {
    return "Reply was blocked because no eligible SMS list consent is recorded.";
  }
  if (code === "list_selection_required") {
    return "Choose one exact eligible SMS list before replying.";
  }
  if (isApiError(error) && error.kind === "offline") {
    return "You are offline. No send request was made.";
  }
  return "Reply was not accepted. No persisted/provider receipt was returned.";
}

/** Copy for a checkpoint the local safeguard refuses to replay. */
export function smsReplyRecoveryHoldCopy(
  reason:
    | "identity-unresolved"
    | "vault-unavailable"
    | "vault-corrupt"
    | "recovered-after-restart"
    | "outcome-unknown"
    | "intent-capacity-reached"
    | "checkpoint-update-failed"
    | "checkpoint-clear-failed"
    | "request-identity-conflict"
    | "another-intent-pending",
): string {
  switch (reason) {
    case "request-identity-conflict":
      return "The server and the stored checkpoint disagree about this key's request identity. Operator reconciliation is required; checking it again is disabled.";
    case "another-intent-pending":
      return "Another intent for this phone is unresolved. This checkpoint was not reported as sent and remains blocked pending operator reconciliation.";
    case "checkpoint-clear-failed":
      return "The authoritative response returned, but the stored checkpoint could not be cleared. Do not resend.";
    case "checkpoint-update-failed":
      return "The outcome is unknown and the stored checkpoint state could not be updated. Do not resend.";
    case "vault-unavailable":
    case "vault-corrupt":
    case "identity-unresolved":
    case "intent-capacity-reached":
      return "The stored send checkpoint is unavailable. No send request was made.";
    default:
      return "No new key or replay request will be created. This intent remains held pending an authoritative terminal server result.";
  }
}
