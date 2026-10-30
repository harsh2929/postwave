/**
 * lib/campaignAbTest.ts — is this campaign an A/B parent?
 *
 * Mobile showed the "A/B results" button on EVERY campaign
 * (`const canViewABResults = Boolean(c)`), so the overwhelmingly common
 * outcome of tapping it was the "No variants yet" empty state — training
 * operators that the button is broken. Desktop only shows it when
 * `delivery_settings?.ab_test?.is_parent || is_ab_test`
 * (apps/desktop/src/pages/campaigns/campaigns-page-utils.tsx).
 *
 * Ported here as a pure predicate so both the list pill and the detail
 * action can consult one implementation.
 */

export interface AbTestCampaignShape {
  is_ab_test?: unknown;
  delivery_settings?: unknown;
  variants?: unknown;
}

function truthyFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    return s === "true" || s === "1" || s === "yes";
  }
  if (typeof value === "number") return value === 1;
  return false;
}

export function isCampaignAbTest(
  campaign: AbTestCampaignShape | null | undefined,
): boolean {
  if (!campaign) return false;
  if (truthyFlag(campaign.is_ab_test)) return true;

  const settings = campaign.delivery_settings;
  if (settings && typeof settings === "object") {
    const abTest = (settings as { ab_test?: unknown }).ab_test;
    if (abTest && typeof abTest === "object") {
      const record = abTest as { is_parent?: unknown; enabled?: unknown };
      if (truthyFlag(record.is_parent)) return true;
      if (truthyFlag(record.enabled)) return true;
    }
  }

  // A parent that already materialised its arms carries them on the row.
  if (Array.isArray(campaign.variants) && campaign.variants.length > 1) {
    return true;
  }
  return false;
}
