/**
 * translations-helpers — pure logic behind composer/TranslationsPanel.
 *
 * Locale lists travel the wire as `string[]` but are edited as a
 * comma-separated text field; dictionary translations travel as a
 * `Record<locale, term>` but are edited as ordered (locale, value)
 * pair rows. Both conversions live here so they're testable without
 * a DOM.
 */

/** Parse a comma/whitespace-separated locale list ("en, sv-SE de").
 *  Trims, drops empties, dedupes case-insensitively (first wins). */
export function parseLocaleList(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[,\s]+/)) {
    const locale = raw.trim();
    if (!locale) continue;
    const key = locale.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(locale);
  }
  return out;
}

export function formatLocaleList(locales: string[]): string {
  return locales.join(", ");
}

/** One editable dictionary translation row. */
export interface LocalePair {
  locale: string;
  value: string;
}

/** Record → ordered pair rows (sorted by locale for stable rendering). */
export function pairsFromTranslations(
  translations: Record<string, string>,
): LocalePair[] {
  return Object.entries(translations)
    .map(([locale, value]) => ({ locale, value }))
    .sort((a, b) => a.locale.localeCompare(b.locale));
}

/** Pair rows → wire record. Rows with an empty locale or value are
 *  dropped (half-filled editor rows must not corrupt the entry);
 *  duplicate locales keep the LAST row, matching "what you see last
 *  is what saves". */
export function translationsFromPairs(
  pairs: LocalePair[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const locale = p.locale.trim();
    const value = p.value.trim();
    if (!locale || !value) continue;
    out[locale] = value;
  }
  return out;
}

/** True when a dictionary entry form can be submitted. */
export function dictionaryEntryValid(
  term: string,
  pairs: LocalePair[],
): boolean {
  if (term.trim() === "") return false;
  return Object.keys(translationsFromPairs(pairs)).length > 0;
}

/**
 * Honest error copy for the LLM-backed preview call. 429 and 502 get
 * specific, actionable messages (per the manifest both are expected
 * states, not bugs); everything else passes the server message
 * through.
 */
export function translatePreviewErrorCopy(err: {
  status?: number;
  message: string;
  retryAfterSeconds?: number;
}): string {
  if (err.status === 429) {
    const wait =
      err.retryAfterSeconds != null
        ? ` Try again in ~${err.retryAfterSeconds}s.`
        : " Try again in a moment.";
    return `Translation rate-limited.${wait}`;
  }
  // GAP-3#12: the backend surfaces ALL translation gateway failures — including
  // the no-gateway-configured case (RenderBody → aicompose.ErrVoiceUnavailable
  // when AI == nil) — as 502 translate_failed
  // (apps/api/internal/translations/translations.go:938), never 503. The old
  // `=== 503` branch was unreachable, so operators saw the generic
  // "translation gateway unavailable" instead of this actionable guidance.
  // Match 502 (keep 503 for forward-compat if the backend ever distinguishes).
  if (err.status === 502 || err.status === 503) {
    return "Translation model isn't configured or reachable — ask an admin to wire the AI gateway on this server.";
  }
  return err.message;
}
