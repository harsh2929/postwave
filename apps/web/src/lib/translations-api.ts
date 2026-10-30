/**
 * lib/translations-api.ts — campaign translations.
 *
 * Five `/api/v1/translations/*` paths were reached by desktop and by no web
 * file.
 *
 * `updated_at` arrives as Go's zero time ("0001-01-01T00:00:00Z") on a
 * workspace that has never saved settings — confirmed live. It means "never",
 * and it is routed through `formatWireTimestamp` rather than a date formatter
 * so the screen cannot say "01/01/0001".
 *
 * COVERAGE: the web surface now reaches settings and dictionary reads, CSV
 * import/export, and translation preview. Mutation controls are identity-gated
 * by their caller; this module validates the wire contract and transport.
 */
import { api } from "@/lib/api";

export interface TranslationSettings {
  tenant_id: string;
  enabled: boolean;
  default_locale: string;
  supported_locales: string[];
  fallback_strategy: string;
  locale_attribute: string;
  /** Go zero time when never saved. Use formatWireTimestamp. */
  updated_at?: string;
}

export interface TranslationEntry {
  id?: string;
  term?: string;
  translations?: Record<string, string>;
  case_sensitive?: boolean;
  notes?: string;
  updated_at?: string;
  [k: string]: unknown;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export async function getTranslationSettings(): Promise<TranslationSettings> {
  const res = await api.get<TranslationSettings>(
    "/api/v1/translations/settings",
  );
  return {
    ...res,
    supported_locales: asArray<string>(res?.supported_locales),
  };
}

export async function getTranslationDictionary(): Promise<TranslationEntry[]> {
  const res = await api.get<{ entries?: unknown }>(
    "/api/v1/translations/dictionary",
  );
  return asArray<TranslationEntry>(res?.entries);
}

// --- Glossary CSV export ---
//
// The path only; the caller streams it with fetchTextAuthed and hands the text
// to downloadTextFile, matching the campaign-report export rather than
// pointing an anchor at the URL. A bare <a href> would send the browser to the
// API without the session headers the client attaches, so the download would
// either 401 or arrive as an error page saved under a .csv name.
export const TRANSLATIONS_CSV_PATH =
  "/api/v1/translations/dictionary/export.csv";

/**
 * True when an exported CSV carries a header row and nothing else.
 *
 * An empty export is a valid file, and saving one silently looks identical to
 * saving a full glossary until the operator opens it. Worth saying up front.
 */
export function csvIsHeaderOnly(text: string): boolean {
  const rows = text.split(/\r?\n/u).filter((r) => r.trim() !== "");
  return rows.length <= 1;
}

export interface TranslationPreview {
  body: string;
  locale: string;
  /** True when NO translation was applied — the body came back as sent. */
  skipped: boolean;
  dictionary_matches: number;
  cache_hit: boolean;
}

/**
 * Previews a translated body.
 *
 * `skipped: true` MEANS NOTHING WAS TRANSLATED. The body is returned
 * unchanged, so a preview pane showing it implies a translation that did not
 * happen — the reader sees their own English copy labelled "fr" and concludes
 * the locale is covered. `dictionary_matches` says why: with zero glossary
 * entries there is nothing to substitute.
 */
export async function previewTranslation(
  body: string,
  locale: string,
): Promise<TranslationPreview> {
  const r = await api.post<Record<string, unknown>>(
    "/api/v1/translations/preview",
    { body, locale },
  );
  const n = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  return {
    body: typeof r?.body === "string" ? r.body : "",
    locale: typeof r?.locale === "string" ? r.locale : "",
    skipped: r?.skipped === true,
    dictionary_matches: n(r?.dictionary_matches),
    cache_hit: r?.cache_hit === true,
  };
}

/**
 * Imports a glossary CSV.
 *
 * MULTIPART, not JSON — the endpoint answers `unsupported_media_type` to a
 * JSON body. The file is sent as form data so the server parses it as an
 * upload rather than rejecting the request outright.
 */
export const GLOSSARY_CSV_MAX_BYTES = 5 * 1024 * 1024;

export interface GlossaryImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`Translation import returned an invalid ${field} count.`);
  }
  return Number(value);
}

