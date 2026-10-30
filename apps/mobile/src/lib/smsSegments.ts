/**
 * lib/smsSegments.ts — how many SMS segments a reply will actually cost.
 *
 * SMS is billed per segment, and the segment size depends on the ALPHABET, not
 * just the length: a message that fits the GSM 03.38 character set gets 160
 * characters per segment (153 once it is concatenated, because 7 bytes go to
 * the multipart header), while a single character outside that set — an emoji,
 * a curly quote pasted from a document, an accented name — forces the whole
 * message to UCS-2 and collapses the segment to 70 characters (67 concatenated).
 *
 * That is why one emoji can triple the cost of a 200-character reply, and why
 * the composer needs to say so before the operator hits send rather than after
 * the invoice arrives.
 *
 * This is a deliberate approximation of the GSM alphabet: the base set plus the
 * extension characters, which each cost TWO septets. It is used to warn, not to
 * bill — the provider's own count is authoritative.
 */

const GSM_BASE =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";

/** Characters that exist in GSM only via an escape, costing two septets each. */
const GSM_EXTENDED = "^{}\\[~]|€";

const GSM_SINGLE = new Set(GSM_BASE.split(""));
const GSM_DOUBLE = new Set(GSM_EXTENDED.split(""));

const GSM_SINGLE_LIMIT = 160;
const GSM_CONCAT_LIMIT = 153;
const UCS2_SINGLE_LIMIT = 70;
const UCS2_CONCAT_LIMIT = 67;

/** Show the counter once the message is close enough for the count to matter. */
const COUNTER_THRESHOLD = 40;

export interface SegmentInfo {
  /** Characters as the user sees them (code points, so an emoji counts once). */
  characters: number;
  /** Billable segments. 0 for an empty message. */
  segments: number;
  /** True when the message left the GSM alphabet and dropped to UCS-2. */
  unicode: boolean;
  /** Characters left in the current segment. */
  remaining: number;
  showCounter: boolean;
}

export function segmentInfo(text: string): SegmentInfo {
  const chars = Array.from(text ?? "");
  const characters = chars.length;
  if (characters === 0) {
    return {
      characters: 0,
      segments: 0,
      unicode: false,
      remaining: GSM_SINGLE_LIMIT,
      showCounter: false,
    };
  }

  let unicode = false;
  let septets = 0;
  for (const ch of chars) {
    if (GSM_SINGLE.has(ch)) {
      septets += 1;
    } else if (GSM_DOUBLE.has(ch)) {
      septets += 2;
    } else {
      unicode = true;
      break;
    }
  }

  if (unicode) {
    // UCS-2 counts UTF-16 code units, so an astral emoji costs two.
    const units = (text ?? "").length;
    const segments =
      units <= UCS2_SINGLE_LIMIT
        ? 1
        : Math.ceil(units / UCS2_CONCAT_LIMIT);
    const capacity =
      segments === 1 ? UCS2_SINGLE_LIMIT : segments * UCS2_CONCAT_LIMIT;
    return {
      characters,
      segments,
      unicode: true,
      remaining: Math.max(0, capacity - units),
      showCounter: true,
    };
  }

  const segments =
    septets <= GSM_SINGLE_LIMIT ? 1 : Math.ceil(septets / GSM_CONCAT_LIMIT);
  const capacity =
    segments === 1 ? GSM_SINGLE_LIMIT : segments * GSM_CONCAT_LIMIT;
  return {
    characters,
    segments,
    unicode: false,
    remaining: Math.max(0, capacity - septets),
    showCounter: characters >= COUNTER_THRESHOLD,
  };
}
