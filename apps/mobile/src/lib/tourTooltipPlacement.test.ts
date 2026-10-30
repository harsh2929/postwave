import { describe, expect, it } from "vitest";

import {
  resolveTooltipPlacement,
  TOOLTIP_HORIZONTAL_MARGIN,
  TOOLTIP_VERTICAL_MARGIN,
  type TooltipGeomInsets,
  type TooltipPlacement,
  type TooltipPlacementInput,
} from "./tourTooltipPlacement";

/** iPhone 17 Pro, the device the trap was measured on. */
const PHONE = { width: 402, height: 874 };
const PHONE_INSETS: TooltipGeomInsets = {
  top: 59,
  right: 0,
  bottom: 34,
  left: 0,
};

/**
 * A realistic card: title + two lines of body + dot row + the 44pt action row,
 * inside 18pt padding. Measured off the rendered tooltip.
 */
const CARD_HEIGHT = 232;

function place(
  overrides: Partial<TooltipPlacementInput> = {},
): TooltipPlacement {
  return resolveTooltipPlacement({
    anchor: null,
    viewport: PHONE,
    insets: PHONE_INSETS,
    cardHeight: CARD_HEIGHT,
    ...overrides,
  });
}

/**
 * The whole point of the module: no edge of the card may fall outside the
 * safe area. Asserted on all four edges every time, because the bug this
 * replaces only ever violated one of them at a time.
 */
function expectWithinSafeArea(
  placement: TooltipPlacement,
  viewport: { width: number; height: number },
  insets: TooltipGeomInsets,
): void {
  expect(placement.left).toBeGreaterThanOrEqual(
    insets.left + TOOLTIP_HORIZONTAL_MARGIN,
  );
  expect(placement.left + placement.width).toBeLessThanOrEqual(
    viewport.width - insets.right - TOOLTIP_HORIZONTAL_MARGIN,
  );
  expect(placement.top).toBeGreaterThanOrEqual(
    insets.top + TOOLTIP_VERTICAL_MARGIN,
  );
  expect(placement.top + placement.height).toBeLessThanOrEqual(
    viewport.height - insets.bottom - TOOLTIP_VERTICAL_MARGIN,
  );
}

