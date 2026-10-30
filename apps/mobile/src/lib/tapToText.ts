/**
 * lib/tapToText.ts — the tap-to-text creative block, generated on device.
 *
 * Desktop parity for apps/desktop/src/components/sms/TapToTextBlockEditor.tsx
 * (GAP-LS-148, Klaviyo's "Tap to text" block). The artifact is a local
 * `sms:` URI plus the HTML button that wraps it — the thing you paste into an
 * email/web/print creative so a reader can tap and land in their own SMS
 * composer with the keyword pre-filled.
 *
 * NO SERVER ROUTE IS INVOLVED, BY DESIGN. Desktop keeps generation entirely
 * in the renderer; the destination and the keyword never leave the device
 * merely to produce a preview. Mobile keeps that property: this module is
 * pure string work, and the phone is strictly better placed than the desktop
 * to hand the result on (share sheet, camera-roll QR, an SMS app to test it
 * against on the same device).
 *
 * VALIDATION IS PORTED VERBATIM, not re-invented. The rules below are the
 * desktop rules character-for-character, because the two surfaces must agree
 * on what a legal destination is — an operator who generates a block on a
 * laptop and re-generates it on a phone must not get two different links:
 *
 *   - a destination is EXACTLY a 5–6 digit short code or a plus-prefixed
 *     E.164 number, with only space ( ) . - accepted as display separators;
 *   - creative text carries no control/format/surrogate scalars and no
 *     leading or trailing space;
 *   - anything else is REJECTED rather than canonicalised, because silently
 *     rewriting a phone number changes who receives the message.
 *
 * WHAT IT IS NOT: generating, copying, or scanning this asset does not
 * configure a messaging provider, enroll anybody, transmit an inbound
 * callback to Moosewave, or record or prove consent. The sheet says so out
 * loud; this module never implies otherwise.
 *
 * Import-free (no react-native, no expo-*) so the node vitest environment
 * drives every shape.
 */

/** The fields an operator fills in. Raw, exactly as typed. */
export type TapToTextDraft = {
  destination: string;
  keyword: string;
  label: string;
};

/** The generated artifact, once every field validates. */
export type TapToTextBlock = {
  /** The canonical destination the link addresses (short code or E.164). */
  destination: string;
  /** `sms:<destination>?body=<keyword>` — RFC 5724. */
  uri: string;
  /** The paste-ready anchor for an email/web creative. */
  html: string;
  /** What the anchor shows: the typed label, else the generated sentence. */
  buttonLabel: string;
};

/** Longest raw destination string accepted before parsing (desktop parity). */
const MAX_DESTINATION_INPUT = 32;
/** Scalar ceiling on the keyword (the SMS body) and on the button label. */
export const MAX_KEYWORD_SCALARS = 40;
export const MAX_LABEL_SCALARS = 120;

/**
 * UTF-8 byte length WITHOUT TextEncoder: Hermes does not guarantee the global,
 * and this module must run identically in node vitest and on the device.
 */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point === undefined) continue;
    bytes +=
      point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * Canonicalize only explicitly reviewed ASCII display separators. Unknown
 * characters are rejected instead of silently changing recipient identity.
 * Ported from desktop's parseSmsDestination.
 */
export function parseSmsDestination(value: string): string | null {
  if (value.length === 0 || value.length > MAX_DESTINATION_INPUT) return null;
  const trimmed = value.replace(/^ +| +$/gu, "");
  if (trimmed.length === 0 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(trimmed)) {
    return null;
  }
  if (/^[0-9]{5,6}$/u.test(trimmed)) return trimmed;
  if (!/^\+[0-9 ().-]+[0-9]$/u.test(trimmed)) return null;
  const digits = trimmed.slice(1).replace(/[ ().-]/gu, "");
  return /^[1-9][0-9]{6,14}$/u.test(digits) ? `+${digits}` : null;
}

/**
 * Visible, self-contained creative text: no control/format/surrogate scalars,
 * no edge whitespace, within both a scalar and a byte ceiling.
 */
export function isSafeLocalCreativeText(
  value: string,
  maxScalars: number,
  allowEmpty: boolean,
): boolean {
  if (
    value.trim() !== value ||
    (!allowEmpty && value === "") ||
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
  ) {
    return false;
  }
  return (
    Array.from(value).length <= maxScalars &&
    utf8ByteLength(value) <= maxScalars * 4
  );
}

/** `sms:<number>?body=<text>` (RFC 5724). Empty string when either half fails. */
export function buildSmsUri(shortCode: string, body: string): string {
  const destination = parseSmsDestination(shortCode);
  if (!destination || !isSafeLocalCreativeText(body, MAX_KEYWORD_SCALARS, true)) {
    return "";
  }
  // The body is URL-encoded with spaces as %20 (not '+') so every native SMS
  // app renders the keyword cleanly.
  try {
    const encoded = encodeURIComponent(body);
    return body ? `sms:${destination}?body=${encoded}` : `sms:${destination}`;
  } catch {
    return "";
  }
}

/** Attribute- and text-safe escaping for the generated anchor. */
export function escapeEmbedHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] as string,
  );
}

/**
 * The per-field rejection sentences, worded as desktop words them. `null`
 * means "nothing to say" — including for an untouched field, because an empty
 * box the operator has not reached yet is not an error.
 */
export function tapToTextFieldError(
  field: keyof TapToTextDraft,
  value: string,
): string | null {
  if (value === "") return null;
  if (field === "destination") {
    return parseSmsDestination(value)
      ? null
      : "Enter an unambiguous 5–6 digit short code or plus-prefixed E.164 number. Letters, controls, bidi marks, and unsigned long numbers are rejected.";
  }
  if (field === "keyword") {
    return isSafeLocalCreativeText(value, MAX_KEYWORD_SCALARS, false)
      ? null
      : "Use 1–40 visible Unicode characters without leading/trailing space, controls, bidi marks, or invalid surrogates.";
  }
  return isSafeLocalCreativeText(value, MAX_LABEL_SCALARS, true)
    ? null
    : "Use at most 120 visible Unicode characters without leading/trailing space, controls, bidi marks, or invalid surrogates.";
}

/**
 * The whole artifact, or null when any field is missing or illegal. Callers
 * render the block ONLY from a non-null return: there is no partially valid
 * tap-to-text link, and half of one pasted into a campaign is a dead anchor.
 */
export function buildTapToTextBlock(draft: TapToTextDraft): TapToTextBlock | null {
  const destination = parseSmsDestination(draft.destination);
  if (!destination) return null;
  if (!isSafeLocalCreativeText(draft.keyword, MAX_KEYWORD_SCALARS, false)) {
    return null;
  }
  if (!isSafeLocalCreativeText(draft.label, MAX_LABEL_SCALARS, true)) {
    return null;
  }
  const uri = buildSmsUri(destination, draft.keyword);
  if (!uri) return null;
  const buttonLabel = draft.label || `Text ${draft.keyword} to ${destination}`;
  const html = `<a href="${escapeEmbedHtml(uri)}" style="display:inline-block;padding:10px 18px;background:#0e8169;color:#fff;border-radius:6px;font-weight:600;text-decoration:none;font-family:sans-serif;">${escapeEmbedHtml(buttonLabel)}</a>`;
  return { destination, uri, html, buttonLabel };
}

/**
 * What the native share sheet carries. The phone's advantage over desktop is
 * that the link can go straight to a designer in one gesture, so the message
 * names the artifact rather than dropping a bare `sms:` string into a chat
 * with no explanation of what it is.
 */
export function tapToTextShareMessage(block: TapToTextBlock): string {
  return `${block.buttonLabel}\n${block.uri}`;
}
