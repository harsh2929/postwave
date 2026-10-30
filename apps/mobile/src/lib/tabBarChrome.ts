/**
 * lib/tabBarChrome.ts — the bottom tab bar's visual contract, as a pure
 * function of (theme tokens, safe-area inset, OS text scale).
 *
 * Extracted from `app/(tabs)/_layout.tsx` when that component crossed its
 * function-size budget. The seam is a real one rather than a size dodge: the
 * layout file must keep its literal `<Tabs.Screen name="…">` entries — the
 * nav-consistency test parses that file's TEXT to prove every route is
 * registered — so the chrome is the part that can move, and moving it makes
 * the one interesting rule testable in isolation:
 *
 *   the bar's height is DERIVED from the scaled tab label, never a literal.
 *
 * A hardcoded `60` is correct at exactly one text size; above it the label
 * grows inside a bar that cannot, so it clips or shoulders the icon out.
 */
import type { ThemeTokens } from "@/lib/theme";
import { tabBarHeightFor, typeCap, typeStyle } from "@/lib/typeScale";

/**
 * The repeating half of a PRIMARY tab's `options`: its two labels.
 *
 * Each primary tab reads the same two facts from the shared @postwave/nav
 * manifest — the long title and the short rail label — behind the same local
 * fallbacks. Written inline, that is eight lines per tab in
 * `app/(tabs)/_layout.tsx`, and the interesting part (which tabs exist, in what
 * order, and which are conditionally hidden) is buried in the repetition.
 *
 * The icon and the `listeners` stay at the call site: the icon is JSX, and the
 * listener names the analytics event, which should be visible beside the tab it
 * reports. This deliberately does NOT take the whole options object — a helper
 * that hid `href: null` would hide the one thing that decides whether a tab is
 * on the rail at all.
 */
export function primaryTabLabels({
  title,
  shortLabel,
}: {
  title: string;
  shortLabel: string;
}) {
  return { title, tabBarLabel: shortLabel };
}

export interface TabBarChromeInput {
  t: ThemeTokens;
  /** Bottom safe-area inset; 0 on devices without a home indicator. */
  bottomInset: number;
  /** OS text-size multiplier from `useWindowDimensions().fontScale`. */
  fontScale: number;
}

/**
 * `screenOptions` for the tab navigator. Returns a plain object so the caller
 * spreads it directly into <Tabs screenOptions={…}>.
 */
export function tabBarScreenOptions({
  t,
  bottomInset,
  fontScale,
}: TabBarChromeInput) {
  return {
    // Hide the native iOS large title — every screen renders its own inline
    // ScreenHeader for tighter information density. Without this, ~150px of
    // vertical space at the top is wasted.
    headerShown: false as const,
    tabBarStyle: {
      backgroundColor: t.bgSubtle,
      borderTopColor: t.border,
      borderTopWidth: 1,
      // Derived from the tabLabel type role, never a literal — see the module
      // header. The role's own 1.3x ceiling bounds the growth.
      height: tabBarHeightFor(fontScale) + bottomInset,
      paddingTop: 8,
      paddingBottom: bottomInset,
    },
    tabBarLabelStyle: {
      ...typeStyle("tabLabel"),
      fontWeight: "500" as const,
      marginTop: 2,
    },
    ...typeCap("tabLabel"),
    tabBarItemStyle: { paddingTop: 4 },
    tabBarActiveTintColor: t.accent,
    // `tabLabel` is the smallest text role in the shell. The tertiary token
    // only reaches 3.98:1 on this light background, so it is reserved for
    // large/decorative text; rail labels use the AA-safe muted foreground.
    tabBarInactiveTintColor: t.fgMuted,
  };
}
