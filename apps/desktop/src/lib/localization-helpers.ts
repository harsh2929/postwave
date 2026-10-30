// Pure helpers for the subscriber localization editor (SUB-005). Kept separate
// from the React component so the normalize / validate / dirty-detect /
// build-patch logic is unit-testable without a DOM.

export interface LocalizationDraft {
  locale: string;
  language: string;
  country: string;
  region: string;
}

export interface LocalizationSource {
  locale?: string | null;
  language?: string | null;
  country?: string | null;
  region?: string | null;
}

/** Build the editable draft from a subscriber detail (nulls → ""). */
export function localizationDraftFrom(s: LocalizationSource): LocalizationDraft {
  return {
    locale: (s.locale ?? "").trim(),
    language: (s.language ?? "").trim(),
    country: (s.country ?? "").trim(),
    region: (s.region ?? "").trim(),
  };
}

/** ISO 639-1: two lowercase letters. */
export function normalizeLanguage(v: string): string {
  return v.trim().toLowerCase().slice(0, 2);
}

/** ISO 3166-1 alpha-2: two uppercase letters. */
export function normalizeCountry(v: string): string {
  return v.trim().toUpperCase().slice(0, 2);
}

/** BCP-47 tag: trimmed, primary subtag lowercased, region subtag uppercased. */
export function normalizeLocale(v: string): string {
  const t = v.trim();
  if (t === "") return "";
  const [lang, ...rest] = t.split(/[-_]/);
  const parts = [lang.toLowerCase(), ...rest.map((p) => (p.length === 2 ? p.toUpperCase() : p))];
  return parts.join("-");
}

/** Normalize every field of a draft. Region is free-text (trim only). */
export function normalizeLocalization(d: LocalizationDraft): LocalizationDraft {
  return {
    locale: normalizeLocale(d.locale),
    language: normalizeLanguage(d.language),
    country: normalizeCountry(d.country),
    region: d.region.trim(),
  };
}

/**
 * Validate a (already-normalized) draft. Each field is optional; when present
 * it must match its standard's shape. Returns an operator-facing error string
 * or null when valid.
 */
export function validateLocalization(d: LocalizationDraft): string | null {
  if (d.language !== "" && !/^[a-z]{2}$/.test(d.language)) {
    return "Language must be a 2-letter ISO 639-1 code (e.g. en).";
  }
  if (d.country !== "" && !/^[A-Z]{2}$/.test(d.country)) {
    return "Country must be a 2-letter ISO 3166-1 code (e.g. US).";
  }
  if (d.locale !== "" && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(d.locale)) {
    return "Locale must be a BCP-47 tag (e.g. en-US).";
  }
  if (d.region.length > 120) {
    return "Region is too long.";
  }
  return null;
}

/** True when the draft differs from the persisted source. */
export function localizationDirty(d: LocalizationDraft, s: LocalizationSource): boolean {
  const cur = localizationDraftFrom(s);
  return (
    d.locale !== cur.locale ||
    d.language !== cur.language ||
    d.country !== cur.country ||
    d.region !== cur.region
  );
}

/** The PATCH body sent to api.updateSubscriber (normalized). */
export function buildLocalizationPatch(d: LocalizationDraft): {
  locale: string;
  language: string;
  country: string;
  region: string;
} {
  const n = normalizeLocalization(d);
  return { locale: n.locale, language: n.language, country: n.country, region: n.region };
}
