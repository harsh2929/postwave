/**
 * Internal-note input normalization.
 *
 * Both checks are pre-flight refusals: a note body that is empty, carries
 * hidden controls or exceeds the server's 16 KiB bound, and an idempotency key
 * that is not byte-exactly what the durable recovery journal stored, are
 * rejected before any request is made. The key check matters most — a mangled
 * key is a SECOND note, not a retry of the first.
 */
import { UNSAFE_DISPLAY_RE, helpdeskUtf8Bytes } from "@/lib/helpdeskContract";
import { HelpdeskContractError } from "@/lib/helpdeskTypes";

export const HELPDESK_INTERNAL_NOTE_MAX_BYTES = 16 * 1024;
const HELPDESK_IDEMPOTENCY_KEY_MAX_BYTES = 255;
const UNSAFE_IDEMPOTENCY_KEY_RE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;

export function normalizeHelpdeskInternalNoteBody(value: string): string {
  const body = value.trim();
  if (
    !body ||
    UNSAFE_DISPLAY_RE.test(body) ||
    helpdeskUtf8Bytes(body) > HELPDESK_INTERNAL_NOTE_MAX_BYTES
  ) {
    throw new HelpdeskContractError(
      "Internal notes are required, must not contain hidden controls, and may not exceed 16 KiB.",
    );
  }
  return body;
}

export function normalizeHelpdeskIdempotencyKey(value: string): string {
  if (
    !value ||
    value !== value.trim() ||
    UNSAFE_IDEMPOTENCY_KEY_RE.test(value) ||
    helpdeskUtf8Bytes(value) > HELPDESK_IDEMPOTENCY_KEY_MAX_BYTES
  ) {
    throw new HelpdeskContractError(
      "Helpdesk internal-note idempotency key is invalid.",
    );
  }
  return value;
}