describe("resolveTooltipPlacement", () => {
  it("flips above an anchor that leaves no room below it", () => {
    // The reproduced trap: step "Your numbers, live" asks for `bottom`
    // against a stats block whose bottom edge sits at y=820 on an 874pt
    // screen. Honouring `bottom` put the heading at y≈854 and both buttons
    // off the bottom of the world.
    const anchor = { x: 16, y: 740, width: 370, height: 80 };
    const placement = place({ anchor, requested: "bottom" });

    expect(placement.side).toBe("top");
    expect(placement.top + placement.height).toBeLessThanOrEqual(anchor.y);
    expectWithinSafeArea(placement, PHONE, PHONE_INSETS);
  });

  it("keeps a bottom-anchored card on a short viewport inside the safe area", () => {
    // A short viewport (split view / small device / a large-text layout) with
    // the anchor near its bottom edge — the general shape of the failure, not
    // the one step that surfaced it.
    const viewport = { width: 320, height: 500 };
    const insets: TooltipGeomInsets = {
      top: 44,
      right: 0,
      bottom: 34,
      left: 0,
    };
    const anchor = { x: 12, y: 400, width: 296, height: 52 };

    const placement = resolveTooltipPlacement({
      anchor,
      requested: "bottom",
      viewport,
      insets,
      cardHeight: 200,
    });

    expect(placement.fits).toBe(true);
    expect(placement.height).toBe(200);
    expectWithinSafeArea(placement, viewport, insets);
  });

  it("clamps a card that fits on neither side rather than hanging it off an edge", () => {
    // Anchor dead centre of a viewport too short for the card on either
    // side. No flip can help; the clamp still has to hold.
    const viewport = { width: 402, height: 420 };
    const anchor = { x: 16, y: 190, width: 370, height: 40 };

    const placement = resolveTooltipPlacement({
      anchor,
      requested: "bottom",
      viewport,
      insets: PHONE_INSETS,
      cardHeight: CARD_HEIGHT,
    });

    expect(placement.fits).toBe(true);
    expectWithinSafeArea(placement, viewport, PHONE_INSETS);
  });

  it("does not push the card off the TOP edge for a high anchor", () => {
    // The mirror of the reported bug. The old "top" branch positioned by
    // `bottom:` so it never knew its own height, and an anchor near the top
    // of the screen walked the card off that edge instead.
    const anchor = { x: 16, y: 100, width: 370, height: 60 };
    const placement = place({ anchor, requested: "top" });

    expect(placement.side).toBe("bottom");
    expectWithinSafeArea(placement, PHONE, PHONE_INSETS);
  });

  it("honours a requested side when the card genuinely fits there", () => {
    const anchor = { x: 16, y: 200, width: 370, height: 80 };
    const below = place({ anchor, requested: "bottom" });
    expect(below.side).toBe("bottom");
    expect(below.top).toBe(anchor.y + anchor.height + 16);

    const highAnchor = { x: 16, y: 600, width: 370, height: 60 };
    const above = place({ anchor: highAnchor, requested: "top" });
    expect(above.side).toBe("top");
    expect(above.top).toBe(highAnchor.y - 16 - CARD_HEIGHT);
  });

  it("auto picks the roomier side when both fit", () => {
    // Preserved tie-break from the original useMemo: `spaceBelow >=
    // spaceAbove ? "bottom" : "top"`.
    const nearTop = place({
      anchor: { x: 16, y: 120, width: 370, height: 40 },
      requested: "auto",
    });
    expect(nearTop.side).toBe("bottom");

    const nearBottom = place({
      anchor: { x: 16, y: 640, width: 370, height: 40 },
      requested: "auto",
    });
    expect(nearBottom.side).toBe("top");
  });

  it("centres welcome/outro steps in the safe band", () => {
    const centered = place({ requested: "center" });
    expect(centered.side).toBe("center");
    expectWithinSafeArea(centered, PHONE, PHONE_INSETS);

    // An unmeasured anchor is centred too, never anchored to a stale rect.
    const unmeasured = place({ anchor: null, requested: "bottom" });
    expect(unmeasured.side).toBe("center");
    expectWithinSafeArea(unmeasured, PHONE, PHONE_INSETS);
  });

  it("reports a card taller than the safe band and pins it to the safe top", () => {
    // Nothing can show all of it; the overlay's dismissible backdrop is the
    // escape hatch. What we refuse to do is start it off-screen.
    const viewport = { width: 402, height: 300 };
    const placement = resolveTooltipPlacement({
      anchor: { x: 16, y: 240, width: 370, height: 40 },
      requested: "bottom",
      viewport,
      insets: PHONE_INSETS,
      cardHeight: 400,
    });

    expect(placement.fits).toBe(false);
    expect(placement.top).toBe(PHONE_INSETS.top + TOOLTIP_VERTICAL_MARGIN);
    expectWithinSafeArea(placement, viewport, PHONE_INSETS);
  });

  it("respects horizontal insets so a landscape notch cannot clip the card", () => {
    const viewport = { width: 874, height: 402 };
    const insets: TooltipGeomInsets = {
      top: 0,
      right: 59,
      bottom: 21,
      left: 59,
    };
    const placement = resolveTooltipPlacement({
      anchor: { x: 100, y: 300, width: 200, height: 60 },
      requested: "bottom",
      viewport,
      insets,
      cardHeight: 200,
    });

    expectWithinSafeArea(placement, viewport, insets);
  });

  it("survives a viewport that has not been measured yet", () => {
    const placement = resolveTooltipPlacement({
      anchor: { x: 0, y: 0, width: 0, height: 0 },
      requested: "bottom",
      viewport: { width: 0, height: 0 },
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
      cardHeight: CARD_HEIGHT,
    });

    expect(placement.width).toBe(0);
    expect(placement.height).toBe(0);
    expect(Number.isFinite(placement.top)).toBe(true);
    expect(Number.isFinite(placement.left)).toBe(true);
  });
});
