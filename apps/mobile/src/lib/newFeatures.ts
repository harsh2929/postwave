/**
 * lib/newFeatures.ts — 30-day auto-expiring "New" discovery badges.
 *
 * Desktop has had this since apps/desktop/src/lib/newFeatures.ts:21-28: a
 * static registry mapping a nav destination to the ISO date its surface
 * shipped, and a badge that renders for NEW_BADGE_DAYS days after that date.
 * Mobile shipped surface after surface (the API-usage dashboard, workspace
 * roles, maintenance windows) with no in-app discovery cue at all — a feature
 * nobody finds might as well not have shipped.
 *
 * STATELESS BY DESIGN, exactly like desktop's mechanism: no seen-flag, no
 * storage, no server call. The badge exists for a bounded window and then
 * clears itself with no code change and nothing to migrate. (Desktop's
 * separate useSidebarCallout DOES persist a dismissal — that is a different,
 * single-slot announcement mechanism, not these per-row badges.)
 *
 * Two properties carried over verbatim because both keep the badge honest:
 *  - a FUTURE ship date is a registry typo, not a badge (ageDays >= 0 guard);
 *  - an unparseable date reads as not-new, never as new-forever.
 *
 * Import-free so the expiry logic runs under node vitest.
 */

/** How long a badge may live, matching desktop's NEW_BADGE_DAYS. */
export const NEW_FEATURE_DAYS_VISIBLE = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface NewFeatureEntry {
  /** Stable feature key, referenced by the surface that renders the badge. */
  key: string;
  /** For accessibility copy ("New feature: API usage dashboard"). */
  label: string;
  /** ISO date the surface shipped on mobile. The badge dies 30 days later. */
  shippedAt: string;
}

/**
 * The registry. Append an entry when a surface ships; deleting an expired one
 * is optional hygiene, since it renders nothing forever.
 */
export const NEW_FEATURES: readonly NewFeatureEntry[] = [
  {
    key: "billing-api-usage",
    label: "API usage & cost dashboard",
    shippedAt: "2026-08-30",
  },
  {
    key: "settings-workspace-roles",
    label: "Workspace roles",
    shippedAt: "2026-08-30",
  },
  {
    key: "settings-maintenance-windows",
    label: "Maintenance windows",
    shippedAt: "2026-08-30",
  },
];

/**
 * True while the key's badge may show: shipped in the past, within the
 * 30-day window (inclusive at both ends, as on desktop).
 */
export function isFeatureNew(
  key: string,
  now: number = Date.now(),
  registry: readonly NewFeatureEntry[] = NEW_FEATURES,
): boolean {
  const entry = registry.find((item) => item.key === key);
  if (!entry) return false;
  const shipped = Date.parse(entry.shippedAt);
  if (!Number.isFinite(shipped)) return false;
  const ageDays = (now - shipped) / DAY_MS;
  return ageDays >= 0 && ageDays <= NEW_FEATURE_DAYS_VISIBLE;
}

/** Keys with a live badge right now, in registry order. */
export function activeNewFeatureKeys(
  now: number = Date.now(),
  registry: readonly NewFeatureEntry[] = NEW_FEATURES,
): string[] {
  return registry
    .filter((entry) => isFeatureNew(entry.key, now, registry))
    .map((entry) => entry.key);
}

/** The registry label for a key, for spoken badge copy. */
export function newFeatureLabel(
  key: string,
  registry: readonly NewFeatureEntry[] = NEW_FEATURES,
): string {
  return registry.find((item) => item.key === key)?.label ?? "";
}
