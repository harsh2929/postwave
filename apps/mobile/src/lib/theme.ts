/**
 * lib/theme.ts — runtime theme tokens + ThemeProvider.
 *
 * The mobile app started life as a dark-only surface, so the existing
 * NativeWind tokens in tailwind.config.js encode the dark palette
 * directly (bg-bg → #0b0d12, text-fg → #f5f7fa, etc). NativeWind
 * class-based dark mode would require touching every screen, so we
 * take a different path:
 *
 *  - Keep the NativeWind classes for the dark theme (existing screens
 *    stay untouched).
 *
 *  - New / rewritten components consume colors from `useTheme()` and
 *    set them via `style={{ backgroundColor: t.bg }}` so the light
 *    theme actually flips the page background.
 *
 *  - The ThemeProvider stores the user's choice ('light' | 'dark' |
 *    'system') in SecureStore and falls back to the OS-reported colour
 *    scheme via React Native's `useColorScheme()`. Re-mounts on change
 *    aren't required because consumers read fresh values each render.
 *
 *  - FIRST PAINT IS GATED ON THE STORED PREFERENCE. This provider used to
 *    render children immediately with preference='system', which paints the
 *    OS scheme — so a user whose stored preference is 'light' on a
 *    system-dark device got one or more DARK frames on every cold launch
 *    before the async SecureStore read landed. The preference is now read
 *    SYNCHRONOUSLY (`SecureStore.getItem`) in the state initialiser, so the
 *    correct theme is available on frame 0; when that synchronous read is
 *    unavailable (older native module, non-native platform, keychain locked)
 *    we fall back to the async read and render NOTHING until it answers,
 *    because a blank frame under the splash is invisible and a wrong-theme
 *    frame is not. The decision itself lives in ./themePreference so it can
 *    be tested without a native module.
 *
 * The palette is the Moosewave BRAND system, kept 1:1 with the website
 * (apps/web globals.css) and the desktop app (apps/desktop styles.css):
 * ember red (#C8102E light / #E55262 dark) as the conviction accent on a
 * warm-paper (#FDFCF8) / ink (#0F0F0F) canvas, warm borders, a single gold
 * spark (#F2B233), and green/amber/blue reserved for success/warning/info.
 * NOT the old green-on-slate scheme.
 */
import * as SecureStore from "expo-secure-store";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useColorScheme } from "react-native";
import {
  light as brandLight,
  dark as brandDark,
} from "@postwave/design-tokens";

import {
  THEME_PREFERENCE_KEY,
  parseThemePreference,
  resolveFirstPaintTheme,
  resolveThemeName,
  type ThemeName,
  type ThemePreference,
} from "./themePreference";

export type { ThemeName, ThemePreference };

export interface ThemeTokens {
  /** Page background. */
  bg: string;
  /** Slightly raised surface (used by lists, headers). */
  bgSubtle: string;
  /** Card / pill background. */
  surface: string;
  /** Elevated card (e.g. dialogs, hovered rows). */
  surfaceElevated: string;
  /** Primary text. */
  fg: string;
  /** Secondary text (labels, helper copy). */
  fgMuted: string;
  /** Tertiary text (timestamps). */
  fgSubtle: string;
  /** Default 1px border. */
  border: string;
  /** Subtle 1px border (inside cards). */
  borderSubtle: string;
  /** Brand ember (accent / primary CTA). */
  accent: string;
  /** Darker ember for pressed states. */
  accentDim: string;
  /** Foreground when painted on accent bg. */
  accentFg: string;
  /** Warm ember tint for hover/active/selected surfaces (web --accent). */
  accentSubtle: string;
  danger: string;
  /**
   * Error INK for text on a low-alpha danger wash, where `danger` itself is not
   * AA-safe (light danger on its own 15% tint measures 3.80:1). Pill labels use
   * it.
   */
  dangerEmphasis: string;
  warning: string;
  success: string;
  /** AA-safe positive-status ink on subtle or low-alpha success surfaces. */
  successEmphasis: string;
  info: string;
  /** The single celebration / positive-emphasis spark (brand gold). */
  gold: string;
  /** Primary tint for focus states / underline. */
  focus: string;
  /** Translucent overlay for backdrop dimming. */
  overlay: string;
}

// The palettes are now sourced from the shared @postwave/design-tokens
// package (the single brand source of truth) rather than hand-maintained
// here. ThemeTokens is a structural subset of the package's PaletteTokens, so
// the imports satisfy it directly — and a CI drift guard keeps every client
// locked to these values.
const dark: ThemeTokens = brandDark;
const light: ThemeTokens = brandLight;

