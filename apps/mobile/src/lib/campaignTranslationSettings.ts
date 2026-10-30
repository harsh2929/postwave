/**
 * lib/campaignTranslationSettings.ts — the TENANT half of translations: the
 * workspace settings and the terminology dictionary, pure and node-testable.
 *
 * The per-campaign locale variants (lib/campaignTranslations) tell a reviewer
 * what exists; this layer is what lets an admin turn the machinery on, choose
 * the locales, and fix a mistranslated brand term — desktop's
 * TranslationsPanel (composer/TranslationsPanel.tsx), minus CSV import/export,
 * which stays on the web (file wrangling is not phone work).
 *
 * Wire shapes (apps/api/internal/translations/translations.go):
 *   GET  /translations/settings          → Settings (bare object)
 *   PUT  /translations/settings          ← partial {enabled?, default_locale?,
 *        supported_locales?, fallback_strategy?, locale_attribute?} → Settings
 *   GET  /translations/dictionary        → {entries: [DictionaryEntry]}
 *   POST /translations/dictionary        ← {term, translations, case_sensitive,
 *        notes} → DictionaryEntry
 *   DELETE /translations/dictionary/{id} → 204
 *   POST /translations/preview           ← {body, locale} → {body, locale,
 *        cache_hit, dictionary_matches, skipped}
 *
 * The client-side validators MIRROR the server's (validateLocale /
 * validateTerm, translations.go:1084/1104) so a bad value reads as a field
 * hint instead of a 400.
 */

export type TranslationFallbackStrategy = "subscriber_locale" | "default_only";

export interface TranslationSettingsReading {
  enabled: boolean;
  defaultLocale: string;
  supportedLocales: string[];
  fallbackStrategy: TranslationFallbackStrategy;
  localeAttribute: string;
}

/** GET /translations/settings response → reading, or null off-shape. */
export function readTranslationSettings(
  data: unknown,
): TranslationSettingsReading | null {
  if (!data || typeof data !== "object") return null;
  const body = data as {
    enabled?: unknown;
    default_locale?: unknown;
    supported_locales?: unknown;
    fallback_strategy?: unknown;
    locale_attribute?: unknown;
  };
  if (typeof body.enabled !== "boolean") return null;
  const defaultLocale =
    typeof body.default_locale === "string" ? body.default_locale : "";
  const supported = Array.isArray(body.supported_locales)
    ? body.supported_locales.filter((l): l is string => typeof l === "string")
    : [];
  return {
    enabled: body.enabled,
    defaultLocale,
    supportedLocales: supported,
    fallbackStrategy:
      body.fallback_strategy === "default_only"
        ? "default_only"
        : "subscriber_locale",
    localeAttribute:
      typeof body.locale_attribute === "string" ? body.locale_attribute : "",
  };
}

export interface TranslationDictionaryEntry {
  id: string;
  term: string;
  /** locale → the mandated translation of the term. */
  translations: Record<string, string>;
  caseSensitive: boolean;
  notes: string;
}

/** GET /translations/dictionary response ({entries}) → rows, [] off-shape. */
export function readDictionaryEntries(
  data: unknown,
): TranslationDictionaryEntry[] {
  if (!data || typeof data !== "object") return [];
  const entries = (data as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];
  const out: TranslationDictionaryEntry[] = [];
  for (const item of entries) {
    if (!item || typeof item !== "object") continue;
    const row = item as {
      id?: unknown;
      term?: unknown;
      translations?: unknown;
      case_sensitive?: unknown;
      notes?: unknown;
    };
    if (typeof row.id !== "string" || typeof row.term !== "string") continue;
    const translations: Record<string, string> = {};
    if (row.translations && typeof row.translations === "object") {
      for (const [locale, text] of Object.entries(
        row.translations as Record<string, unknown>,
      )) {
        if (typeof text === "string") translations[locale] = text;
      }
    }
    out.push({
      id: row.id,
      term: row.term,
      translations,
      caseSensitive: row.case_sensitive === true,
      notes: typeof row.notes === "string" ? row.notes : "",
    });
  }
  return out;
}