export async function importGlossaryCsv(
  file: File,
  signal?: AbortSignal,
): Promise<GlossaryImportResult> {
  if (file.size <= 0) throw new Error("Choose a non-empty glossary CSV file.");
  if (file.size > GLOSSARY_CSV_MAX_BYTES) {
    throw new Error("Glossary CSV files must be 5 MiB or smaller.");
  }
  const form = new FormData();
  form.append("file", file);
  const raw = await api.postRaw<Record<string, unknown>>(
    "/api/v1/translations/dictionary/import",
    form,
    { signal, requireOnline: true, maxAttempts: 1 },
  );
  const errors = raw?.errors === undefined ? [] : raw.errors;
  if (!Array.isArray(errors) || errors.some((row) => typeof row !== "string")) {
    throw new Error("Translation import returned an invalid errors list.");
  }
  return {
    imported: nonNegativeInteger(raw.imported, "imported"),
    skipped: nonNegativeInteger(raw.skipped, "skipped"),
    errors,
  };
}

/* ---------- Settings write ------------------------------------------ *
 *
 * PUT is ScopeAdmin server-side (apps/api/internal/translations/
 * translations.go:207) because enabling translation routes every send
 * through the LLM gateway — a billing-impacting choice. Editors may write the
 * dictionary but NOT these settings, so the caller gates on owner/admin.
 */

/** The two strategies putSettings accepts; anything else is a 400. */
export const TRANSLATION_FALLBACK_STRATEGIES = [
  "subscriber_locale",
  "default_only",
] as const;
export type TranslationFallbackStrategy =
  (typeof TRANSLATION_FALLBACK_STRATEGIES)[number];

export interface TranslationSettingsInput {
  enabled: boolean;
  default_locale: string;
  supported_locales: string[];
  fallback_strategy: TranslationFallbackStrategy;
  locale_attribute: string;
}

/**
 * Mirrors the server's `validateLocale` (translations.go:1084): 2..16 chars,
 * alphanumerics plus `-` and `_`.
 *
 * Duplicated deliberately rather than trusted: a locale the server rejects
 * fails the WHOLE settings write, so a typo in one of five supported locales
 * would otherwise discard the other four edits with a message naming a field
 * the form never highlighted.
 */
export function isValidTranslationLocale(locale: string): boolean {
  return /^[A-Za-z0-9_-]{2,16}$/u.test(locale);
}

/** Splits an operator-typed locale list ("en, fr-CA sv") into its entries. */
export function parseLocaleList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of raw.split(/[\s,]+/u)) {
    const locale = token.trim();
    if (locale === "" || seen.has(locale)) continue;
    seen.add(locale);
    out.push(locale);
  }
  return out;
}

export async function saveTranslationSettings(
  input: TranslationSettingsInput,
): Promise<TranslationSettings> {
  const res = await api.put<TranslationSettings>(
    "/api/v1/translations/settings",
    input,
  );
  return {
    ...res,
    supported_locales: asArray<string>(res?.supported_locales),
  };
}

/* ---------- Dictionary writes --------------------------------------- */

export interface TranslationEntryInput {
  term: string;
  /**
   * Locale → replacement. An EMPTY map is meaningful, not a missing value: it
   * declares a protected term the translator must leave untouched, which is
   * the dictionary's primary purpose.
   */
  translations: Record<string, string>;
  case_sensitive: boolean;
  notes: string;
}

export async function upsertTranslationEntry(
  input: TranslationEntryInput,
): Promise<TranslationEntry> {
  return api.post<TranslationEntry>(
    "/api/v1/translations/dictionary",
    input,
  );
}

/** Server answers 204 with no body; there is nothing to parse. */
export async function deleteTranslationEntry(id: string): Promise<void> {
  await api.delete<void>(
    `/api/v1/translations/dictionary/${encodeURIComponent(id)}`,
  );
}
