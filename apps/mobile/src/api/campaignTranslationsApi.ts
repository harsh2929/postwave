/**
 * api/campaignTranslationsApi.ts — author per-campaign locale variants.
 *
 * PUT/DELETE /api/v1/campaigns/{id}/translations/{locale}
 * (apps/api/internal/campaign_translations/campaign_translations.go:81-83,
 * write:campaigns → session editor; re-verified in the manifest 2026-08-28).
 *
 * The PUT is a FULL-ROW REPLACE — callers must build the body through
 * lib/campaignTranslations.translationUpsertBody so a subject edit preserves
 * the existing translated bodies instead of erasing them.
 */
import { rawRequest, type AIApiResult } from "./request";

function localePath(campaignId: string, locale: string): string {
  return `/api/v1/campaigns/${encodeURIComponent(campaignId)}/translations/${encodeURIComponent(locale)}`;
}

export async function upsertCampaignTranslation(
  campaignId: string,
  locale: string,
  body: { subject: string; body_html: string; body_mjml: string },
): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>("PUT", localePath(campaignId, locale), body);
}

export async function deleteCampaignTranslation(
  campaignId: string,
  locale: string,
): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>("DELETE", localePath(campaignId, locale));
}
