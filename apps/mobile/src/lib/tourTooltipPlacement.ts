/**
 * lib/tourTooltipPlacement.ts — where the product tour's card is allowed to sit.
 *
 * WHY THIS IS A MODULE AND NOT A `useMemo` IN THE COMPONENT.
 *
 * It used to be the useMemo. The tour's second beat ("Your numbers, live")
 * asks for `placement: "bottom"` against `dashboard.stats`, and the old code
 * honoured that request unconditionally: `top = anchor.y + anchor.height + GAP`
 * with a floor of `insets.top + 8` and NO ceiling. On an iPhone 17 Pro
 * (874pt tall) with the stats block measured low on a loaded dashboard, that
 * put the card's heading at y≈854 — the body copy and BOTH buttons ("Next
 * step", "Skip tour") entirely below the bottom edge. The backdrop swallowed
 * every tap, so there was no control to reach: the accessibility tree while
 * that step was up held three elements, none of them a way out. The only
 * escape was force-quitting the app.
 *
 * The mirror bug lived in the "top" branch, which anchored by `bottom:` so it
 * never had to know its own height — an anchor near the TOP of the screen
 * pushed the card off the top edge by exactly the same arithmetic.
 *
 * So the rule this module exists to enforce, for every step and every anchor:
 *
 *   THE CARD RECT IS ALWAYS FULLY INSIDE THE SAFE AREA.
 *
 * A requested side is a PREFERENCE, not an instruction. When the preferred
 * side cannot hold the card we flip to the other one; when neither can, we
 * take the roomier side and clamp. Clamping is what makes the guarantee
 * total — it also covers the case the Dashboard actually produces, where the
 * anchor MOVES as data loads and a placement that fit at measure time would
 * not fit a frame later.
 *
 * Height is an input rather than something we guess at, because the caller
 * can measure the card with `onLayout` and re-resolve. Before the first
 * layout pass the caller passes a deliberate OVER-estimate: over-estimating
 * flips the card early (harmless), under-estimating hangs it off an edge
 * (the bug).
 *
 * `fits: false` reports the one case no placement can fix — a safe band
 * shorter than the card, reachable only at the largest dynamic-type settings
 * on the smallest devices. The card is pinned to the safe top there so the
 * title and body are readable, and the overlay's dismissible backdrop is the
 * escape hatch for it.
 *
 * No react-native imports: this is node-tested under vitest, and the geometry
 * is the part worth testing.
 */

/** Pixel rect in window coordinates. Structurally `TourRect`. */
export interface TooltipGeomRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Structurally `EdgeInsets` from react-native-safe-area-context. */
export interface TooltipGeomInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** What the step ASKED for. */
export type TooltipPlacementRequest = "top" | "bottom" | "auto" | "center";

/** What it actually GOT. */
export type TooltipPlacementSide = "top" | "bottom" | "center";

export interface TooltipPlacementInput {
  /** Measured anchor rect, or null for a centered (welcome/outro) step. */
  anchor: TooltipGeomRect | null;
  /** The step's requested side. Defaults to "auto". */
  requested?: TooltipPlacementRequest;
  viewport: { width: number; height: number };
  insets: TooltipGeomInsets;
  /** Measured card height, or a conservative over-estimate before layout. */
  cardHeight: number;
  /** Upper bound on card width. Defaults to 420. */
  maxWidth?: number;
  /** Distance kept between card and anchor. Defaults to 16. */
  gap?: number;
}

export interface TooltipPlacement {
  side: TooltipPlacementSide;
  left: number;
  top: number;
  width: number;
  height: number;
  /**
   * False when the safe band is shorter than the card — the one case where
   * the rect above is a best effort rather than the whole card.
   */
  fits: boolean;
}

