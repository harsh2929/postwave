/**
 * lib/campaignTranslations.ts — which languages this campaign actually sends
 * in, and what each recipient really receives.
 *
 * WHAT THE ENDPOINT ANSWERS. `GET /api/v1/campaigns/{id}/translations`
 * (apps/api/internal/campaign_translations/campaign_translations.go:78-79,
 * mounted at main.go:4172) returns
 * `{campaign_id, translations: [{locale, subject, body_html, body_mjml,
 * updated_at}]}`, ordered by locale.
 *
 * WHY THIS IS A REVIEW-SAFETY FEATURE, NOT A NICETY. Mobile shows one language
 * and gives no indication a campaign even HAS translations. So a phone reviewer
 * approving a multilingual send reviews the default locale and approves four
 * others sight unseen. Surfacing the locale list is the difference between
 * "I reviewed this campaign" and "I reviewed one fifth of this campaign".
 *
 * THE FALLBACK RULES ARE PART OF THE ANSWER. The gateway's `pick()` treats an
 * empty translated field as ABSENT and substitutes the campaign default
 * (campaign_translations.go, `pick`). So a translation row that exists with a
 * blank subject does not mean "no subject" — it means Spanish recipients get
 * the ENGLISH subject over the Spanish body. That is the single most likely way
 * a multilingual send goes wrong, it is invisible in the raw payload, and it is
 * why this module reports `usesDefaultSubject` / `usesDefaultBody` per locale
 * rather than just listing what came back.
 *
 * `normalizeLocale` mirrors the Go implementation exactly (lowercase language,
 * uppercase region, split on the first hyphen) so the locale a reviewer reads
 * here is the same string the send loop matches on.
 *
 * DELIBERATELY IMPORT-FREE, so it is testable in the node vitest environment.
 */

export interface TranslationWire {
  locale?: unknown;
  subject?: unknown;
  body_html?: unknown;
  body_mjml?: unknown;
  updated_at?: unknown;
}

export interface TranslationsListWire {
  translations?: unknown;
}

export interface TranslationRow {
  /** Normalised, e.g. "es", "fr-CA". Also the React key. */
  locale: string;
  /** The translated subject, or "" when the default will be used instead. */
  subject: string;
  /** True when this locale's recipients get the campaign's DEFAULT subject. */
  usesDefaultSubject: boolean;
  /** True when this locale's recipients get the campaign's DEFAULT body. */
  usesDefaultBody: boolean;
  updatedAt: number | null;
}

export interface TranslationsReading {
  rows: TranslationRow[];
  /** Locales with at least one field falling back to the default. */
  partialCount: number;
  empty: boolean;
}

export const EMPTY_TRANSLATIONS: TranslationsReading = {
  rows: [],
  partialCount: 0,
  empty: true,
};

/**
 * Mirror of the gateway's `normalizeLocale`: lowercase the language, uppercase
 * the region, split on the FIRST hyphen only.
 */
