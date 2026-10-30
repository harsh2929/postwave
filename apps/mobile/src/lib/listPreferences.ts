/**
 * lib/listPreferences.ts — remembered per-screen view settings (sort order,
 * active filter, density).
 *
 * The detail this closes: every list screen resets to its default sort every
 * time you leave and come back. An operator who always works the suppression
 * list "newest first" re-picks it on every visit, forever. Remembering the
 * choice is a small thing that only shows up after months of daily use — which
 * is exactly the kind of thing a five-year-old product has and a young one
 * doesn't.
 *
 * IDENTITY SCOPING IS MANDATORY. This app's offline stack was audited
 * specifically because desktop and web both shipped caches that bled across
 * tenants on a shared device (see docs/logic-audit-2026-07). Preferences are
 * lower-stakes than data, but a filter like "only my drafts" or a saved search
 * term is still workspace-shaped information, and a preference set by one
 * account must not silently apply under another. So the storage key carries the
 * same identity tuple the query persister uses, and `clearListPreferences()`
 * runs on sign-out.
 *
 * Storage is AsyncStorage rather than SecureStore on purpose: these are display
 * preferences, not secrets, and SecureStore has a small value-size limit plus a
 * real per-read cost on Android.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

const PREFIX = "postwave.listprefs.v1";

export interface PreferenceIdentity {
  baseUrl: string | null;
  tenantId: string | null;
  principalId: string | null;
}

/**
 * The storage key for one screen's preferences under one identity.
 * Returns null when identity is incomplete — callers must then treat
 * preferences as unavailable rather than falling back to a shared key, which
 * is exactly how cross-account bleed happens.
 */
export function preferenceKey(
  screen: string,
  identity: PreferenceIdentity,
): string | null {
  const base = identity.baseUrl?.trim().replace(/\/+$/, "");
  const tenant = identity.tenantId?.trim();
  const principal = identity.principalId?.trim();
  if (!base || !tenant || !principal || !screen.trim()) return null;
  return `${PREFIX}:${base}:${tenant}:${principal}:${screen.trim()}`;
}

/**
 * Read stored preferences, merged over the supplied defaults.
 *
 * Unknown or malformed stored keys are DROPPED rather than merged: a
 * preference file written by an older build could otherwise resurrect a sort
 * mode that no longer exists and leave the screen in an unreachable state.
 * `allowed` names the keys this screen still understands.
 */
export async function readListPreferences<T extends Record<string, string>>(
  screen: string,
  identity: PreferenceIdentity,
  defaults: T,
): Promise<T> {
  const key = preferenceKey(screen, identity);
  if (!key) return defaults;
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return defaults;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return defaults;
    }
    const next = { ...defaults };
    for (const field of Object.keys(defaults) as (keyof T)[]) {
      const value = (parsed as Record<string, unknown>)[field as string];
      if (typeof value === "string") {
        next[field] = value as T[keyof T];
      }
    }
    return next;
  } catch {
    // A corrupt preference blob must never block a screen from rendering.
    return defaults;
  }
}

/** Persist preferences. Failures are swallowed — this is a nicety, not data. */
export async function writeListPreferences(
  screen: string,
  identity: PreferenceIdentity,
  values: Record<string, string>,
): Promise<void> {
  const key = preferenceKey(screen, identity);
  if (!key) return;
  try {
    await AsyncStorage.setItem(key, JSON.stringify(values));
  } catch {
    /* preferences are best-effort */
  }
}

/**
 * Drop every stored preference. Called on sign-out so the next account on this
 * device starts from defaults rather than inheriting the previous operator's
 * view — the same hygiene rule the query cache follows.
 */
export async function clearListPreferences(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const ours = keys.filter((key) => key.startsWith(`${PREFIX}:`));
    if (ours.length) await AsyncStorage.multiRemove(ours);
  } catch {
    /* best-effort */
  }
}
