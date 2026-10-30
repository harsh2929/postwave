/**
 * lib/paletteSettingsItems.ts — Settings sections as command-palette targets.
 *
 * Desktop's palette indexes every settings anchor (SETTINGS_NAVIGATION_ITEMS
 * over SETTINGS_INFORMATION_ARCHITECTURE, CommandPalette.tsx:127), so
 * "passkey" or "telemetry" typed anywhere lands on that section. Mobile had the
 * same index all along — lib/settingsIA — but only the Settings screen's own
 * search box read it, so the global palette knew the screen and none of its
 * twenty-four sections: a phone user had to open Settings first and search
 * again there.
 *
 * One item per SETTINGS_ANCHORS entry, routed to /(tabs)/settings with the
 * anchor in `?anchor=`. hooks/useSettingsAnchorParam.ts consumes it on the
 * settings screen through the same jumpToSection the SettingsIndex tap uses,
 * so the two entry points cannot scroll to different places.
 *
 * Role-gated sections are NOT filtered here. settingsIA carries no role
 * metadata, and the settings screen already answers a jump to a section that
 * never mounted with its "isn't available for your workspace role" notice —
 * the palette reuses that answer rather than inventing a second, drifting one.
 *
 * Node-run: no react-native imports.
 */
import type { NavigationTarget } from "@/lib/navigateTo";
import type { PaletteItem } from "@/lib/paletteItems";
import { SETTINGS_ANCHORS, type SettingsAnchor } from "@/lib/settingsIA";

export const SETTINGS_ROUTE = "/(tabs)/settings";

/** Query param naming the section to scroll to on arrival. */
export const SETTINGS_ANCHOR_PARAM = "anchor";

/**
 * Words the GLOBAL palette should answer that the IA's keywords do not carry,
 * keyed by anchor. Palette-only on purpose: settingsIA is shared with the
 * Settings screen's own index and is edited alongside every new section, so
 * a palette-driven vocabulary is kept out of its way. "passkey" is the
 * register's own example of the query that used to return nothing.
 */
const PALETTE_KEYWORDS: Readonly<Partial<Record<string, string>>> = {
  security: "passkey passkeys webauthn face id touch id",
};

/** The {pathname, params} href that opens Settings scrolled to `key`. */
export function settingsAnchorTarget(key: string): NavigationTarget {
  return {
    pathname: SETTINGS_ROUTE,
    params: { [SETTINGS_ANCHOR_PARAM]: key },
  };
}

function itemFor(anchor: SettingsAnchor): PaletteItem {
  const extra = PALETTE_KEYWORDS[anchor.key];
  const keywords = anchor.keywords.join(" ");
  return {
    id: `settings:${anchor.key}`,
    kind: "settings",
    title: anchor.label,
    // The category is what desktop shows as the hint, and it is what tells
    // "Privacy" (the telemetry section) apart from "Data retention".
    subtitle: `Settings · ${anchor.category}`,
    icon: "settings",
    route: SETTINGS_ROUTE,
    params: { [SETTINGS_ANCHOR_PARAM]: anchor.key },
    keywords: extra ? `${keywords} ${extra}` : keywords,
  };
}

/** Every Settings section as a palette item, in IA order. */
export function buildSettingsItems(
  anchors: readonly SettingsAnchor[] = SETTINGS_ANCHORS,
): PaletteItem[] {
  return anchors.map(itemFor);
}

/**
 * The anchor a `?anchor=` param names, or null.
 *
 * Expo hands a repeated param back as an array and an absent one as
 * undefined; anything that is not a declared anchor key is dropped, so a
 * stale link or a hand-typed URL can never scroll to nowhere — or trigger the
 * role notice for a section that does not exist.
 */
export function parseSettingsAnchorParam(
  raw: unknown,
  anchors: readonly SettingsAnchor[] = SETTINGS_ANCHORS,
): string | null {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== "string") return null;
  const key = first.trim();
  if (!key) return null;
  return anchors.some((anchor) => anchor.key === key) ? key : null;
}
