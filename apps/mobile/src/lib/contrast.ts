/**
 * lib/contrast.ts — WCAG contrast arithmetic, so "is this visible?" is a
 * measurement rather than an opinion.
 *
 * This exists because of a real, shipped mistake. A tile's loading placeholder
 * was moved off `surfaceElevated` and onto `borderSubtle` in the belief that it
 * raised contrast. In the dark palette those two tokens are the SAME value
 * (#242424), so nothing changed: the bar sat at 1.12:1 against `surface` and a
 * loading tile still read as an empty one. Nobody caught it because the check
 * was done by eye on a light-mode simulator.
 *
 * Pure by construction — no React, no react-native, no theme hook — so the
 * palettes in @postwave/design-tokens can be asserted directly in the node
 * test environment.
 */

/** Parsed sRGB channels, 0..255. Null when the input is not `#rrggbb`. */
export function parseHex(color: string): [number, number, number] | null {
  if (typeof color !== "string") return null;
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return null;
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
}

function channelLuminance(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance, 0 (black) .. 1 (white). NaN for an unparseable colour. */
export function relativeLuminance(color: string): number {
  const rgb = parseHex(color);
  if (!rgb) return Number.NaN;
  const [r, g, b] = rgb;
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

/** WCAG contrast ratio, 1 (identical) .. 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (Number.isNaN(la) || Number.isNaN(lb)) return Number.NaN;
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Composite `foreground` drawn at `alpha` opacity over `background`.
 *
 * A translucent element's contrast is a property of the COMPOSITE, not of the
 * token it was given — which is exactly the trap an animated skeleton falls
 * into, since its pulse spends every frame at less than full opacity.
 */
export function blendOver(
  foreground: string,
  background: string,
  alpha: number,
): string {
  const fg = parseHex(foreground);
  const bg = parseHex(background);
  if (!fg || !bg) return foreground;
  const a = Math.max(0, Math.min(1, alpha));
  const mix = (i: 0 | 1 | 2): string =>
    Math.round(fg[i] * a + bg[i] * (1 - a))
      .toString(16)
      .padStart(2, "0");
  return `#${mix(0)}${mix(1)}${mix(2)}`;
}

/**
 * The opacity `components/Skeleton.tsx` parks its pulse at — the midpoint of
 * its DIM/BRIGHT loop, and the exact value it freezes at under Reduce Motion.
 * That frozen frame is the one a contrast requirement has to be met at: an
 * animated bar can borrow legibility from its motion, a static one cannot.
 */
export const SKELETON_PARKED_ALPHA = (0.45 + 0.9) / 2;

/**
 * Palette key used for a stat tile's loading bar. Named here rather than
 * inline in the component so the pairing is asserted in `contrast.test.ts`
 * against both shipped palettes, and a well-meaning swap back to a token that
 * happens to equal `surface` fails the build instead of the eye test.
 */
export const STAT_CARD_SKELETON_TOKEN = "fgMuted" as const;

/**
 * The fill every Skeleton uses. Shared with STAT_CARD_SKELETON_TOKEN because
 * the same arithmetic applies everywhere: a placeholder that does not clear the
 * non-text floor against `surface` makes a LOADING screen indistinguishable
 * from an EMPTY one, which is the single worst thing a loading state can do.
 */
export const SKELETON_FILL_TOKEN = "fgMuted" as const;

/** Non-text contrast floor for a UI component (WCAG 2.2 SC 1.4.11). */
export const NON_TEXT_CONTRAST_MIN = 3;
