/**
 * Moosewave canonical design tokens — the SINGLE source of truth for the
 * brand across every client (web, desktop, mobile, email).
 *
 * Before this package the brand was hand-duplicated in apps/web
 * globals.css, apps/desktop styles.css, and apps/mobile theme.ts, "synced
 * by comment" — and it had drifted (desktop dark canvas was a cool
 * blue-slate #0c0e14 instead of warm ink; success/info/warning hues
 * differed between apps). These values reconcile that drift. Consumers
 * derive their CSS custom properties / RN theme objects from here so a
 * brand change lands once and a drift is caught by CI (see scripts).
 *
 * Canonical decisions (documented so they are intentional, not accidental):
 *  - Dark canvas = warm ink #0F0F0F (web + mobile), NOT desktop's old cool
 *    blue-slate #0c0e14. Ink is the brand surface.
 *  - Ember accent: #C8102E (light) / #E55262 (dark) — the conviction color.
 *  - Status greens/blues/ambers unified to the mobile/web values (desktop
 *    #10b981 success and #818cf8 info were the outliers).
 *  - Light values follow apps/web globals.css, which carries the AA-contrast
 *    tuning (e.g. darkened success, gold-as-fill-only).
 */

export interface PaletteTokens {
  /** App canvas. Light = warm paper, never pure white. Dark = warm ink. */
  bg: string;
  /** Slightly recessed canvas (section backgrounds). */
  bgSubtle: string;
  /** Raised surface (cards, lists, headers). */
  surface: string;
  /** Most-raised surface (popovers, elevated cards). */
  surfaceElevated: string;
  /** Primary text. */
  fg: string;
  /** Secondary text. */
  fgMuted: string;
  /** Tertiary / hint text. */
  fgSubtle: string;
  /** Default hairline border. */
  border: string;
  /** Subtle inside-card border. */
  borderSubtle: string;
  /** Ember — brand / CTA / active / selected. NOT positive-status. */
  accent: string;
  /** A darker ember for hover/pressed on the accent. */
  accentDim: string;
  /** Legible foreground ON the accent fill. */
  accentFg: string;
  /** Low-alpha ember tint for hover/active backgrounds. */
  accentSubtle: string;
  /** Destructive / error — hue-distinct from ember so they never read alike. */
  danger: string;
  /**
   * Strong destructive ink/fill. Use for destructive button fills and error
   * text on a low-alpha danger wash where the base danger hue is not AA-safe.
   */
  dangerEmphasis: string;
  /** Legible foreground painted on the strong destructive fill. */
  dangerEmphasisFg: string;
  /** Caution — gold/amber fill-behind-dark-text. */
  warning: string;
  /** Positive status (active/enabled/sent/verified/live). Green, not ember. */
  success: string;
  /** AA-safe positive-status ink on subtle or low-alpha success surfaces. */
  successEmphasis: string;
  /** Low-emphasis positive-status surface. */
  successSubtle: string;
  /** Neutral informational accent. */
  info: string;
  /** The single celebratory spark (#F2B233 family). */
  gold: string;
  /** Focus ring — glows ember. */
  focus: string;
  /** Scrim behind modals/sheets. */
  overlay: string;
}

/** Light theme — warm paper canvas, ember-500 accent, AA-tuned. */
export const light: PaletteTokens = {
  bg: "#FDFCF8",
  bgSubtle: "#F2F0EA",
  surface: "#FFFFFF",
  surfaceElevated: "#FFFFFF",
  fg: "#0F0F0F",
  fgMuted: "#5C5C5C",
  fgSubtle: "#7A766C",
  border: "#E0DDD3",
  borderSubtle: "#ECE9E1",
  accent: "#C8102E",
  accentDim: "#A60D26",
  accentFg: "#FDFCF8",
  accentSubtle: "#FCE9EC",
  danger: "#D43C1F",
  dangerEmphasis: "#B1341B",
  dangerEmphasisFg: "#FDFCF8",
  warning: "#B45309",
  success: "#1E7A55",
  successEmphasis: "#196748",
  successSubtle: "#ECF9F3",
  info: "#1466B8",
  gold: "#F2B233",
  focus: "#C8102E",
  overlay: "rgba(15,15,15,0.5)",
};

/** Dark theme — warm ink canvas (NOT blue-slate), ember lifted for vividness. */
export const dark: PaletteTokens = {
  bg: "#0F0F0F",
  bgSubtle: "#161616",
  surface: "#1A1A1A",
  surfaceElevated: "#242424",
  fg: "#F6F4ED",
  fgMuted: "#B8B8B8",
  fgSubtle: "#8A8A86",
  border: "#2E2E2E",
  borderSubtle: "#242424",
  accent: "#E55262",
  accentDim: "#C8102E",
  accentFg: "#0F0F0F",
  accentSubtle: "#3A1A20",
  danger: "#F0623D",
  dangerEmphasis: "#F48367",
  dangerEmphasisFg: "#141414",
  warning: "#F1C04C",
  success: "#34D399",
  successEmphasis: "#34D399",
  successSubtle: "#153225",
  info: "#7AA2F0",
  gold: "#F1C04C",
  focus: "#E55262",
  overlay: "rgba(0,0,0,0.66)",
};

export type ThemeMode = "light" | "dark";

/** Both themes keyed by mode — the canonical token tree. */
export const tokens: Record<ThemeMode, PaletteTokens> = { light, dark };

/** Typography — the brand pairing used across surfaces. */
export const fonts = {
  /** Body / UI. */
  sans: "Inter",
  /** Editorial display — headlines, big metrics. */
  display: "Fraunces",
  /** Monospace — code, IDs, URLs. */
  mono: "Menlo",
} as const;

/** Radius scale (px). */
export const radius = {
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  pill: 999,
} as const;

export const TOKEN_KEYS = Object.keys(light) as (keyof PaletteTokens)[];