/** Mirrors translations.go validateLocale: 2..16 chars, [a-zA-Z0-9_-] only. */
export function localeProblem(raw: string): string | null {
  const value = raw.trim();
  if (value.length < 2 || value.length > 16) {
    return "A locale is 2–16 characters, like en or pt-BR.";
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    return "Locales may only use letters, digits, - and _.";
  }
  return null;
}

/**
 * Mirrors translations.go validateTerm: 1..256 chars, no control characters
 * (tab excepted server-side, rejected here — a tabbed term is a paste error),
 * and never the LLM masking sentinel.
 */
export function termProblem(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0 || value.length > 256) {
    return "A term is 1–256 characters.";
  }
  if (value.includes("[[PWMASK") || value.includes("]]")) {
    return "Terms cannot contain the reserved marker [[ ]].";
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(value)) {
    return "Terms cannot contain control characters.";
  }
  return null;
}

/**
 * "en, pt-BR de" → trimmed, deduped, in typed order — the same normalization
 * the server applies to supported_locales, done up front so what is saved is
 * what the field showed.
 */
export function parseLocalesList(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const piece of text.split(/[\s,]+/)) {
    const locale = piece.trim();
    if (locale === "" || seen.has(locale)) continue;
    seen.add(locale);
    out.push(locale);
  }
  return out;
}

/** The card caption for the current settings — state, in words. */
export function translationSettingsSentence(
  reading: TranslationSettingsReading,
): string {
  if (!reading.enabled) {
    return "Automatic translation is off — every recipient gets the default language.";
  }
  const n = reading.supportedLocales.length;
  const locales =
    n === 0 ? "no locales yet" : `${n} locale${n === 1 ? "" : "s"}`;
  const fallback =
    reading.fallbackStrategy === "default_only"
      ? "unmatched recipients get the default"
      : "recipients are matched by their own locale";
  return `Automatic translation is on for ${locales} (default ${
    reading.defaultLocale || "unset"
  }); ${fallback}.`;
}

/** One dictionary row's summary line. */
export function dictionaryEntrySummary(
  entry: TranslationDictionaryEntry,
): string {
  const n = Object.keys(entry.translations).length;
  const locales =
    n === 0 ? "no locked translations" : `locked in ${n} locale${n === 1 ? "" : "s"}`;
  return `${entry.term} — ${locales}${entry.caseSensitive ? ", case-sensitive" : ""}`;
}

export interface TranslationPreviewReading {
  body: string;
  locale: string;
  cacheHit: boolean;
  dictionaryMatches: number;
  skipped: boolean;
}

/** POST /translations/preview response → reading, or null off-shape. */
export function readTranslationPreview(
  data: unknown,
): TranslationPreviewReading | null {
  if (!data || typeof data !== "object") return null;
  const body = data as {
    body?: unknown;
    locale?: unknown;
    cache_hit?: unknown;
    dictionary_matches?: unknown;
    skipped?: unknown;
  };
  if (typeof body.body !== "string") return null;
  return {
    body: body.body,
    locale: typeof body.locale === "string" ? body.locale : "",
    cacheHit: body.cache_hit === true,
    dictionaryMatches:
      typeof body.dictionary_matches === "number" &&
      Number.isFinite(body.dictionary_matches)
        ? body.dictionary_matches
        : 0,
    skipped: body.skipped === true,
  };
}

/** The preview's meta line: where the words came from. */
export function translationPreviewNote(
  reading: TranslationPreviewReading,
): string {
  if (reading.skipped) {
    return "Translation is turned off, so the body came back unchanged.";
  }
  const source = reading.cacheHit ? "from the cache" : "freshly translated";
  const matches =
    reading.dictionaryMatches === 0
      ? "no dictionary terms applied"
      : `${reading.dictionaryMatches} dictionary term${
          reading.dictionaryMatches === 1 ? "" : "s"
        } applied`;
  return `Rendered ${source}, ${matches}.`;
}
