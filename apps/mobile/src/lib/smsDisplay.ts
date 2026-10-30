/**
 * smsDisplay — pure display and routing helpers for SMS surfaces.
 *
 * Extracted from `smsConversation.ts` to keep that module under the 450-line
 * source budget; behavior is unchanged and `smsConversation.ts` re-exports
 * everything here.
 */
import type { SmsConversationSummary } from "./smsConversation";

const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const E164 = /^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u;

/** Strip direction overrides, isolate the run, and cap by Unicode code point. */
export function safeSmsDisplayText(
  value: string,
  maxCodePoints = 4_800,
): string {
  const clean = value.replace(BIDI_CONTROLS, "�");
  const points = Array.from(clean);
  const bounded =
    points.length > maxCodePoints
      ? `${points.slice(0, maxCodePoints).join("")}…`
      : clean;
  return `\u2068${bounded}\u2069`;
}

export function threadPath(phoneE164: string): `/(tabs)/sms/${string}` {
  return `/(tabs)/sms/${encodeURIComponent(phoneE164)}`;
}

export function decodePhoneParam(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  if (!value) return "";
  try {
    const decoded = decodeURIComponent(value);
    return E164.test(decoded) ? decoded : "";
  } catch {
    return "";
  }
}

export function conversationTitle(
  conversation: Pick<SmsConversationSummary, "phoneE164" | "subscriberEmail">,
): string {
  return conversation.subscriberEmail?.trim() || conversation.phoneE164;
}
