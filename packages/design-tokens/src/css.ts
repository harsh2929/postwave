import { hexToHslTriplet } from "./color.js";
import { type PaletteTokens, type ThemeMode, tokens } from "./tokens.js";

/**
 * Map a canonical token key to a consumer's CSS custom-property name.
 * Web uses shadcn-style names (`--primary`); desktop uses `--pw-*`.
 */
export type VarNameMap = Partial<Record<keyof PaletteTokens, string>>;

/** Web (Tailwind/shadcn) brand-critical names, consumed as `hsl(var(--x))`. */
export const WEB_VAR_MAP: VarNameMap = {
  bg: "--background",
  fg: "--foreground",
  accent: "--primary",
  accentFg: "--primary-foreground",
  accentSubtle: "--accent",
  border: "--border",
  focus: "--ring",
  success: "--success",
  successEmphasis: "--success-emphasis",
  successSubtle: "--success-subtle",
  danger: "--destructive",
  dangerEmphasis: "--destructive-emphasis",
  dangerEmphasisFg: "--destructive-emphasis-foreground",
  gold: "--gold",
};

/**
 * Ops console brand-critical names. The ops console is a dark-only internal
 * control plane; its vars map onto the canonical DARK palette (warm ink +
 * ember), replacing the hand-rolled navy/sky-slate island the 2026-07-18
 * integration audit flagged as the loudest cohesion break. Status colors map
 * to the canonical semantic hues — the console's fail-loud red/amber/green
 * language rides the same values as every other surface.
 */
export const OPS_VAR_MAP: VarNameMap = {
  bg: "--bg",
  bgSubtle: "--bg-grad-1",
  surface: "--surface",
  surfaceElevated: "--surface-2",
  fg: "--text",
  fgMuted: "--text-2",
  fgSubtle: "--text-3",
  border: "--border",
  accent: "--accent",
  danger: "--red",
  warning: "--amber",
  success: "--green",
  info: "--blue",
  focus: "--focus",
};

/**
 * Audit-portal `--portal-*` names. The audit portal is a customer-facing,
 * white-label embed (light-default with a dark override), so — unlike the
 * dark-only ops console — it maps onto BOTH the canonical light and dark
 * palettes. This replaces the hand-rolled generic-gray/blue-700 island the
 * 2026-07-18 integration audit flagged (the last true design island).
 *
 * NOTE: `--portal-primary` is a runtime-overridable DEFAULT — the portal
 * overrides it per tenant from `branding.primary_color` (App.tsx). It maps to
 * the canonical accent so an un-branded portal still reads as Moosewave; a
 * white-labelled one replaces it at runtime, unaffected by this mapping.
 */
export const PORTAL_VAR_MAP: VarNameMap = {
  accent: "--portal-primary",
  fg: "--portal-fg",
  fgMuted: "--portal-muted",
  // `--portal-surface` is the elevated card/panel; `--portal-surface-2` is the
  // page `body` background beneath it (see audit-portal index.html/App.tsx).
  // So surface→canonical surface (white/near-black card) and surface-2→canonical
  // `bg` (warm paper / ink), giving the portal its Moosewave base layer.
  surface: "--portal-surface",
  bg: "--portal-surface-2",
  border: "--portal-border",
  danger: "--portal-danger",
};

/** Desktop `--pw-*` brand-critical names. */
export const DESKTOP_VAR_MAP: VarNameMap = {
  bg: "--pw-bg",
  surface: "--pw-bg-elev",
  fg: "--pw-fg",
  fgMuted: "--pw-fg-muted",
  fgSubtle: "--pw-fg-subtle",
  border: "--pw-border",
  accent: "--pw-accent",
  accentFg: "--pw-accent-fg",
  focus: "--pw-ring",
  success: "--pw-success",
  warning: "--pw-warning",
  danger: "--pw-danger",
  info: "--pw-info",
};

export type CssValueFormat = "hsl-triplet" | "hex";

/**
 * Emit CSS custom-property declarations for a theme, mapping canonical
 * keys to a consumer's variable names in the requested value format.
 * Returns the inner lines (no selector) so the caller can wrap them in
 * `:root { … }` / `.dark { … }`.
 */
export function toCssVars(
  mode: ThemeMode,
  nameMap: VarNameMap,
  format: CssValueFormat,
  indent = "  ",
): string {
  const palette = tokens[mode];
  const lines: string[] = [];
  for (const key of Object.keys(nameMap) as (keyof PaletteTokens)[]) {
    const varName = nameMap[key];
    if (!varName) continue;
    const raw = palette[key];
    const value = format === "hsl-triplet" ? hexToHslTriplet(raw) : raw;
    lines.push(`${indent}${varName}: ${value};`);
  }
  return lines.join("\n");
}

/** Brand anchors that MUST be byte-identical across every consumer — the
 *  drift guard checks these hex values appear in each client's theme. */
export const BRAND_ANCHORS = {
  emberLight: tokens.light.accent, // #C8102E
  emberDark: tokens.dark.accent, // #E55262
  paper: tokens.light.bg, // #FDFCF8
  ink: tokens.dark.bg, // #0F0F0F
  warmBorder: tokens.light.border, // #E0DDD3
  gold: tokens.light.gold, // #F2B233
} as const;
