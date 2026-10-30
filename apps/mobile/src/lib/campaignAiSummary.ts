/**
 * lib/campaignAiSummary.ts — reading the post-send summary, and rendering the
 * small slice of Markdown it is actually written in.
 *
 * WHAT THE ENDPOINT ANSWERS. `GET /api/v1/campaigns/{id}/summary` returns
 * `{campaign_id, body_markdown, source, inputs_snapshot, generated_at}`
 * (apps/api/internal/campaign_summary/campaign_summary.go:45-50). `source` is
 * `"deterministic"` or `"voice"` — the same prose either way, but one came from
 * a template and one from a model, and that distinction is what the AI
 * disclosure is FOR.
 *
 * A 404 IS NOT AN ERROR HERE, AND CANNOT BE TOLD APART FROM ONE. The handler
 * answers `404 {code:"not_found"}` with "no summary yet — call /regenerate"
 * when nothing has been computed (campaign_summary.go, `get`). The gateway's
 * own catch-all for an unmounted route answers `404 {code:"not_found"}` too
 * (main.go:1502) — the SAME code, deliberately, so every non-2xx carries one
 * envelope. So no client can distinguish "not computed yet" from "this
 * deployment has no summary endpoint" on the read alone, and branching on the
 * message prose would be branching on English.
 *
 * The resolution is behavioural rather than syntactic: treat every 404 as "not
 * computed yet" and offer Generate, then let the WRITE settle it — if
 * regenerate also answers 404/405/501, the capability genuinely is not there,
 * and only then does the card say so. The user's first tap is what disambiguates,
 * and it is a tap they wanted to make anyway.
 *
 * WHY A MARKDOWN PARSER AT ALL. The body is real Markdown: the deterministic
 * renderer emits `**bold**` around every figure and backticked link URLs
 * (campaign_summary.go:425-487), and the voice path may add bullets. Rendering
 * it raw shows a user literal asterisks around their own open rate; pulling in
 * a Markdown library for four constructs is the other kind of mistake. So this
 * handles exactly what the producer emits, and treats anything else as text.
 *
 * EVERYTHING IS BOUNDED. This text comes from a language model. Caps on total
 * length, block count and spans-per-block mean a pathological or adversarial
 * body degrades into truncated prose instead of a frozen main thread.
 *
 * DELIBERATELY IMPORT-FREE, so it is testable in the node vitest environment.
 */

/** Hard ceilings. A summary is a paragraph or three; these are far above that. */
export const SUMMARY_MAX_CHARS = 4000;
export const SUMMARY_MAX_BLOCKS = 40;
export const SUMMARY_MAX_SPANS = 60;

export interface CampaignSummaryWire {
  campaign_id?: unknown;
  body_markdown?: unknown;
  source?: unknown;
  generated_at?: unknown;
}

/** Where the prose came from. Anything unrecognised reads as deterministic. */
export type SummarySource = "deterministic" | "voice";

export interface CampaignSummaryReading {
  markdown: string;
  source: SummarySource;
  /** Epoch ms, or null when the gateway sent no usable timestamp. */
  generatedAt: number | null;
  /** True when there is prose to show. */
  hasBody: boolean;
}

/** One inline run. `bold` and `code` are the only emphasis the producer emits. */
export interface SummarySpan {
  text: string;
  bold: boolean;
  code: boolean;
}

export interface SummaryBlock {
  kind: "paragraph" | "bullet";
  spans: SummarySpan[];
}

export function readCampaignSummary(
  body: CampaignSummaryWire | null | undefined,
): CampaignSummaryReading {
  const raw =
    typeof body?.body_markdown === "string" ? body.body_markdown.trim() : "";
  const markdown =
    raw.length > SUMMARY_MAX_CHARS ? `${raw.slice(0, SUMMARY_MAX_CHARS)}…` : raw;
  const source: SummarySource = body?.source === "voice" ? "voice" : "deterministic";
  let generatedAt: number | null = null;
  if (typeof body?.generated_at === "string" && body.generated_at.trim()) {
    const ms = Date.parse(body.generated_at);
    if (!Number.isNaN(ms)) generatedAt = ms;
  } else if (
    typeof body?.generated_at === "number" &&
    Number.isFinite(body.generated_at)
  ) {
    generatedAt = body.generated_at;
  }
  return { markdown, source, generatedAt, hasBody: markdown.length > 0 };
}

/**
 * Split one line into bold / code / plain runs.
 *
 * Deliberately NOT a general inline parser: `**` and `` ` `` are scanned in one
 * left-to-right pass and an unclosed delimiter is emitted as literal text
 * rather than swallowing the rest of the paragraph — the failure mode that
 * makes hand-rolled Markdown eat a document.
 */
export function parseSummarySpans(line: string): SummarySpan[] {
  const spans: SummarySpan[] = [];
  let plain = "";

  const pushPlain = () => {
    if (plain) {
      spans.push({ text: plain, bold: false, code: false });
      plain = "";
    }
  };

  let i = 0;
  while (i < line.length && spans.length < SUMMARY_MAX_SPANS) {
    if (line.startsWith("**", i)) {
      const end = line.indexOf("**", i + 2);
      if (end > i + 2) {
        pushPlain();
        spans.push({ text: line.slice(i + 2, end), bold: true, code: false });
        i = end + 2;
        continue;
      }
    } else if (line[i] === "`") {
      const end = line.indexOf("`", i + 1);
      if (end > i + 1) {
        pushPlain();
        spans.push({ text: line.slice(i + 1, end), bold: false, code: true });
        i = end + 1;
        continue;
      }
    }
    plain += line[i];
    i += 1;
  }
  // Anything past the span cap stays as one trailing plain run rather than
  // silently disappearing.
  if (i < line.length) plain += line.slice(i);
  pushPlain();
  return spans;
}

/**
 * Blocks, in document order. Blank lines separate paragraphs; a leading
 * `- ` / `* ` makes a bullet.
 */
export function parseSummaryMarkdown(markdown: string): SummaryBlock[] {
  if (!markdown.trim()) return [];
  const blocks: SummaryBlock[] = [];
  const chunks = markdown.split(/\n{2,}/);

  for (const chunk of chunks) {
    if (blocks.length >= SUMMARY_MAX_BLOCKS) break;
    for (const rawLine of chunk.split("\n")) {
      if (blocks.length >= SUMMARY_MAX_BLOCKS) break;
      const line = rawLine.trim();
      if (!line) continue;
      const bullet = /^[-*]\s+/.test(line);
      const text = bullet ? line.replace(/^[-*]\s+/, "") : line;
      const spans = parseSummarySpans(text);
      if (spans.length === 0) continue;
      blocks.push({ kind: bullet ? "bullet" : "paragraph", spans });
    }
  }
  return blocks;
}

/**
 * The plain-text form, for the screen reader and for share/copy.
 *
 * A sighted reader gets emphasis from weight; a VoiceOver user should get the
 * sentence, not the asterisks.
 */
export function summaryPlainText(blocks: readonly SummaryBlock[]): string {
  return blocks.map((b) => b.spans.map((s) => s.text).join("")).join(" ");
}
