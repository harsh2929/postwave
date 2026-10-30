/**
 * lib/paletteItems.ts — the local half of the mobile command palette.
 *
 * Mobile's "Search" screen only ever asked the server about four entity types.
 * Desktop's palette concatenates FOUR sources — navigation targets, actions,
 * entity hits, and per-identity recents — and on a phone the navigation half is
 * worth more than it is on desktop: 22 secondary routes live behind a scrolling
 * More list, so "type three letters, land on the screen" replaces a scroll and
 * two taps.
 *
 * This module owns the pure half: the ranking function and the item catalogue.
 * Rendering lives in the screen; storage lives in `paletteRecents.ts`. Keeping
 * it free of react-native imports is what lets it be unit-tested in the node
 * vitest environment.
 *
 * Two of desktop's sources that mobile lacked are composed in from their own
 * modules: creation verbs (`paletteCreateItems.ts`) and Settings sections
 * (`paletteSettingsItems.ts`). This file decides the ORDER they appear in and
 * that no two sources may claim the same id.
 */
import type { IconName } from "@/components/TabBarIcon";
import {
  MOBILE_SECONDARY_ROUTES,
  canAccessMobileSecondaryRoute,
  type MobileSecondaryRoute,
} from "@/lib/mobileRouteManifest";
import type { NavigationTarget } from "@/lib/navigateTo";
import { buildCreateItems } from "@/lib/paletteCreateItems";
import { buildSettingsItems } from "@/lib/paletteSettingsItems";

/**
 * `create` and `settings` both NAVIGATE (they carry a route + params) but are
 * kept distinct from `navigation` so the empty-query list — recents, then the
 * primary tabs — never dumps three verbs and twenty-four sections on top.
 */
export type PaletteItemKind = "navigation" | "action" | "create" | "settings";

/**
 * Local actions the palette can run. Deliberately small: an action list that
 * grows without discipline becomes a second, worse settings screen.
 */
export type PaletteActionKey =
  | "sign-out"
  | "replay-tour"
  | "theme-system"
  | "theme-light"
  | "theme-dark";

export interface PaletteItem {
  /** Stable identity — also the recents key, so it must not encode state. */
  id: string;
  kind: PaletteItemKind;
  title: string;
  subtitle?: string | undefined;
  icon: IconName;
  /** Navigation items carry a route; actions carry an actionKey. */
  route?: string | undefined;
  /** Query params for `route`: a create flag, a settings anchor. */
  params?: Record<string, string> | undefined;
  actionKey?: PaletteActionKey | undefined;
  /** Matched by the ranker but never rendered — synonyms and aliases. */
  keywords?: string | undefined;
}

export interface PaletteAccess {
  role: string | null;
  mode: "api_key" | "session" | null;
  /**
   * A usable online session (the search screen's `gate.enabled`). Creation
   * verbs are withheld without one, as every target screen withholds its own
   * create control. Optional so callers that predate it keep their catalogue.
   */
  online?: boolean | undefined;
}

/**
 * Score `query` against `target`. Lower is better; -1 means no match.
 *
 *   0..99       prefix             ("camp" → "Campaigns")
 *   100..299    word start         ("set"  → "Sending settings")
 *   300..999    substring          ("amp"  → "Campaigns")
 *   1000+       loose subsequence  ("cmp"  → "Campaigns")
 *
 * Ported from apps/desktop/src/components/CommandPalette.tsx so a query that
 * ranks one way on the laptop ranks the same way on the phone.
 */
export function rankFuzzy(query: string, target: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (t.startsWith(q)) return q.length;
  const words = t.split(/[\s/_\-.]+/u);
  for (let i = 0; i < words.length; i += 1) {
    if ((words[i] ?? "").startsWith(q)) return 100 + i * 10 + q.length;
  }
  const idx = t.indexOf(q);
  if (idx >= 0) return 300 + idx;
  let qi = 0;
  let lastHit = -1;
  let gap = 0;
  for (let i = 0; i < t.length && qi < q.length; i += 1) {
    if (t[i] === q[qi]) {
      if (lastHit >= 0) gap += i - lastHit - 1;
      lastHit = i;
      qi += 1;
    }
  }
  if (qi !== q.length) return -1;
  return 1000 + gap;
}

function rankField(
  query: string,
  target: string | undefined,
  offset: number,
): number {
  if (!target) return Number.POSITIVE_INFINITY;
  const score = rankFuzzy(query, target);
  return score < 0 ? Number.POSITIVE_INFINITY : score + offset;
}

/** Best score across title / subtitle / keywords, or Infinity for no match. */
export function scorePaletteItem(item: PaletteItem, query: string): number {
  const q = query.trim();
  if (!q) return 0;
  return Math.min(
    rankField(q, item.title, 0),
    rankField(q, item.subtitle, 50),
    rankField(q, item.keywords, 100),
  );
}

/** The five bottom-tab destinations. Not in MOBILE_SECONDARY_ROUTES. */
const PRIMARY_TABS: readonly PaletteItem[] = [
  {
    id: "nav:dashboard",
    kind: "navigation",
    title: "Dashboard",
    subtitle: "Workspace overview",
    icon: "home",
    route: "/(tabs)/dashboard",
    keywords: "home overview stats metrics",
  },
  {
    id: "nav:subscribers",
    kind: "navigation",
    title: "Subscribers",
    subtitle: "People in this workspace",
    icon: "users",
    route: "/(tabs)/subscribers",
    keywords: "people contacts audience members",
  },
  {
    id: "nav:campaigns",
    kind: "navigation",
    title: "Campaigns",
    subtitle: "Broadcasts and sends",
    icon: "send",
    route: "/(tabs)/campaigns",
    keywords: "send broadcast email newsletter",
  },
  {
    id: "nav:approvals",
    kind: "navigation",
    title: "Approvals",
    subtitle: "Pending decisions",
    icon: "check",
    route: "/(tabs)/approvals",
    keywords: "review approve reject queue",
  },
  {
    id: "nav:more",
    kind: "navigation",
    title: "More",
    subtitle: "All other destinations",
    icon: "more",
    route: "/(tabs)/more",
    keywords: "menu navigation",
  },
];

