/**
 * lib/paletteRecents.ts — the palette's "you were just here" memory.
 *
 * A launcher without recents is a search box: it costs a full query every time
 * even though the destinations a given operator uses are two or three screens
 * they visit every day. Desktop keeps per-identity recents; this is the mobile
 * half.
 *
 * IDENTITY SCOPING IS MANDATORY and is deliberately delegated to
 * `preferenceKey()` from lib/listPreferences: recents are stored under the same
 * `postwave.listprefs.v1:<origin>:<tenant>:<principal>:` namespace, which means
 * (a) one account's recents can never surface under another on a shared device,
 * and (b) the existing `clearListPreferences()` wipe that already runs on
 * sign-out clears them with no new teardown step to forget.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  preferenceKey,
  type PreferenceIdentity,
} from "@/lib/listPreferences";

/** Screen slug under the shared preference namespace. */
const SCREEN = "palette-recents";

/**
 * How many destinations to remember. Small on purpose: the value of recents is
 * that the right answer is in the first row or two, and a 20-deep list is
 * indistinguishable from the More menu.
 */
export const MAX_PALETTE_RECENTS = 6;

export function paletteRecentsKey(identity: PreferenceIdentity): string | null {
  return preferenceKey(SCREEN, identity);
}

/**
 * Push `id` to the front, de-duplicating and truncating.
 *
 * Pure so the ordering rule — most recent first, no duplicates, bounded — is
 * testable without touching storage.
 */
export function withRecent(
  current: readonly string[],
  id: string,
  max = MAX_PALETTE_RECENTS,
): string[] {
  const trimmed = id.trim();
  if (!trimmed) return [...current];
  return [trimmed, ...current.filter((entry) => entry !== trimmed)].slice(
    0,
    Math.max(0, max),
  );
}

/** Drop anything that isn't a non-empty string — a stored file from an older
 *  build could otherwise inject junk ids into the ranker. */
export function parseRecents(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === "string" && !!entry)
      .slice(0, MAX_PALETTE_RECENTS);
  } catch {
    return [];
  }
}

export async function readPaletteRecents(
  identity: PreferenceIdentity,
): Promise<string[]> {
  const key = paletteRecentsKey(identity);
  if (!key) return [];
  try {
    return parseRecents(await AsyncStorage.getItem(key));
  } catch {
    return [];
  }
}

/**
 * Record a launch. Returns the new list so the caller can update state without
 * a second read. A write failure is swallowed: losing a recent is not worth
 * interrupting a navigation the user already asked for.
 */
export async function recordPaletteRecent(
  identity: PreferenceIdentity,
  id: string,
): Promise<string[]> {
  const key = paletteRecentsKey(identity);
  if (!key) return [];
  try {
    const next = withRecent(parseRecents(await AsyncStorage.getItem(key)), id);
    await AsyncStorage.setItem(key, JSON.stringify(next));
    return next;
  } catch {
    return [];
  }
}
