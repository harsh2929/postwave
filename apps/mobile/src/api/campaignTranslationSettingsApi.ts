/**
 * api/campaignTranslationSettingsApi.ts — the tenant translation settings and
 * terminology dictionary transport (apps/api/internal/translations).
 *
 * Routes + session floors re-verified in the routeauth manifest 2026-08-30:
 *   GET    /api/v1/translations/settings           viewer
 *   PUT    /api/v1/translations/settings           ADMIN
 *   GET    /api/v1/translations/dictionary         viewer
 *   POST   /api/v1/translations/dictionary         ADMIN
 *   DELETE /api/v1/translations/dictionary/{id}    ADMIN
 *   POST   /api/v1/translations/preview            ADMIN
 *
 * Every write here is ONLINE-ONLY by design: these are workspace-wide policy
 * knobs and shared dictionary rows — replaying a stale copy from an offline
 * queue hours later could flip a default or resurrect a term someone else
 * deleted in the meantime. CSV import/export stays on the web.
 */
import { rawRequest, type AIApiResult } from "./request";

export interface PutTranslationSettingsBody {
  enabled?: boolean;
  default_locale?: string;
  supported_locales?: string[];
  fallback_strategy?: string;
  locale_attribute?: string;
}

/** GET /api/v1/translations/settings */
export async function getTranslationSettings(): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>("GET", "/api/v1/translations/settings");
}

/** PUT /api/v1/translations/settings — PARTIAL: omitted fields keep their value. */
export async function putTranslationSettings(
  body: PutTranslationSettingsBody,
): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>("PUT", "/api/v1/translations/settings", body);
}

/** GET /api/v1/translations/dictionary → {entries: [...]}. */
export async function listTranslationDictionary(): Promise<
  AIApiResult<unknown>
> {
  return rawRequest<unknown>("GET", "/api/v1/translations/dictionary");
}

export interface UpsertDictionaryEntryBody {
  term: string;
  translations: Record<string, string>;
  case_sensitive: boolean;
  notes: string;
}

/** POST /api/v1/translations/dictionary — upsert by term. */
export async function upsertTranslationDictionaryEntry(
  body: UpsertDictionaryEntryBody,
): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>("POST", "/api/v1/translations/dictionary", body);
}

/** DELETE /api/v1/translations/dictionary/{id} → 204. */
export async function deleteTranslationDictionaryEntry(
  id: string,
): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>(
    "DELETE",
    `/api/v1/translations/dictionary/${encodeURIComponent(id)}`,
  );
}

/** POST /api/v1/translations/preview — the LLM round-trip, press-driven only. */
export async function previewTranslationRender(input: {
  body: string;
  locale: string;
}): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>("POST", "/api/v1/translations/preview", input);
}