const ACTIONS: readonly PaletteItem[] = [
  {
    id: "action:theme-system",
    kind: "action",
    title: "Theme: System",
    subtitle: "Follow the OS appearance setting",
    icon: "settings",
    actionKey: "theme-system",
    keywords: "appearance dark light auto",
  },
  {
    id: "action:theme-light",
    kind: "action",
    title: "Theme: Light",
    subtitle: "Always use the light appearance",
    icon: "settings",
    actionKey: "theme-light",
    keywords: "appearance bright day",
  },
  {
    id: "action:theme-dark",
    kind: "action",
    title: "Theme: Dark",
    subtitle: "Always use the dark appearance",
    icon: "settings",
    actionKey: "theme-dark",
    keywords: "appearance night",
  },
  {
    id: "action:replay-tour",
    kind: "action",
    title: "Replay product tour",
    subtitle: "A quick guided walkthrough",
    icon: "help",
    actionKey: "replay-tour",
    keywords: "help onboarding walkthrough guide",
  },
  {
    id: "action:sign-out",
    kind: "action",
    title: "Sign out",
    subtitle: "Clear this device's credentials",
    icon: "signout",
    actionKey: "sign-out",
    keywords: "logout log out leave exit",
  },
];

function navItemFor(route: MobileSecondaryRoute): PaletteItem {
  return {
    id: `nav:${route.key}`,
    kind: "navigation",
    title: route.label,
    subtitle: route.hint,
    icon: route.icon,
    route: route.route,
    keywords: route.key.replace(/[-_]/gu, " "),
  };
}

/**
 * First occurrence wins. Ids double as recents keys and SectionList keys, so
 * a collision between two sources would corrupt both; better to drop the
 * later source's row than to render a duplicate key.
 */
export function dedupePaletteItems(
  items: readonly PaletteItem[],
): PaletteItem[] {
  const seen = new Set<string>();
  const out: PaletteItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/**
 * Every locally-reachable destination, verb, section and action for this
 * identity.
 *
 * Role filtering runs through the SAME `canAccessMobileSecondaryRoute` the More
 * menu uses, so the palette can never offer a screen the More list hides — a
 * palette that surfaces a route the user will be bounced out of is worse than
 * no palette. Creation verbs apply their target screens' own gates
 * (paletteCreateItems).
 *
 * Source order is the tie-break for equal scores: a screen outranks the verb
 * that creates on it, a verb outranks a Settings section, and the local
 * actions come last.
 */
export function buildPaletteItems(access: PaletteAccess): PaletteItem[] {
  const secondary = MOBILE_SECONDARY_ROUTES.filter((route) =>
    canAccessMobileSecondaryRoute(route, access.role, access.mode),
  ).map(navItemFor);
  return dedupePaletteItems([
    ...PRIMARY_TABS,
    ...secondary,
    ...buildCreateItems(access),
    ...buildSettingsItems(),
    ...ACTIONS,
  ]);
}

/** Trailing tag on the row — and part of its spoken label. */
export function paletteItemBadge(item: PaletteItem): string | undefined {
  switch (item.kind) {
    case "action":
      return "Action";
    case "create":
      return "New";
    case "settings":
      return "Settings";
    default:
      return undefined;
  }
}

/**
 * Where a tap goes, in the {pathname, params} shape `useNavigateTo` takes —
 * or null for a local action, which runs instead of navigating.
 */
export function paletteItemTarget(item: PaletteItem): NavigationTarget | null {
  if (!item.route) return null;
  return item.params
    ? { pathname: item.route, params: item.params }
    : { pathname: item.route };
}

export interface FilterPaletteOptions {
  /** Item ids most recently launched, newest first. */
  recentIds?: readonly string[];
  /** Cap the returned list. Defaults to 8 — one screenful above the keyboard. */
  limit?: number;
}

/**
 * Rank + slice the local catalogue for a query.
 *
 * With an EMPTY query the palette shows recents first (that is the whole point
 * of recents), then the primary tabs — never a 30-row dump of every route,
 * which is just the More menu with extra steps.
 */
export function filterPaletteItems(
  items: readonly PaletteItem[],
  query: string,
  options: FilterPaletteOptions = {},
): PaletteItem[] {
  const limit = options.limit ?? 8;
  const recentIds = options.recentIds ?? [];
  const q = query.trim();

  if (!q) {
    const byId = new Map(items.map((item) => [item.id, item]));
    const recents = recentIds
      .map((id) => byId.get(id))
      .filter((item): item is PaletteItem => Boolean(item));
    const seen = new Set(recents.map((item) => item.id));
    const rest = items.filter(
      (item) => item.kind === "navigation" && !seen.has(item.id),
    );
    return [...recents, ...rest].slice(0, limit);
  }

  const scored = items
    .map((item, order) => ({
      item,
      // A recently-used item wins ties against an identically-scoring one.
      score: scorePaletteItem(item, q) - (recentIds.includes(item.id) ? 5 : 0),
      order,
    }))
    .filter((row) => row.score !== Number.POSITIVE_INFINITY);

  scored.sort((a, b) => a.score - b.score || a.order - b.order);
  return scored.slice(0, limit).map((row) => row.item);
}
