/**
 * lib/navPreferences.ts — pinned and recently-used destinations for the More
 * menu.
 *
 * More renders six fixed sections in manifest order, so an operator who lives
 * in Suppressions scrolls past Tags, Lists, Search, Notifications, Scan,
 * Sequences, Voice and Integrations on every single visit. Desktop's sidebar
 * has had a per-item favourite star and a recents list for as long as it has
 * had a sidebar.
 *
 * TWO DELIBERATE REUSES, so this does not become a third memory mechanism:
 *
 *  - The key comes from `preferenceKey()` (lib/listPreferences), which means
 *    these live under the same `postwave.listprefs.v1:<origin>:<tenant>:<user>:`
 *    namespace as every other stored preference. Identity scoping is therefore
 *    inherited rather than re-implemented — one account's pins can never
 *    surface under another on a shared device — and the existing
 *    `clearListPreferences()` sign-out wipe already clears them, with no new
 *    teardown step for a future contributor to forget.
 *  - Recency ordering comes from `withRecent()` (lib/paletteRecents), the rule
 *    the command palette already uses. Two "most recent first, de-duplicated,
 *    bounded" implementations would be one too many.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

import { preferenceKey, type PreferenceIdentity } from "@/lib/listPreferences";
import { withRecent } from "@/lib/paletteRecents";

/** Screen slug under the shared preference namespace. */
const SCREEN = "more-nav";

/**
 * Caps. A pinned list longer than a handful is the More menu again, and the
 * whole value of "Recent" is that the answer is in the first row or two.
 */
export const MAX_FAVORITE_ROUTES = 8;
export const MAX_RECENT_ROUTES = 4;

export interface MoreNavPreferences {
  /** Route keys, in the order the user pinned them. */
  favorites: string[];
  /** Route keys, most recently visited first. */
  recents: string[];
}

export const EMPTY_NAV_PREFERENCES: MoreNavPreferences = {
  favorites: [],
  recents: [],
};

function stringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Parse the stored blob defensively. A file written by an older build could
 * otherwise pin route keys that no longer exist; the caller additionally
 * intersects these with the live manifest, so an unknown key degrades to
 * "not shown" rather than to a dead row.
 */
export function parseNavPreferences(raw: string | null): MoreNavPreferences {
  if (!raw) return EMPTY_NAV_PREFERENCES;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return EMPTY_NAV_PREFERENCES;
    }
    const obj = parsed as Record<string, unknown>;
    return {
      favorites: stringList(obj.favorites, MAX_FAVORITE_ROUTES),
      recents: stringList(obj.recents, MAX_RECENT_ROUTES),
    };
  } catch {
    return EMPTY_NAV_PREFERENCES;
  }
}

/**
 * Toggle a pin. Appends to the END so the pinned list keeps the order the user
 * built it in — re-sorting someone's pins under them is the fastest way to
 * make a shortcut list useless.
 */
export function withFavorite(
  current: readonly string[],
  key: string,
): string[] {
  const trimmed = key.trim();
  if (!trimmed) return [...current];
  if (current.includes(trimmed)) {
    return current.filter((entry) => entry !== trimmed);
  }
  return [...current, trimmed].slice(0, MAX_FAVORITE_ROUTES);
}

export function withVisit(
  current: readonly string[],
  key: string,
): string[] {
  return withRecent(current, key, MAX_RECENT_ROUTES);
}

/**
 * What "Recent" should show: most-recent-first, minus anything already pinned.
 *
 * A destination that appears in both lists is shown twice for no gain, and the
 * duplicate pushes the genuinely-new suggestion off the bottom.
 */
export function visibleRecents(
  prefs: MoreNavPreferences,
  known: (key: string) => boolean,
): string[] {
  const pinned = new Set(prefs.favorites);
  return prefs.recents.filter((key) => !pinned.has(key) && known(key));
}

export function visibleFavorites(
  prefs: MoreNavPreferences,
  known: (key: string) => boolean,
): string[] {
  return prefs.favorites.filter((key) => known(key));
}

export function navPreferencesKey(identity: PreferenceIdentity): string | null {
  return preferenceKey(SCREEN, identity);
}

export async function readNavPreferences(
  identity: PreferenceIdentity,
): Promise<MoreNavPreferences> {
  const key = navPreferencesKey(identity);
  if (!key) return EMPTY_NAV_PREFERENCES;
  try {
    return parseNavPreferences(await AsyncStorage.getItem(key));
  } catch {
    return EMPTY_NAV_PREFERENCES;
  }
}

/**
 * Best-effort write. Losing a pin is not worth interrupting a navigation the
 * user already asked for.
 */
export async function writeNavPreferences(
  identity: PreferenceIdentity,
  next: MoreNavPreferences,
): Promise<void> {
  const key = navPreferencesKey(identity);
  if (!key) return;
  try {
    await AsyncStorage.setItem(key, JSON.stringify(next));
  } catch {
    /* best-effort */
  }
}
