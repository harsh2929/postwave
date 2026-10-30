/**
 * archivePreviewText — turn a published issue's stored HTML into readable
 * plain text for the in-app preview sheet.
 *
 * WHY THIS EXISTS RATHER THAN A WEBVIEW. `react-native-webview` is not a
 * dependency of apps/mobile, so there is no renderer on device that can
 * execute the issue's markup. The honest alternative is not "show nothing"
 * and it is definitely not "dump the raw tags at the user" — it is to extract
 * the text the issue actually says, label it as a text preview, and keep the
 * full-fidelity path (open the public URL in the in-app browser) one tap away.
 *
 * The transform is deliberately conservative:
 *   - `<script>` / `<style>` / `<head>`-ish blocks are dropped WITH their
 *     content. Rendering minified CSS as "body copy" is the failure mode that
 *     makes naive tag-strippers useless on real newsletter HTML.
 *   - Block-level tags become paragraph breaks so the result has structure,
 *     rather than one 4,000-character run-on line.
 *   - `<a href>` keeps the link target in parentheses when the anchor text
 *     does not already contain it: on a preview whose whole job is "did the
 *     right link go out?", losing hrefs would defeat the purpose.
 *   - Entities are decoded for the handful that appear in prose. An unknown
 *     entity is left verbatim rather than guessed at.
 *
 * Pure and import-free on purpose: this is the half of the preview that can be
 * tested under the node vitest environment.
 */

/** Tags whose CONTENT is not prose and must be discarded, not flattened. */
const DROPPED_BLOCKS =
  /<(script|style|head|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Tags that imply a visual break in the reading order. */
const BLOCK_BOUNDARY =
  /<\/?(?:p|div|tr|table|section|article|header|footer|ul|ol|li|h[1-6]|blockquote|pre|hr)\b[^>]*>/gi;

const LINE_BREAK = /<br\s*\/?>/gi;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  bull: "•",
  eacute: "é",
};

/**
 * Decode the entities that actually turn up in newsletter prose. Numeric
 * entities are decoded when they land in a sane codepoint range; anything
 * else is left exactly as written, because a wrong guess is a wrong word.
 */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, body) => {
    const raw = String(body);
    if (raw.startsWith("#")) {
      const hex = raw[1] === "x" || raw[1] === "X";
      const digits = hex ? raw.slice(2) : raw.slice(1);
      const code = Number.parseInt(digits, hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      // Lone surrogates are not representable; leaving the entity is honest.
      if (code >= 0xd800 && code <= 0xdfff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[raw.toLowerCase()];
    return named ?? match;
  });
}

/** `<a href="…">text</a>` → `text (href)` when the href adds information. */
function inlineAnchorTargets(html: string): string {
  return html.replace(
    /<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_match, _quote, href: string, inner: string) => {
      const target = href.trim();
      if (!target || target.startsWith("#") || /^mailto:/i.test(target)) {
        return inner;
      }
      // The anchor text is often the URL already ("Read at example.com/x") —
      // repeating it would double every link in the preview.
      const text = inner.replace(/<[^>]*>/g, "").trim();
      if (!text) return ` ${target} `;
      if (text.includes(target)) return inner;
      return `${inner} (${target})`;
    },
  );
}

/**
 * Collapse an issue body to paragraphs of readable text.
 *
 * Returns `[]` for markup that carries no prose at all, which the caller must
 * render as "this issue has no text content" — never as an empty preview that
 * looks like a still-loading one.
 */
export function htmlToParagraphs(html: string, maxParagraphs = 60): string[] {
  if (!html) return [];
  const withoutDrops = html.replace(DROPPED_BLOCKS, " ");
  const withLinks = inlineAnchorTargets(withoutDrops);
  const withBreaks = withLinks
    .replace(LINE_BREAK, "\n")
    .replace(BLOCK_BOUNDARY, "\n\n")
    // Comments can wrap conditional Outlook markup; drop them wholesale.
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, "");
  const decoded = decodeEntities(withBreaks)
    // Non-breaking and zero-width runs read as ragged whitespace otherwise.
    .replace(/[ ​‌﻿]/g, " ");
  const paragraphs: string[] = [];
  for (const chunk of decoded.split(/\n{2,}/)) {
    const text = chunk
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .filter((line) => line.length > 0)
      .join("\n");
    if (text) paragraphs.push(text);
    if (paragraphs.length >= maxParagraphs) break;
  }
  return paragraphs;
}

/**
 * Whether the preview had to truncate. The sheet says so explicitly — a
 * preview that silently stops mid-issue is how someone concludes the wrong
 * content went out.
 */
export function previewWasTruncated(html: string, maxParagraphs = 60): boolean {
  return htmlToParagraphs(html, maxParagraphs + 1).length > maxParagraphs;
}

/** Approximate reading length, for the "≈4 min read" line. */
export function readingMinutes(paragraphs: readonly string[]): number | null {
  const words = paragraphs.reduce(
    (total, paragraph) =>
      total + paragraph.split(/\s+/u).filter((word) => word.length > 0).length,
    0,
  );
  // ABSENCE IS NOT ZERO: an issue we could not read text out of has no
  // measurable reading time, and "0 min read" would be a claim about it.
  if (words === 0) return null;
  return Math.max(1, Math.round(words / 220));
}
