/**
 * email-byte-size — pure helpers for the Gmail-clipping warning UX.
 *
 * Gmail clips a rendered message past ~102 KB (102,400 bytes); past
 * that point the recipient sees a "[Message clipped] View entire
 * message" link and tracking-pixel / unsubscribe links below the cut
 * are hidden. Ghost / Substack / Beehiiv all surface a live byte meter
 * in their composer; Moosewave didn't, which silently bit long
 * newsletters (esp. ones with inlined base64 images).
 *
 * Lives in lib/ — pure functions, no React, no DOM. Caller passes the
 * rendered HTML string (already templated, base64 expanded where the
 * caller chose to expand) and gets back a byte count + verdict.
 *
 * Inspired by Ghost's compose toolbar size indicator.
 */

/** Gmail's documented clipping threshold — 102 KB = 102,400 bytes. */
export const GMAIL_CLIP_THRESHOLD_BYTES = 102_400;

/** Past this fraction we show the amber warning. */
export const SOFT_WARN_RATIO = 0.8;

/** Past this fraction we show the red hard-stop. */
export const HARD_STOP_RATIO = 1.0;

export type ClipVerdict = "ok" | "warn" | "critical";

export interface ByteSizeMeasurement {
  /** UTF-8 byte length of the rendered HTML body. */
  bytes: number;
  /** bytes / GMAIL_CLIP_THRESHOLD_BYTES, clamped to [0, +∞). */
  ratio: number;
  /** Verdict bucket for UI colour + copy. */
  verdict: ClipVerdict;
  /** Bytes left before the hard cutoff. Negative when over. */
  remainingBytes: number;
  /** Number of embedded base64 image payloads we detected — useful so
   *  the warning copy can suggest hosting them externally. */
  embeddedImageCount: number;
  /** Bytes contributed by embedded base64 images. Helps the operator
   *  understand the "why" without manually counting. */
  embeddedImageBytes: number;
}

/**
 * Count the UTF-8 byte length of a string. We use TextEncoder when
 * present (browser / Tauri) and fall back to a manual count in tests
 * that monkey-patch the global out.
 */
export function utf8ByteLength(s: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(s).length;
  }
  // Manual fallback — counts valid surrogate pairs as 4 bytes (correct
  // UTF-8). A lone high surrogate (not followed by a low surrogate)
  // encodes as the 3-byte replacement character; only consume the next
  // char when it's actually a low surrogate, otherwise an unpaired high
  // surrogate would swallow the following character and miscount.
  let len = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) len += 1;
    else if (c < 0x800) len += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        len += 4;
        i += 1; // consume the low surrogate
      } else {
        len += 3;
      }
    } else len += 3;
  }
  return len;
}

/**
 * Detect base64-embedded images in an HTML string and tally how many
 * bytes their data: URLs cost on the wire. This is the dominant
 * contributor to over-threshold emails in practice — pasted screenshots
 * from email clients often inline a 200KB+ PNG without the operator
 * noticing.
 *
 * Matches both `<img src="data:image/...">` and CSS `background:
 * url(data:image/...)` forms; matches single + double quotes.
 */
export function measureEmbeddedImages(html: string): {
  count: number;
  bytes: number;
} {
  if (!html) return { count: 0, bytes: 0 };
  // Match data: URIs with image/* media types. Non-greedy up to the
  // closing quote / paren so we don't span multiple attributes.
  const re = /data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)/gi;
  let m: RegExpExecArray | null;
  let count = 0;
  let bytes = 0;
  while ((m = re.exec(html)) !== null) {
    count += 1;
    // The full match (m[0]) is what travels in the HTML — that's the
    // wire cost. Counting just the base64 payload would understate.
    bytes += utf8ByteLength(m[0]);
  }
  return { count, bytes };
}

/**
 * Classify the bytes against the Gmail threshold. Pure function — the
 * caller decides which UI to render based on the verdict.
 */
export function classifyClipVerdict(bytes: number): ClipVerdict {
  const ratio = bytes / GMAIL_CLIP_THRESHOLD_BYTES;
  if (ratio >= HARD_STOP_RATIO) return "critical";
  if (ratio >= SOFT_WARN_RATIO) return "warn";
  return "ok";
}

/**
 * One-shot measurement — call from the Preview pane / send-confirm
 * banner. Cheap; OK to recompute on every keystroke for moderate-size
 * bodies (sub-millisecond for 100KB).
 */
export function measureEmailByteSize(html: string): ByteSizeMeasurement {
  const bytes = utf8ByteLength(html ?? "");
  const ratio = GMAIL_CLIP_THRESHOLD_BYTES > 0
    ? bytes / GMAIL_CLIP_THRESHOLD_BYTES
    : 0;
  const verdict = classifyClipVerdict(bytes);
  const { count: embeddedImageCount, bytes: embeddedImageBytes } =
    measureEmbeddedImages(html ?? "");
  return {
    bytes,
    ratio,
    verdict,
    remainingBytes: GMAIL_CLIP_THRESHOLD_BYTES - bytes,
    embeddedImageCount,
    embeddedImageBytes,
  };
}

/** Format a byte count as a human-readable string ("87.3 KB"). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

/**
 * One-line human-readable verdict copy. Lives next to the lib so the
 * messaging stays consistent between the Preview-pane meter, the
 * send-confirm banner, and any future surfaces (e.g. archive
 * health-check dashboard).
 */
export function verdictMessage(m: ByteSizeMeasurement): string {
  if (m.verdict === "critical") {
    const over = formatBytes(Math.max(0, -m.remainingBytes));
    const tail =
      m.embeddedImageCount > 0
        ? ` ${m.embeddedImageCount} embedded image${m.embeddedImageCount === 1 ? "" : "s"} (${formatBytes(m.embeddedImageBytes)}) — host externally to recover space.`
        : "";
    return `Email is ${formatBytes(m.bytes)} (${over} over Gmail's 102 KB clipping limit). Gmail will hide tracking pixels + unsubscribe links below the cut.${tail}`;
  }
  if (m.verdict === "warn") {
    const tail =
      m.embeddedImageCount > 0
        ? ` ${m.embeddedImageCount} embedded image${m.embeddedImageCount === 1 ? "" : "s"} account for ${formatBytes(m.embeddedImageBytes)}.`
        : "";
    return `Email is ${formatBytes(m.bytes)} (${Math.round(m.ratio * 100)}% of Gmail's 102 KB clipping limit). Trim content before sending.${tail}`;
  }
  return `Email is ${formatBytes(m.bytes)} — well under Gmail's 102 KB clipping limit.`;
}