export function normalizeLocale(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const s = raw.trim();
  if (!s) return "";
  const cut = s.indexOf("-");
  if (cut < 0) return s.toLowerCase();
  const lang = s.slice(0, cut).toLowerCase();
  const rest = s.slice(cut + 1).toUpperCase();
  return `${lang}-${rest}`;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

export function readCampaignTranslations(
  body: TranslationsListWire | null | undefined,
): TranslationsReading {
  const raw = Array.isArray(body?.translations)
    ? (body.translations as TranslationWire[])
    : [];
  const rows: TranslationRow[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (item == null || typeof item !== "object") continue;
    const locale = normalizeLocale(item.locale);
    // A row with no locale cannot be matched by the send loop, so it is not a
    // translation any recipient will ever receive.
    if (!locale || seen.has(locale)) continue;
    seen.add(locale);

    const subject = asText(item.subject);
    // `pick()` substitutes the default for an EMPTY field, so blank body_html
    // AND blank body_mjml together mean the default body is what ships.
    const hasBody = asText(item.body_html) !== "" || asText(item.body_mjml) !== "";
    rows.push({
      locale,
      subject,
      usesDefaultSubject: subject === "",
      usesDefaultBody: !hasBody,
      updatedAt: asTimestamp(item.updated_at),
    });
  }

  rows.sort((a, b) => a.locale.localeCompare(b.locale));
  const partialCount = rows.filter(
    (r) => r.usesDefaultSubject || r.usesDefaultBody,
  ).length;

  return { rows, partialCount, empty: rows.length === 0 };
}

/**
 * The sentence a reviewer needs before approving.
 *
 * Names the count AND the risk, because "4 translations" reads as reassurance
 * while "1 of them falls back to the default" is the thing worth stopping for.
 */
export function translationsSummary(
  reading: TranslationsReading,
): string | null {
  if (reading.empty) return null;
  const n = reading.rows.length;
  const base = `${n} translation${n === 1 ? "" : "s"}: ${reading.rows
    .map((r) => r.locale)
    .join(", ")}.`;
  if (reading.partialCount === 0) return base;
  return `${base} ${reading.partialCount} of them ${
    reading.partialCount === 1 ? "falls" : "fall"
  } back to the campaign default for part of the message.`;
}

/* ---------- authoring (PUT/DELETE …/translations/{locale}) -------------- */

/**
 * Editable rows: the same list read, but KEEPING the body fields.
 *
 * The upsert is a FULL-ROW REPLACE server-side (campaign_translations.go —
 * `ON CONFLICT … SET subject/body_html/body_mjml = EXCLUDED.*`), so a
 * subject-only edit from a phone MUST resend the existing bodies or it erases
 * them. This parser is what makes that possible; `translationUpsertBody`
 * builds the body that preserves them.
 */
export interface TranslationEditRow {
  locale: string;
  subject: string;
  bodyHtml: string;
  bodyMjml: string;
}

export function translationEditRows(
  body: TranslationsListWire | null | undefined,
): TranslationEditRow[] {
  const raw = Array.isArray(body?.translations)
    ? (body.translations as TranslationWire[])
    : [];
  const out: TranslationEditRow[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (item == null || typeof item !== "object") continue;
    const locale = normalizeLocale(item.locale);
    if (!locale || seen.has(locale)) continue;
    seen.add(locale);
    out.push({
      locale,
      subject: typeof item.subject === "string" ? item.subject : "",
      bodyHtml: typeof item.body_html === "string" ? item.body_html : "",
      bodyMjml: typeof item.body_mjml === "string" ? item.body_mjml : "",
    });
  }
  out.sort((a, b) => a.locale.localeCompare(b.locale));
  return out;
}

/** PUT body: the new subject over the PRESERVED bodies. */
export function translationUpsertBody(
  row: TranslationEditRow,
  subject: string,
): { subject: string; body_html: string; body_mjml: string } {
  return {
    subject: subject.trim(),
    body_html: row.bodyHtml,
    body_mjml: row.bodyMjml,
  };
}

/** Mirror of the gateway's localeRe (campaign_translations.go:53). */
export function localeProblem(raw: string): string | null {
  const value = raw.trim();
  if (!value) return "Enter a locale.";
  return /^[A-Za-z]{2,8}(-[A-Za-z0-9]{2,8})?$/.test(value)
    ? null
    : "Locales look like 'es' or 'fr-CA'.";
}

/**
 * Per-row explanation of what a recipient in this locale actually gets.
 * Null when the translation is complete and needs no caveat.
 */
export function translationFallbackNote(row: TranslationRow): string | null {
  if (row.usesDefaultSubject && row.usesDefaultBody) {
    return "Recipients get the default subject and body — this locale has no content yet.";
  }
  if (row.usesDefaultSubject) {
    return "Recipients get the default subject with the translated body.";
  }
  if (row.usesDefaultBody) {
    return "Recipients get the translated subject with the default body.";
  }
  return null;
}
