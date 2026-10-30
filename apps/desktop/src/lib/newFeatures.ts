/**
 * "New" badge registry.
 *
 * One source of truth for which sidebar nav items show the brand-teal
 * `<NewBadge />`. Each entry maps a Section id (from store.ts) to the
 * ISO date the feature shipped. The badge auto-clears NEW_BADGE_DAYS
 * after that date — no code change required when it expires.
 *
 * Keep this list short. Promoting a feature with the badge is louder
 * than it looks; reserve it for the genuinely new (or genuinely worth
 * re-discovering).
 */

import type { Section } from "./store";

const NEW_BADGE_DAYS = 30;

/* When updating: use the date the feature first reached parity (not
 * the date of a follow-up polish PR). The freshness window is short on
 * purpose. */
const NEW_FEATURES: Partial<Record<Section, string>> = {
  compliance: "2026-05-25",
  inboundRoutes: "2026-05-26",
  auditSinks: "2026-05-27",
  ai: "2026-05-27",
  webhookSimulator: "2026-05-25",
  migrations: "2026-05-24",
};

export function isFeatureNew(section: Section, now: Date = new Date()): boolean {
  const shipped = NEW_FEATURES[section];
  if (!shipped) return false;
  const t = Date.parse(shipped);
  if (Number.isNaN(t)) return false;
  const ageDays = (now.getTime() - t) / 86_400_000;
  return ageDays >= 0 && ageDays <= NEW_BADGE_DAYS;
}

export function newFeatureSections(now: Date = new Date()): Section[] {
  return (Object.keys(NEW_FEATURES) as Section[]).filter((s) => isFeatureNew(s, now));
}
