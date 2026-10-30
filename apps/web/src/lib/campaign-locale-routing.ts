// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether per-campaign locale variants are selected at send time.
 *
 * Mirrors desktop's `CAMPAIGN_LOCALE_ROUTING_ENABLED`
 * (apps/desktop/src/components/campaigns/CampaignTranslationsPanel.tsx).
 * `campaign_translations.ResolveForLocale` exists server-side but nothing in
 * the dispatch loop calls it, so a variant authored today changes nothing about
 * what recipients receive. Both clients therefore keep existing variants
 * readable and withhold adding, editing and deleting them.
 *
 * Flip this on BOTH clients in the same change that wires ResolveForLocale into
 * dispatch. It lives in its own module so tests can exercise the authoring
 * path with routing enabled.
 */
export const CAMPAIGN_LOCALE_ROUTING_ENABLED = false;
