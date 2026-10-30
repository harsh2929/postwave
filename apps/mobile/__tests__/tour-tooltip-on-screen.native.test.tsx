/**
 * The tour's card can never be placed off the screen, and there is always a
 * way out of the tour.
 *
 * REPRODUCED ON A DEVICE, not inferred: on a fresh install the second beat
 * ("Your numbers, live" → `dashboard.stats`, `placement: "bottom"`) rendered
 * its heading at y≈854 on an 874pt iPhone 17 Pro. Body copy and both buttons
 * were below the bottom edge, the backdrop swallowed every tap, and the
 * accessibility tree held three elements — none of them a control. The only
 * escape was force-quitting the app.
 *
 * `src/lib/tourTooltipPlacement.test.ts` pins the geometry itself. This file
 * pins the two things that unit test cannot see:
 *
 *   1. the COMPONENT actually feeds the resolver the anchor, the viewport and
 *      its own height — a correct pure function wired up wrong still traps
 *      the user;
 *   2. the scrim is a real, labelled, pressable escape hatch.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import type { EdgeInsets } from "react-native-safe-area-context";

import { TourScrim } from "../src/components/tour/TourScrim";
import { TourTooltip } from "../src/components/tour/TourTooltip";
import type { TourRect, TourStep } from "../src/components/tour/types";

/** iPhone 17 Pro — the device the trap was measured on. */
const VIEWPORT = { x: 0, y: 0, width: 402, height: 874 };
const INSETS: EdgeInsets = { top: 59, right: 0, bottom: 34, left: 0 };
/** Matches TOOLTIP_VERTICAL_MARGIN / TOOLTIP_HORIZONTAL_MARGIN. */
const VERTICAL_MARGIN = 8;
const HORIZONTAL_MARGIN = 16;

/** The dashboard stats block as measured on a loaded dashboard. */
const LOW_ANCHOR: TourRect = { x: 16, y: 740, width: 370, height: 80 };

const STEP: TourStep = {
  id: "dashboard-stats",
  title: "Your numbers, live",
  body: "Live numbers, no refresh needed. Tap any card to drill in.",
  targetId: "dashboard.stats",
  placement: "bottom",
};

async function renderTooltip(rect: TourRect | null = LOW_ANCHOR) {
  return render(
    <TourTooltip
      step={STEP}
      stepIndex={1}
      totalSteps={7}
      rect={rect}
      windowSize={VIEWPORT}
      insets={INSETS}
      reducedMotion
      onNext={jest.fn()}
      onBack={jest.fn()}
      onSkip={jest.fn()}
    />,
  );
}

/** The card's resolved rect, read off the positioned container. */
function cardRect() {
  const node = screen.getByTestId("tour-tooltip-card");
  const style = StyleSheet.flatten(node.props.style) as {
    top: number;
    left: number;
    width: number;
  };
  return style;
}

function expectInsideSafeArea(cardHeight: number) {
  const rect = cardRect();
  expect(rect.top).toBeGreaterThanOrEqual(INSETS.top + VERTICAL_MARGIN);
  expect(rect.top + cardHeight).toBeLessThanOrEqual(
    VIEWPORT.height - INSETS.bottom - VERTICAL_MARGIN,
  );
  expect(rect.left).toBeGreaterThanOrEqual(INSETS.left + HORIZONTAL_MARGIN);
  expect(rect.left + rect.width).toBeLessThanOrEqual(
    VIEWPORT.width - INSETS.right - HORIZONTAL_MARGIN,
  );
}

describe("TourTooltip placement", () => {
  it("keeps the card on screen for an anchor near the bottom edge", async () => {
    await renderTooltip();
    // 260 is the pre-layout estimate the component starts from. Asserting
    // against it — rather than against 0 — is what makes "on screen" mean
    // the whole card and not just its top edge.
    expectInsideSafeArea(260);
  });

  it("re-resolves against its measured height once layout reports one", async () => {
    await renderTooltip();
    fireEvent(screen.getByLabelText(`${STEP.title}. ${STEP.body}`), "layout", {
      nativeEvent: { layout: { x: 0, y: 0, width: 370, height: 232 } },
    });
    expectInsideSafeArea(232);
    // Flipped above the anchor rather than clamped on top of it: there was
    // room up there, which is the whole point of flipping.
    expect(cardRect().top + 232).toBeLessThanOrEqual(LOW_ANCHOR.y);
  });

  it("keeps both controls in the tree while the card is anchored low", async () => {
    await renderTooltip();
    // The device symptom was an accessibility tree of three elements with no
    // control in it. Rendering them is necessary but not sufficient — the
    // rect assertions above are what put them on screen.
    expect(screen.getByLabelText("Next step")).toBeTruthy();
    expect(screen.getByLabelText("Skip tour")).toBeTruthy();
  });

  it("centers a step whose target has not been measured yet", async () => {
    await renderTooltip(null);
    expectInsideSafeArea(260);
  });
});

describe("TourScrim", () => {
  it("dismisses the tour when the backdrop is tapped", async () => {
    const onDismiss = jest.fn();
    await render(<TourScrim onDismiss={onDismiss} />);
    fireEvent.press(screen.getByTestId("tour-scrim"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("offers the escape as a labelled control, not only as a tap target", async () => {
    await render(<TourScrim onDismiss={jest.fn()} />);
    expect(screen.getByRole("button", { name: "Skip tour" })).toBeTruthy();
  });
});
