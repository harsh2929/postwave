/**
 * lib/campaignBody.ts — turning a campaign body into something a phone can
 * render, without melting the JS thread.
 *
 * The previous implementation lived inline in campaigns/[id].tsx and ran
 * ELEVEN chained `.replace()` passes over the entire body_html — two of them
 * `[\s\S]*?` backtracking patterns for <style>/<script> — on every render,
 * unmemoised. A 400KB MJML-derived body re-ran all of that whenever a modal
 * opened or a refetch ticked, and the result was then thrown away after
 * slicing to 2,000 characters.
 *
 * Two changes: the source is bounded BEFORE the regexes run (only the first
 * few thousand output characters are ever displayed), and the whole thing is
 * a pure function the view memoises on the three body fields.
 */

/**
 * How much source HTML is scanned. Generous enough that the ~2,000 characters
 * the card shows are always available even for markup-heavy MJML output, and
 * small enough that the regex passes are bounded work.
 */
export const BODY_SCAN_LIMIT = 24_000;

export interface CampaignBodyFields {
  body_html?: string | null | undefined;
  body_mjml?: string | null | undefined;
  plain_text?: string | null | undefined;
}

export function trimmedBody(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/**
 * Strip HTML tags and decode the most common entities.
 *
 * `limit` bounds the INPUT, not the output: a body larger than the limit is
 * truncated at a tag boundary-ish point before any scanning happens.
 */
export function htmlToText(html: string, limit = BODY_SCAN_LIMIT): string {
  const source = html.length > limit ? html.slice(0, limit) : html;
  return source
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr|br|hr)>/gi, "\n")
    .replace(/<br\s*\/?>(?!\n)/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function campaignHasBody(
  c: CampaignBodyFields | null | undefined,
): boolean {
  return (
    trimmedBody(c?.body_html).length > 0 ||
    trimmedBody(c?.body_mjml).length > 0 ||
    trimmedBody(c?.plain_text).length > 0
  );
}

/** The body the placement predictor should analyse. */
export function campaignBodyForPrediction(
  c: CampaignBodyFields | null | undefined,
): string {
  const bodyHtml = trimmedBody(c?.body_html);
  if (bodyHtml.length > 0) return bodyHtml;
  const bodyMjml = trimmedBody(c?.body_mjml);
  if (bodyMjml.length > 0) return bodyMjml;
  return trimmedBody(c?.plain_text);
}

/** Readable preview text, preferring the already-plain body. */
export function campaignPreviewText(
  c: CampaignBodyFields | null | undefined,
): string | null {
  if (!c) return null;
  const plainText = trimmedBody(c.plain_text);
  if (plainText.length > 0) {
    return plainText.length > BODY_SCAN_LIMIT
      ? plainText.slice(0, BODY_SCAN_LIMIT)
      : plainText;
  }
  const bodyHtml = trimmedBody(c.body_html);
  if (bodyHtml.length > 0) return htmlToText(bodyHtml);
  const bodyMjml = trimmedBody(c.body_mjml);
  if (bodyMjml.length > 0) return htmlToText(bodyMjml);
  return null;
}

/**
 * True when the body carries conditional/dynamic regions, whose branches the
 * plain-text preview silently merges into one blob. Detects both the
 * data-attribute markers the composer emits and the template-conditional
 * syntax the engine understands.
 */
export function hasDynamicRegions(
  c: CampaignBodyFields | null | undefined,
): boolean {
  const source = trimmedBody(c?.body_html) || trimmedBody(c?.body_mjml);
  if (!source) return false;
  const window =
    source.length > BODY_SCAN_LIMIT ? source.slice(0, BODY_SCAN_LIMIT) : source;
  return (
    /data-pw-region|data-postwave-region/i.test(window) ||
    /\{\{\s*(?:#|if\s)/.test(window)
  );
}