/** Side margins, matching the tooltip's historical 16pt gutters. */
export const TOOLTIP_HORIZONTAL_MARGIN = 16;
/** Top/bottom breathing room inside the safe area (was `insets.top + 8`). */
export const TOOLTIP_VERTICAL_MARGIN = 8;
export const TOOLTIP_GAP = 16;
export const TOOLTIP_MAX_WIDTH = 420;

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, low: number, high: number): number {
  if (high < low) return low;
  return Math.min(high, Math.max(low, value));
}

/** The rectangle the card may occupy: viewport minus insets minus margins. */
function safeBand(input: TooltipPlacementInput) {
  const width = Math.max(0, finite(input.viewport.width));
  const height = Math.max(0, finite(input.viewport.height));
  const left = finite(input.insets.left) + TOOLTIP_HORIZONTAL_MARGIN;
  const right = width - finite(input.insets.right) - TOOLTIP_HORIZONTAL_MARGIN;
  const top = finite(input.insets.top) + TOOLTIP_VERTICAL_MARGIN;
  const bottom =
    height - finite(input.insets.bottom) - TOOLTIP_VERTICAL_MARGIN;
  return {
    left,
    top,
    right: Math.max(left, right),
    bottom: Math.max(top, bottom),
  };
}

/**
 * Pick a side. A requested side wins only when the card actually fits there;
 * otherwise we flip, and if neither side fits we take the roomier one and let
 * the caller's clamp keep the card on screen.
 */
function pickSide(
  requested: TooltipPlacementRequest,
  height: number,
  spaceAbove: number,
  spaceBelow: number,
): "top" | "bottom" {
  const fitsAbove = height <= spaceAbove;
  const fitsBelow = height <= spaceBelow;
  if (requested === "bottom") {
    if (fitsBelow) return "bottom";
    if (fitsAbove) return "top";
  } else if (requested === "top") {
    if (fitsAbove) return "top";
    if (fitsBelow) return "bottom";
  } else {
    // "auto" (and any unknown value): prefer a side that fits, and when both
    // do, the roomier one — the original tie-break, preserved.
    if (fitsBelow && !fitsAbove) return "bottom";
    if (fitsAbove && !fitsBelow) return "top";
  }
  return spaceBelow >= spaceAbove ? "bottom" : "top";
}

/**
 * Resolve the card's on-screen rect.
 *
 * The returned rect is inside the safe area on all four edges whenever the
 * card fits in it at all (`fits`), and pinned to the safe top when it does
 * not.
 */
export function resolveTooltipPlacement(
  input: TooltipPlacementInput,
): TooltipPlacement {
  const band = safeBand(input);
  const availableWidth = band.right - band.left;
  const availableHeight = band.bottom - band.top;

  const width = Math.max(
    0,
    Math.min(input.maxWidth ?? TOOLTIP_MAX_WIDTH, availableWidth),
  );
  const left = band.left + (availableWidth - width) / 2;

  const requestedHeight = Math.max(0, finite(input.cardHeight));
  const height = Math.min(requestedHeight, availableHeight);
  const fits = requestedHeight <= availableHeight;

  const requested = input.requested ?? "auto";
  const anchor = input.anchor;
  if (requested === "center" || anchor == null) {
    return {
      side: "center",
      left,
      width,
      height,
      fits,
      top: band.top + (availableHeight - height) / 2,
    };
  }

  const gap = input.gap ?? TOOLTIP_GAP;
  const anchorTop = finite(anchor.y);
  const anchorBottom = anchorTop + Math.max(0, finite(anchor.height));
  const spaceAbove = anchorTop - gap - band.top;
  const spaceBelow = band.bottom - (anchorBottom + gap);

  const side = pickSide(requested, height, spaceAbove, spaceBelow);
  const desiredTop =
    side === "bottom" ? anchorBottom + gap : anchorTop - gap - height;

  return {
    side,
    left,
    width,
    height,
    fits,
    // The clamp is the guarantee. Everything above only chooses which edge we
    // start from; this is what keeps the buttons reachable.
    top: clamp(desiredTop, band.top, band.bottom - height),
  };
}
