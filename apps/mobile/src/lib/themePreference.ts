/**
 * lib/themePreference.ts — the pure theme-resolution policy.
 *
 * Import-free by construction (no react, no react-native, no
 * expo-secure-store) so every decision below can be asserted directly in the
 * node test environment, the way `contrast.ts` / `approvalPolicy.ts` are.
 * `lib/theme.ts` owns the React + SecureStore plumbing and nothing else.
 *
 * The decision that matters here is the difference between a preference that
 * is UNKNOWN and one that is "system". They are not the same thing:
 *
 *   - "system" is an answer. The user (or the default) chose to follow the OS,
 *     so the OS colour scheme is authoritative and painting it is correct.
 *
 *   - `null` is the ABSENCE of an answer — SecureStore has not replied yet.
 *     Treating it as "system" is what produced a dark flash for a user whose
 *     stored preference was 'light' on a system-dark device: the app painted
 *     the OS scheme first and corrected itself a frame or two later.
 *
 * `resolveFirstPaintTheme` keeps them apart and returns `null` for "paint
 * nothing yet", which is what the provider gates on.
 */

export type ThemeName = "light" | "dark";
export type ThemePreference = ThemeName | "system";

/**
 * SecureStore key holding the user's choice. Lives here rather than in
 * theme.ts so the storage contract is asserted by a test that does not need a
 * native module.
 */
export const THEME_PREFERENCE_KEY = "postwave.theme_pref";

/**
 * Validate a value read back out of storage. Stored preferences outlive the
 * code that wrote them, so anything unrecognised (a renamed theme, a
 * half-written value, a non-string) is treated as "no stored answer" rather
 * than being cast into one.
 */
export function parseThemePreference(raw: unknown): ThemePreference | null {
  return raw === "light" || raw === "dark" || raw === "system" ? raw : null;
}

/**
 * Resolve a KNOWN preference against the OS colour scheme.
 *
 * `systemScheme` is React Native's `useColorScheme()`, which reports null on
 * some first paints; null falls back to dark because that is the app's
 * historical default surface.
 */
export function resolveThemeName(
  preference: ThemePreference,
  systemScheme: string | null | undefined,
): ThemeName {
  if (preference === "light" || preference === "dark") return preference;
  return systemScheme === "light" ? "light" : "dark";
}

/**
 * The first-paint decision.
 *
 * @param storedPreference the user's stored choice, or `null` while the
 *        SecureStore read is still outstanding.
 * @returns the theme to paint, or `null` meaning "paint nothing yet" — the
 *        only honest answer while the stored preference is unknown, because
 *        any guess can be the wrong one and a corrected theme is a visible
 *        flash rather than a subtle mistake.
 */
export function resolveFirstPaintTheme(
  storedPreference: ThemePreference | null,
  systemScheme: string | null | undefined,
): ThemeName | null {
  if (storedPreference === null) return null;
  return resolveThemeName(storedPreference, systemScheme);
}
