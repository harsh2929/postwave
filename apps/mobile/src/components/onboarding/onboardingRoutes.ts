/**
 * onboardingRoutes — resolves the shared, platform-agnostic
 * `OnboardingRouteKey` (from @postwave/onboarding-schema) to a concrete
 * Expo-Router path on mobile.
 *
 * The schema's route keys are authored once and each platform maps them
 * to its own navigation. Mobile is a "monitor + react" surface, so a key
 * whose authoring screen is desktop-only falls back to the nearest MONITOR
 * screen for the same entity (settings.events → integrations) — never to a
 * different entity. Every key resolves to a real, mountable route so a CTA
 * never dead-ends.
 *
 * `campaigns.new` used to resolve to the campaigns LIST, so a CTA reading
 * "Create a campaign" navigated to the screen the user was already looking
 * at and nothing happened. Mobile now has a create sheet
 * (components/campaigns/CampaignCreateModal), so the key carries
 * `?new=1` and the list opens it on arrival — see CAMPAIGN_CREATE_PARAM.
 */
import type { OnboardingRouteKey } from "@postwave/onboarding-schema";

/**
 * Query flag that asks the campaigns list to open its create sheet. Exported
 * so the screen and this map cannot disagree about the spelling.
 */
export const CAMPAIGN_CREATE_PARAM = "new";

/** Expo-Router href strings for each abstract onboarding route key. */
const ROUTE_BY_KEY: Record<OnboardingRouteKey, string> = {
  "settings.sending-identity": "/(tabs)/sending-settings",
  "settings.domain": "/(tabs)/custom-domains",
  "settings.team": "/(tabs)/settings",
  "settings.events": "/(tabs)/integrations",
  subscribers: "/(tabs)/subscribers",
  // Mobile now ships a subscriber-imports MONITORING surface, so "Import a
  // list" no longer resolves to the subscribers list the user is already
  // looking at — a CTA that navigated to its own screen and appeared broken.
  "subscribers.import": "/(tabs)/subscriber-imports",
  campaigns: "/(tabs)/campaigns",
  // Opens the create sheet on arrival rather than landing on the list the
  // user is already looking at. Body composition still happens on the web.
  "campaigns.new": `/(tabs)/campaigns?${CAMPAIGN_CREATE_PARAM}=1`,
  sequences: "/(tabs)/sequences",
  // The shared "Build a sequence" CTA used to carry routeKey "campaigns" and
  // therefore opened a DIFFERENT ENTITY. It then landed on the sequences list
  // with the create action "one tap away" in the header — a destination that
  // did not do what its name said. The list now reads the same `?new=1` the
  // palette and campaigns.new use (hooks/useCreateParam), so this opens
  // SequenceCreateSheet on arrival.
  "sequences.new": `/(tabs)/sequences?${CAMPAIGN_CREATE_PARAM}=1`,
  // Mobile now ships a forms MONITORING surface (list + KPIs + per-form
  // 30-day analytics), so this no longer falls back to Subscribers — a CTA
  // about forms that opened a different entity was a dead end dressed up as a
  // destination. Authoring a field schema still belongs on a big screen.
  forms: "/(tabs)/forms",
};

/** Resolve an abstract onboarding route key to an Expo-Router path. */
export function routeForOnboardingKey(key: OnboardingRouteKey): string {
  return ROUTE_BY_KEY[key] ?? "/(tabs)/dashboard";
}
