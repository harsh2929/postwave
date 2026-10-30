/**
 * lib/whatsNew.ts — the ANNOUNCEMENT half of one discovery mechanism.
 *
 * Two register rows (shell-crosscutting "in-app what's-new" and platform
 * "'New feature' nav badges") are two halves of ONE thing, and desktop builds
 * them that way: `lib/newFeatures.ts` decides which nav entries wear the teal
 * pill, and `hooks/useSidebarCallout.ts` shows one dismissible card about the
 * same shipments. Building a second registry here would give mobile two
 * answers to "what is new", which is exactly how desktop's callout list and
 * badge list drifted apart (its ANNOUNCEMENTS name audit sinks, compliance and
 * AI; its NEW_FEATURES name six sections on four different dates).
 *
 * So there is exactly ONE ship date per feature and it lives in
 * `lib/newFeatures.ts`. This module adds only what an announcement needs on
 * top of a date:
 *
 *   - WHERE it lands (a More-menu route key, which is also the row that wears
 *     the badge — so a badge can never point somewhere the card does not, and
 *     a feature can never be announced without its row being findable);
 *   - WHAT it says (one sentence, product voice);
 *   - the CTA label.
 *
 * THE WINDOW IS SHARED. An announcement is offered only while its feature's
 * badge is still live (`isFeatureNew`), so "new" means one thing in this app:
 * shipped within NEW_FEATURE_DAYS_VISIBLE days. Desktop's callout has no
 * expiry at all, which is why its card still advertised a May feature in
 * September; mirroring that would import the bug along with the pattern.
 *
 * DISMISSAL IS PER FEATURE and lives outside this file (whatsNewStore.ts owns
 * the storage). Dismissing the card does NOT clear the row badge: the card is
 * a claim on attention the user can decline, while the badge is a property of
 * the row for a bounded window. That is desktop's split too.
 *
 * Import-free apart from the registry, so the selection rules run under node
 * vitest with no renderer.
 */

import {
  isFeatureNew,
  newFeatureLabel,
  NEW_FEATURES,
  type NewFeatureEntry,
} from "./newFeatures";

export interface WhatsNewItem {
  /** Key into NEW_FEATURES — the one place a ship date is recorded. */
  featureKey: string;
  /**
   * The More-menu route key this feature lives behind. It is BOTH the row that
   * wears the badge and where the card's CTA lands, so the two halves cannot
   * disagree. Resolved to a path through MOBILE_SECONDARY_ROUTES by the
   * caller — paths belong to the route manifest, not to this table.
   */
  routeKey: string;
  /** One sentence. What the user can now do, not what we built. */
  title: string;
  /** CTA copy. A verb plus the destination, e.g. "Open Billing". */
  ctaLabel: string;
}

/**
 * The announcements, oldest → newest (ties in `shippedAt` are broken by this
 * order, later meaning newer — the same rule desktop's array walk uses).
 *
 * Adding one is two edits: a dated entry in NEW_FEATURES, and a row here.
 * Deleting one is optional hygiene — an expired feature announces nothing.
 */
export const WHATS_NEW: readonly WhatsNewItem[] = [
  {
    featureKey: "settings-workspace-roles",
    routeKey: "settings",
    title:
      "Settings now answers “why can’t my colleague see that?” — every role and the scopes it holds.",
    ctaLabel: "Open Settings",
  },
  {
    featureKey: "settings-maintenance-windows",
    routeKey: "settings",
    title:
      "Schedule and track maintenance windows from the phone, including platform-wide ones.",
    ctaLabel: "Open Settings",
  },
  {
    featureKey: "billing-api-usage",
    routeKey: "billing",
    title:
      "Plan & usage now shows API sends, metered cost and the itemized ledger.",
    ctaLabel: "Open Billing",
  },
];

/** Newest first: by ship date, then by table position (later = newer). */
function rank(
  item: WhatsNewItem,
  index: number,
  registry: readonly NewFeatureEntry[],
): { at: number; index: number } {
  const entry = registry.find((row) => row.key === item.featureKey);
  const at = entry ? Date.parse(entry.shippedAt) : Number.NaN;
  return { at: Number.isFinite(at) ? at : -Infinity, index };
}

function newestFirst(
  items: readonly WhatsNewItem[],
  registry: readonly NewFeatureEntry[],
): WhatsNewItem[] {
  return items
    .map((item, index) => ({ item, key: rank(item, index, registry) }))
    .sort((a, b) =>
      a.key.at === b.key.at ? b.key.index - a.key.index : b.key.at - a.key.at,
    )
    .map((row) => row.item);
}

