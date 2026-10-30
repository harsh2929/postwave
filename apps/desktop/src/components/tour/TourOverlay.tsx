/**
 * TourOverlay — full-viewport backdrop with an SVG-mask spotlight cut
 * around the focused target.
 *
 * Implementation choice: we draw a black `<rect>` covering the entire
 * viewport into an SVG `<mask>`, then a white rounded rect over the
 * target. The mask is applied to a `<rect>` filled with the dim colour;
 * white = visible, black = transparent. The result is a "hole" with
 * properly anti-aliased rounded corners — more reliable than the older
 * box-shadow trick which can show seams at high-DPR.
 *
 * Pointer events: the *visible* dim region captures clicks (so users
 * can't poke buttons outside the spotlight), but the spotlight cutout
 * itself does NOT — the brief explicitly says we shouldn't block
 * interactions on the highlighted target. We achieve that with two
 * stacked layers: the SVG is `pointer-events: none` (passes everything
 * through), and we draw four absolutely-positioned `<div>`s around
 * the target rect that swallow clicks in the dim zone.
 *
 * Centered modal mode: when `rect` is null, we render a fully-opaque
 * backdrop (no spotlight) — the welcome and done steps use this.
 */

import { type ReactElement, useEffect, useState } from "react";

import { motion } from "./motion-tokens";

interface OverlayProps {
  rect: DOMRect | null;
}

/* Token-sourced from the canonical motion mirror (motion-tokens.ts) rather
 * than hardcoded literals, so the spotlight geometry + scrim stay in lock-step
 * with web/mobile. */
const SPOTLIGHT_PAD = motion.spotlight.padding; // px of breathing room around the target
const SPOTLIGHT_RADIUS = motion.spotlight.radius; // px corner radius
/** Scrim opacity as an integer percentage for color-mix(). */
const SCRIM_PCT = Math.round(motion.backdrop.opacity * 100);

export function TourOverlay({ rect }: OverlayProps): ReactElement {
  const [vp, setVp] = useState<{ w: number; h: number }>(() => ({
    w: typeof window !== "undefined" ? window.innerWidth : 0,
    h: typeof window !== "undefined" ? window.innerHeight : 0,
  }));

  /* Track viewport size so the SVG always covers the whole window even
   * after resize. The provider already triggers re-measure on resize,
   * so we'll re-render with a fresh rect at the same time. */
  useEffect(() => {
    const onResize = (): void => {
      setVp({ w: window.innerWidth, h: window.innerHeight });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Centered modal — no spotlight, just the dim layer.
  if (!rect) {
    return <div className="tour-overlay tour-overlay-solid" aria-hidden="true" />;
  }

  /* Compute the spotlight rect, clamped to the viewport so an
   * out-of-bounds target doesn't produce an off-screen hole. */
  const sx = Math.max(0, rect.left - SPOTLIGHT_PAD);
  const sy = Math.max(0, rect.top - SPOTLIGHT_PAD);
  const sw = Math.min(vp.w - sx, rect.width + SPOTLIGHT_PAD * 2);
  const sh = Math.min(vp.h - sy, rect.height + SPOTLIGHT_PAD * 2);

  // Mask id needs to be unique enough to avoid collisions with anything
  // else on the page that might also use SVG masks.
  const maskId = "pw-tour-spotlight-mask";

  return (
    <div className="tour-overlay" aria-hidden="true">
      {/* Visible dim layer — the SVG paints itself, NOT the page. */}
      <svg
        className="tour-overlay-svg"
        width={vp.w}
        height={vp.h}
        viewBox={`0 0 ${vp.w} ${vp.h}`}
        preserveAspectRatio="none"
      >
        <defs>
          <mask id={maskId}>
            <rect x="0" y="0" width={vp.w} height={vp.h} fill="white" />
            <rect
              x={sx}
              y={sy}
              width={sw}
              height={sh}
              rx={SPOTLIGHT_RADIUS}
              ry={SPOTLIGHT_RADIUS}
              fill="black"
            />
          </mask>
        </defs>
        <rect
          x="0"
          y="0"
          width={vp.w}
          height={vp.h}
          fill={`color-mix(in srgb, var(--pw-shadow-color) ${SCRIM_PCT}%, transparent)`}
          mask={`url(#${maskId})`}
        />
      </svg>

      {/* Click-swallowing dim zones — four invisible divs covering the
       *  area OUTSIDE the spotlight rect (top / bottom / left / right).
       *  CSS masks only affect painting, not hit-testing, so the SVG
       *  above is pointer-events:none (it just draws) and these divs
       *  do the hit-testing: pointer-events:auto outside the cutout,
       *  nothing over it — clicks on the spotlit element pass through. */}
      <div
        className="tour-overlay-dim"
        style={{ left: 0, top: 0, width: vp.w, height: sy }}
      />
      <div
        className="tour-overlay-dim"
        style={{
          left: 0,
          top: sy + sh,
          width: vp.w,
          height: Math.max(0, vp.h - (sy + sh)),
        }}
      />
      <div
        className="tour-overlay-dim"
        style={{ left: 0, top: sy, width: sx, height: sh }}
      />
      <div
        className="tour-overlay-dim"
        style={{
          left: sx + sw,
          top: sy,
          width: Math.max(0, vp.w - (sx + sw)),
          height: sh,
        }}
      />

      {/* Pulsing accent outline glued to the target. Pointer-events
       *  off so it doesn't intercept clicks on the spotlit element. */}
      <div
        className="tour-spotlight"
        style={{
          left: sx,
          top: sy,
          width: sw,
          height: sh,
          borderRadius: SPOTLIGHT_RADIUS,
        }}
      />
    </div>
  );
}
