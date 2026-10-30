// SPDX-License-Identifier: AGPL-3.0-only
/**
 * lib/campaign-translations-api.ts — the PER-CAMPAIGN locale variant matrix.
 *
 * Deliberately a separate module from `translations-api.ts`, because these are
 * two different products that share a word:
 *
 *  - `/api/v1/translations/*` is the tenant-wide AI translator plus its
 *    terminology dictionary.
 *  - `/api/v1/campaigns/{id}/translations/*` (this file) is N hand-authored
 *    localizations of ONE campaign — subject + body HTML per locale.
 *
 * It is also separate from `campaigns-api.ts` on purpose: nothing here needs
 * that module's ETag ledger or mock fallbacks, and the three routes below are
 * mounted by their own service (apps/api/internal/campaign_translations).
 *
 * WHAT THE SERVER DOES NOT DO YET, stated here because a caller reading only
 * this file would assume otherwise: no send path consults these rows.
 * `ResolveForLocale` exists and is unit-tested but has no dispatch caller, so
 * a saved variant is inert until per-locale routing ships. Screens built on
 * this module must say so rather than implying localized delivery.
 */
import { api } from "@/lib/api";

export interface CampaignTranslation {
  locale: string;
  subject: string;
  body_html: string;
  body_mjml: string;
  updated_at?: string;
}

export interface CampaignTranslationInput {
  subject: string;
  body_html: string;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toTranslation(row: unknown): CampaignTranslation | null {
  if (typeof row !== "object" || row === null) return null;
  const record = row as Record<string, unknown>;
  const locale = asString(record.locale);
  // A row with no locale cannot be edited or deleted — both writes address it
  // by locale — so rendering one would produce a permanently stuck line.
  if (locale === "") return null;
  return {
    locale,
    subject: asString(record.subject),
    body_html: asString(record.body_html),
    body_mjml: asString(record.body_mjml),
    updated_at:
      typeof record.updated_at === "string" ? record.updated_at : undefined,
  };
}

export async function listCampaignTranslations(
  campaignId: string,
): Promise<CampaignTranslation[]> {
  const res = await api.get<{ translations?: unknown }>(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/translations`,
  );
  const rows = Array.isArray(res?.translations) ? res.translations : [];
  return rows
    .map(toTranslation)
    .filter((row): row is CampaignTranslation => row !== null);
}

/**
 * Mirrors the server's locale check (campaign_translations.go:51):
 * `language[-Region]`, 2..8 characters per segment.
 *
 * Narrower than the tenant dictionary's rule, and the difference is real: `en_US`
 * is a valid glossary locale and an invalid campaign-variant locale.
 */
export function isValidCampaignLocale(locale: string): boolean {
  return /^[A-Za-z]{2,8}(-[A-Za-z0-9]{2,8})?$/u.test(locale.trim());
}

/**
 * Matches the server's `normalizeLocale`: lowercase language, uppercase region.
 *
 * The client normalizes too, because the server stores the normalized form and
 * answers the upsert with it. Sending "ES-mx" and then keying local state on
 * what was typed would leave an "es-MX" row on screen next to an "ES-mx" one
 * the reader believes are two variants.
 */
export function normalizeCampaignLocale(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  const [language, region] = trimmed.split("-", 2);
  const lower = (language ?? "").toLowerCase();
  return region === undefined ? lower : `${lower}-${region.toUpperCase()}`;
}

export async function saveCampaignTranslation(
  campaignId: string,
  locale: string,
  input: CampaignTranslationInput,
): Promise<CampaignTranslation> {
  const res = await api.put<Record<string, unknown>>(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/translations/${encodeURIComponent(locale)}`,
    input,
  );
  return (
    toTranslation(res) ?? {
      locale,
      subject: input.subject,
      body_html: input.body_html,
      body_mjml: "",
    }
  );
}

export async function deleteCampaignTranslation(
  campaignId: string,
  locale: string,
): Promise<void> {
  await api.delete<{ ok?: boolean }>(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/translations/${encodeURIComponent(locale)}`,
  );
}
