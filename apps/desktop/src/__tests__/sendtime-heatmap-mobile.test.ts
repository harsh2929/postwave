/**
 * Tests for the SendTimeHeatmap mobile-responsive breakpoint helper
 * (gap feature: sto-heatmap-mobile-responsive).
 *
 * The heatmap collapses from the 7×24 grid to a vertical "Top send
 * times" list when its container is narrower than the mobile
 * breakpoint. We pin the pure decision helper so future refactors
 * can't silently drift the threshold (e.g. someone bumps it to 480px
 * and the iPhone-SE viewport stops triggering) or invert the polarity
 * (default to list everywhere, breaking the desktop view).
 *
 * Bug surfaces this protects:
 *   - First-paint flicker: a pre-measurement width of 0 must NOT
 *     trigger the list view, otherwise every render starts as a list
 *     and pops to a grid one tick later.
 *   - NaN / non-finite widths leaking from a broken ResizeObserver
 *     entry must default to the desktop layout, not crash.
 *   - Exactly-at-breakpoint behavior: 640px must render as desktop
 *     (the grid fits) — only widths strictly below the breakpoint
 *     should collapse.
 */

import { describe, expect, it } from "vitest";

// Import directly from the pure-helper module (not the .tsx component)
// so vitest's node environment doesn't have to parse JSX. The .tsx
// re-exports the same symbols for any non-test caller.
import {
  MOBILE_BREAKPOINT_PX,
  MOBILE_TOP_N,
  shouldUseMobileLayout,
} from "../components/sendtime/responsive";

describe("shouldUseMobileLayout — container-width breakpoint", () => {
  it("returns false for a pre-measurement width of 0", () => {
    // ResizeObserver hasn't reported yet on first paint. We must
    // render the canonical desktop grid until we have a real width;
    // otherwise the component pops list→grid one tick after mount,
    // which is a visible flash.
    expect(shouldUseMobileLayout(0)).toBe(false);
  });

  it("returns false for negative widths", () => {
    // Defensive: contentRect.width should never be negative, but
    // detached / hidden elements can produce odd values. Treat them
    // as "no measurement yet".
    expect(shouldUseMobileLayout(-12)).toBe(false);
  });

  it("returns false for NaN / non-finite widths", () => {
    expect(shouldUseMobileLayout(Number.NaN)).toBe(false);
    expect(shouldUseMobileLayout(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("collapses to mobile at sub-breakpoint widths (360px = iPhone SE)", () => {
    // 360px is the audit's reference viewport — the original failure
    // mode (cells degrade to invisible slivers) bites here. Must
    // collapse to the list.
    expect(shouldUseMobileLayout(360)).toBe(true);
  });

  it("collapses to mobile at the just-below-breakpoint width", () => {
    expect(shouldUseMobileLayout(MOBILE_BREAKPOINT_PX - 1)).toBe(true);
  });

  it("stays on desktop layout at exactly the breakpoint", () => {
    // The grid technically fits at 640px (the breakpoint corresponds
    // to "below which cells get too narrow"), so 640 itself should
    // not trigger the collapse. This pins the polarity.
    expect(shouldUseMobileLayout(MOBILE_BREAKPOINT_PX)).toBe(false);
  });

  it("stays on desktop layout at typical tablet/laptop widths", () => {
    expect(shouldUseMobileLayout(800)).toBe(false);
    expect(shouldUseMobileLayout(1200)).toBe(false);
    expect(shouldUseMobileLayout(1920)).toBe(false);
  });
});

describe("MOBILE_BREAKPOINT_PX — exported constant stays stable", () => {
  it("matches the 640px sm breakpoint used elsewhere in the app", () => {
    // Anchor: if someone changes this, the audit register and any
    // upstream callers (custom embeds, snapshot tests) need to be
    // updated in lock-step. Pinning it prevents silent drift.
    expect(MOBILE_BREAKPOINT_PX).toBe(640);
  });
});

describe("MOBILE_TOP_N — top-N for the list view", () => {
  it("surfaces 5 candidate windows — matches the audit sketch", () => {
    // The audit's implementation sketch calls for "Top 5 send times".
    // Pinning this protects against a refactor dropping it to 3 (the
    // SR-summary value) and silently losing operator pick-list depth.
    expect(MOBILE_TOP_N).toBe(5);
  });
});