const PALETTES: Record<ThemeName, ThemeTokens> = { dark, light };

interface ThemeContextValue {
  /** Resolved active theme — never "system". */
  theme: ThemeName;
  /** User's stored preference (may be "system"). */
  preference: ThemePreference;
  /**
   * Whether the stored preference has actually been read. Children only ever
   * render when this is true, so a consumer inside the provider always sees
   * `true`; it is false only in the out-of-provider fallback below, where
   * nothing has been read at all.
   */
  hydrated: boolean;
  /** Tokens for the active theme. */
  t: ThemeTokens;
  setPreference: (next: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Process-lifetime cache of the answer SecureStore gave us.
 *
 * Module-scoped rather than component state because ThemeProvider REMOUNTS in
 * normal use: it sits under a PersistQueryClientProvider whose `key` flips
 * with the persistence scope on sign-in / sign-out. Without this, every one of
 * those transitions would re-run hydration and (on the async fallback path)
 * blank the tree again.
 */
let cachedPreference: ThemePreference | null = null;

/**
 * Read the stored preference WITHOUT yielding to the event loop, so first
 * paint already knows the answer.
 *
 * Returns null for "no answer" — which is not the same as "nothing stored".
 * A missing key IS an answer ('system'); null is reserved for "this device
 * could not tell us synchronously", the only case that needs the async
 * fallback and the render gate.
 */
function readStoredPreferenceSync(): ThemePreference | null {
  if (cachedPreference !== null) return cachedPreference;
  // Guarded: `getItem` is newer than `getItemAsync` and is not implemented on
  // every platform the bundle can run on.
  if (typeof SecureStore.getItem !== "function") return null;
  try {
    cachedPreference =
      parseThemePreference(SecureStore.getItem(THEME_PREFERENCE_KEY)) ??
      "system";
    return cachedPreference;
  } catch {
    // Keychain unavailable (e.g. launched before first unlock) — fall back to
    // the async read rather than guessing.
    return null;
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // RN's useColorScheme returns null on first paint occasionally; treat
  // null as "dark" since that matches the app's historical default.
  const sys = useColorScheme();
  // Lazy initialiser: the synchronous read happens during the first render,
  // before anything is committed, so the very first frame is already correct.
  const [preference, setPreferenceState] = useState<ThemePreference | null>(
    readStoredPreferenceSync,
  );

  const hydrated = preference !== null;

  useEffect(() => {
    if (hydrated) return;
    let cancelled = false;
    void (async () => {
      let answer: ThemePreference = "system";
      try {
        answer =
          parseThemePreference(
            await SecureStore.getItemAsync(THEME_PREFERENCE_KEY),
          ) ?? "system";
      } catch {
        // Storage is unreadable on this device; 'system' is the documented
        // default and gating forever would leave a blank app.
        answer = "system";
      }
      // Cache before the cancellation check: the answer is process-wide and
      // stays true whether or not THIS mount is still around to use it.
      cachedPreference = answer;
      if (!cancelled) setPreferenceState(answer);
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrated]);

  const setPreference = useCallback((next: ThemePreference) => {
    cachedPreference = next;
    setPreferenceState(next);
    void SecureStore.setItemAsync(THEME_PREFERENCE_KEY, next).catch(() => {
      /* secure store may be unavailable on some emulators — ignore */
    });
  }, []);

  // null while the preference is unknown — the signal to paint nothing.
  const resolved = useMemo(
    () => resolveFirstPaintTheme(preference, sys),
    [preference, sys],
  );
  const theme: ThemeName = resolved ?? resolveThemeName("system", sys);

  const value: ThemeContextValue = useMemo(
    () => ({
      theme,
      preference: preference ?? "system",
      hydrated,
      t: PALETTES[theme],
      setPreference,
    }),
    [theme, preference, hydrated, setPreference],
  );

  // THE GATE. Every hook above runs unconditionally, so this early return
  // never changes hook order. A blank frame here is covered by the splash
  // (the root layout already renders null until fonts + auth resolve); a
  // wrong-theme frame would not be covered by anything.
  if (resolved === null) return null;

  return createElement(ThemeContext.Provider, { value }, children);
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    // Fallback so hooks called outside the provider (e.g. in tests) don't
    // explode — they just see dark.
    return {
      theme: "dark",
      preference: "system",
      hydrated: false,
      t: dark,
      setPreference: () => undefined,
    };
  }
  return ctx;
}

export const palettes = PALETTES;
