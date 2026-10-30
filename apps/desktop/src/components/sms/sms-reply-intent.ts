import type { ApiErr } from "../../lib/api/result";
import type { ApiResult } from "../../lib/api/result";
import type { SMSReplyOutcome, SMSReplyRequest } from "../../lib/api-client";

export type { SMSReplyOutcome, SMSReplyRequest } from "../../lib/api-client";

export const SMS_REPLY_RECONCILIATION_REQUIRED =
  "reply_reconciliation_required";
export const SMS_REPLY_IDEMPOTENCY_CONFLICT =
  "idempotency_key_request_mismatch";
export const SMS_REPLY_ANOTHER_INTENT_PENDING = "reply_reconciliation_pending";

export type SMSReplyUncertaintyKind =
  | "outcome-unknown"
  | "request-identity-conflict"
  | "another-intent-pending";

const LIVE_SMS_PROVIDERS = new Set(["twilio", "telnyx", "bandwidth"]);
const SMS_US_CA_E164_RE = /^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u;

export function isCanonicalSMSUSCA(phone: string): boolean {
  return SMS_US_CA_E164_RE.test(phone);
}

export function normalizeSMSUSCA(raw: string): string | null {
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
  return isCanonicalSMSUSCA(canonical) ? canonical : null;
}

export interface SMSReplyBodyConstraint {
  bytes: number;
  error: string | null;
  runes: number;
  trimmed: string;
}

/** Mirrors the reply handler's 4,800-rune / 16 KiB UTF-8 boundary. */
export function smsReplyBodyConstraint(body: string): SMSReplyBodyConstraint {
  const trimmed = body.trim();
  const runes = Array.from(trimmed).length;
  const bytes = new TextEncoder().encode(trimmed).byteLength;
  const error =
    trimmed.length === 0
      ? "Enter a message body."
      : trimmed.includes("\u0000")
        ? "Message text cannot contain a null control character."
        : runes > 4_800
          ? "Message text exceeds the 4,800-character server limit."
          : bytes > 16 * 1024
            ? "Message text exceeds the 16 KiB UTF-8 server limit."
            : null;
  return { bytes, error, runes, trimmed };
}

export type SMSReplyMethod = (
  phone: string,
  body: SMSReplyRequest,
  idempotencyKey: string,
) => Promise<ApiResult<SMSReplyOutcome>>;

export function eligibleSMSSenders<
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
      isCanonicalSMSUSCA(sender.phone_number?.trim() ?? ""),
  );
}

/**
 * A reply intent gets one cryptographically random identity. Callers retain
 * this value until the server returns an authoritative terminal outcome.
 */
export function createSMSReplyIntentKey(): string {
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
 * A response-less network/timeout failure and the server's explicit
 * reconciliation response both mean that sending again could duplicate an
 * SMS. The UI must preserve the draft and key, then wait for reconciliation.
 */
export function isSMSReplyOutcomeUnknown(
  error: ApiErr["error"] | null | undefined,
): boolean {
  return classifySMSReplyUncertainty(error) !== null;
}

/**
 * Separates an unknown result for this request from two durable server holds.
 * A key/request mismatch must never be freed, and a pending earlier intent
 * does not mean this newly checkpointed request was itself dispatched.
 */
export function classifySMSReplyUncertainty(
  error: ApiErr["error"] | null | undefined,
): SMSReplyUncertaintyKind | null {
  if (
    error?.code === "sms_financial_reservation_unavailable" ||
    error?.code === "sms_reply_dispatch_release_held"
  )
    return null;
  if (error?.code === SMS_REPLY_IDEMPOTENCY_CONFLICT) {
    return "request-identity-conflict";
  }
  if (error?.code === SMS_REPLY_ANOTHER_INTENT_PENDING) {
    return "another-intent-pending";
  }
  return error?.code === SMS_REPLY_RECONCILIATION_REQUIRED ||
    error?.code === "idempotency_complete_failed" ||
    error?.kind === "network" ||
    error?.kind === "timeout" ||
    (typeof error?.status === "number" && error.status >= 500)
    ? "outcome-unknown"
    : null;
}

export function smsReplyReconciliationCopy(): string {
  return "The delivery outcome is not yet known. Do not send this message again. Refresh the retained message records after the service reconciles the original attempt.";
}

export function smsReplyUncertaintyCopy(kind: SMSReplyUncertaintyKind): string {
  if (kind === "request-identity-conflict") {
    return "The server reports that this idempotency key is bound to a different request. No replacement key was created. Keep this intent held for operator reconciliation.";
  }
  if (kind === "another-intent-pending") {
    return "Another reply intent for this phone is unresolved. This newly checkpointed intent was not reported as sent; keep it held until the earlier intent is reconciled.";
  }
  return smsReplyReconciliationCopy();
}

export function smsReplyDispatchHoldCopy(reason?: string): string {
  if (reason === "sms_reply_dispatch_release_held") {
    return "Live SMS reply dispatch is release-held while durable provider reconciliation and budget settlement are unavailable. No provider request can be started.";
  }
  return reason === "sms_financial_reservation_unavailable"
    ? "Live SMS sending is release-held because a durable financial reservation is unavailable. No provider request can be started."
    : "Live SMS dispatch is unavailable. No provider request can be started.";
}
