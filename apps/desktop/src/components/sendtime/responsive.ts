/**
 * Pure helpers backing the SendTimeHeatmap mobile-responsive layout
 * (gap feature: sto-heatmap-mobile-responsive).
 *
 * These live in their own .ts module (not the .tsx component) so the
 * vitest node environment can import them without parsing JSX —
 * matches the same pattern as ./tz and ./a11y for the timezone toggle
 * and accessibility helpers.
 *
 * What we expose
 * --------------
 *  - `MOBILE_BREAKPOINT_PX`  → 640px container-width breakpoint below
 *    which the 7×24 grid degrades to invisible cell slivers, so we
 *    swap to a vertical "Top send times" list instead.
 *  - `MOBILE_TOP_N`          → number of candidate (dow, hour) windows
 *    shown in the mobile list view. Matches the audit's "Top 5".
 *  - `shouldUseMobileLayout(width)` → pure decision helper. Returns
 *    false for pre-measurement (0), negative, or non-finite widths so
 *    the canonical desktop grid renders by default and we only switch
 *    to the list once we've confirmed a real, narrow measurement.
 *
 * Why a container-width breakpoint (not a viewport @media query)
 * --------------------------------------------------------------
 * The heatmap can live inside narrow cards on otherwise-wide pages
 * (e.g. a slim side-rail). A viewport-based @media query would miss
 * that case. It also sidesteps a Tauri webview quirk where @media
 * occasionally lags re-evaluating during programmatic resizes. JS
 * measurement via ResizeObserver keeps the breakpoint local to the
 * component and reactive to its actual rendered width.
 */

/** Container-width breakpoint below which the heatmap collapses to
 *  the vertical "Top send times" list. 640px matches the Tailwind/sm
 *  convention and visually corresponds to the point at which each of
 *  the 24 hour columns drops under ~16px wide — too narrow to convey
 *  ramp colour or accept a tap target. */
export const MOBILE_BREAKPOINT_PX = 640;

/** Number of (dow, hour) buckets surfaced in the mobile list view.
 *  Five mirrors the audit's "Top 5 send times" implementation sketch
 *  and stays short enough to thumb-scroll without paginating. */
export const MOBILE_TOP_N = 5;

/** Decide which layout to render given an observed container width.
 *
 *  Returns `true` once we have a measurement and it is below the
 *  breakpoint. A width of 0 (pre-measurement), negative, NaN, or
 *  Infinity returns `false` so SSR / first-paint defaults to the
 *  canonical grid view — flipping to the list only after we've
 *  actually confirmed the available width is too tight. This avoids
 *  a visible list→grid flash on every desktop mount. */
export function shouldUseMobileLayout(width: number): boolean {
  if (!Number.isFinite(width) || width <= 0) return false;
  return width < MOBILE_BREAKPOINT_PX;
}