/**
 * The feature key whose badge belongs on a given More row, or null.
 *
 * Two announcements can share a route (Settings gained two surfaces on the
 * same day); the row wears ONE pill, and it is the newest live one — a second
 * pill on the same row would say nothing the first does not.
 */
export function newFeatureKeyForRoute(
  routeKey: string,
  now: number = Date.now(),
  items: readonly WhatsNewItem[] = WHATS_NEW,
  registry: readonly NewFeatureEntry[] = NEW_FEATURES,
): string | null {
  for (const item of newestFirst(items, registry)) {
    if (item.routeKey !== routeKey) continue;
    if (isFeatureNew(item.featureKey, now, registry)) return item.featureKey;
  }
  return null;
}

/** Every More route key carrying a live badge right now. */
export function newRouteKeys(
  now: number = Date.now(),
  items: readonly WhatsNewItem[] = WHATS_NEW,
  registry: readonly NewFeatureEntry[] = NEW_FEATURES,
): string[] {
  const keys: string[] = [];
  for (const item of newestFirst(items, registry)) {
    if (!isFeatureNew(item.featureKey, now, registry)) continue;
    if (!keys.includes(item.routeKey)) keys.push(item.routeKey);
  }
  return keys;
}

export interface AnnouncementInput {
  now?: number;
  /** Feature keys the user has already dismissed. */
  dismissed: readonly string[];
  /**
   * "Can this identity actually reach that row?" A viewer must never be
   * offered "Open Billing" for a row their role hides — the card would be an
   * advertisement for a 403. Callers pass the same access predicate the More
   * list itself filters with.
   */
  canReach?: (routeKey: string) => boolean;
  items?: readonly WhatsNewItem[];
  registry?: readonly NewFeatureEntry[];
}

/**
 * The single card to show, or null.
 *
 * At most one, newest first, skipping anything dismissed, expired, or
 * unreachable for this role. Returning one rather than a list is deliberate:
 * a stack of product announcements above the destination list is an ad break
 * in front of the only way to reach 24 screens.
 */
export function pickAnnouncement(input: AnnouncementInput): WhatsNewItem | null {
  const now = input.now ?? Date.now();
  const registry = input.registry ?? NEW_FEATURES;
  const items = input.items ?? WHATS_NEW;
  const dismissed = Array.isArray(input.dismissed) ? input.dismissed : [];
  for (const item of newestFirst(items, registry)) {
    if (!isFeatureNew(item.featureKey, now, registry)) continue;
    if (dismissed.includes(item.featureKey)) continue;
    if (input.canReach && !input.canReach(item.routeKey)) continue;
    return item;
  }
  return null;
}

/**
 * What a screen reader hears instead of a bare "What's new" eyebrow: the
 * feature's own name from the registry, then the sentence.
 */
export function announcementSpoken(
  item: WhatsNewItem,
  registry: readonly NewFeatureEntry[] = NEW_FEATURES,
): string {
  const label = newFeatureLabel(item.featureKey, registry);
  return label ? `What's new: ${label}. ${item.title}` : `What's new. ${item.title}`;
}

/**
 * How many dismissals are kept. The list only ever grows by one per shipped
 * feature, but a corrupted or hostile record must not be able to grow without
 * bound in device storage.
 */
export const DISMISSED_ANNOUNCEMENTS_CAP = 50;

/**
 * Record a dismissal. Newest last, deduped, capped by dropping the OLDEST —
 * a re-dismissal of a card the user already put down is a no-op rather than a
 * new entry.
 */
export function withDismissal(
  dismissed: readonly string[],
  featureKey: string,
): string[] {
  const key = featureKey.trim();
  if (!key) return [...dismissed];
  const next = dismissed.filter((entry) => entry !== key);
  next.push(key);
  return next.length > DISMISSED_ANNOUNCEMENTS_CAP
    ? next.slice(next.length - DISMISSED_ANNOUNCEMENTS_CAP)
    : next;
}

/**
 * Tolerant parse of a stored dismissal record. Anything that is not an array
 * of non-empty strings reads as "nothing dismissed" — the cost of getting that
 * wrong is re-showing one card, never hiding a feature forever.
 */
export function parseDismissedAnnouncements(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const key = entry.trim();
    if (!key || out.includes(key)) continue;
    out.push(key);
  }
  return out.length > DISMISSED_ANNOUNCEMENTS_CAP
    ? out.slice(out.length - DISMISSED_ANNOUNCEMENTS_CAP)
    : out;
}
