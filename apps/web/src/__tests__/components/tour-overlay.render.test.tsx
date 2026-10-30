// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The existing tour-overlay.test.ts is explicit that it "reimplements" the
// overlay's math "as a faithful copy" because the component "needs a real DOM
// tree and a running React render". That copy proves the arithmetic and
// nothing about the component: TourOverlay could throw on mount, portal into
// nowhere, or render a tooltip with no buttons, and every assertion there
// would still pass.
//
// This mounts the real thing. Only `useTour` is replaced — building the real
// TourProvider would drag in the router, react-query, telemetry and the
// onboarding API, none of which the OVERLAY's behaviour depends on. The
// context value supplied is the real TourContextValue shape, and the steps are
// real TourStep objects, so the render path exercised is production's.
//
// Falsifiable claims:
//   - it portals to document.body (the container it is rendered into stays
//     empty) — this is what lets the overlay escape a transformed ancestor
//   - it spotlights the resolved [data-tour] target at that node's measured
//     box, padded by 8
//   - the tooltip is a labelled dialog carrying the step's own title/body and
//     a step counter
//   - Next/Back/Skip and the backdrop are wired to the context callbacks, and
//     the LAST step calls complete() rather than next()
//   - Escape skips
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount } from "../pages/_harness";
import type { TourStep } from "@/components/tour/types";

const mocks = vi.hoisted(() => ({
  next: vi.fn(),
  back: vi.fn(),
  skip: vi.fn(),
  skipStep: vi.fn(),
  complete: vi.fn(),
  stepIndex: 0,
}));

const STEPS: TourStep[] = [
  {
    id: "welcome",
    target: "dashboard-nav",
    title: "This is your dashboard",
    body: "Everything you send starts here.",
    placement: "bottom" as const,
  },
  {
    id: "compose",
    target: "compose-button",
    title: "Write your first campaign",
    body: "Compose, preview across clients, then schedule.",
    placement: "bottom" as const,
    skipIfMissing: true,
  },
];

vi.mock("@/components/tour/TourProvider", () => ({
  useTour: () => ({
    state: { tourId: "dashboard", stepIndex: mocks.stepIndex, isOpen: true },
    steps: STEPS,
    start: vi.fn(),
    next: mocks.next,
    skipStep: mocks.skipStep,
    back: mocks.back,
    skip: mocks.skip,
    complete: mocks.complete,
    replay: vi.fn(),
    goTo: vi.fn(),
    hasCompleted: false,
  }),
}));

/** Plant the node the step points at, with a measurable box. */
function plantTarget(name: string, box: DOMRect): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-tour", name);
  el.getBoundingClientRect = () => box;
  el.scrollIntoView = () => undefined;
  document.body.appendChild(el);
  return el;
}

const BOX = {
  top: 120,
  left: 200,
  width: 300,
  height: 48,
  right: 500,
  bottom: 168,
  x: 200,
  y: 120,
  toJSON: () => ({}),
} as DOMRect;

/** The overlay resolves its target on a 60ms timer, then measures. */
async function settle(ms = 200): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

function overlay(): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    '[data-testid="tour-overlay"]',
  );
  if (!el) throw new Error("tour overlay did not portal into document.body");
  return el;
}

function button(name: string): HTMLButtonElement {
  const found = [...overlay().querySelectorAll("button")].find(
    (b) => b.textContent === name || b.getAttribute("aria-label") === name,
  );
  if (!found) throw new Error(`no control named ${name}`);
  return found;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  mocks.stepIndex = 0;
  delete STEPS[1]!.route;
  for (const fn of [
    mocks.next,
    mocks.back,
    mocks.skip,
    mocks.skipStep,
    mocks.complete,
  ]) {
    fn.mockClear();
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
  document.body.innerHTML = "";
});

describe("TourOverlay", () => {
  it("waits for a cold destination route instead of skipping its first explanation", async () => {
    mocks.stepIndex = 1;
    STEPS[1]!.route = "/app/subscribers";
    window.history.replaceState({}, "", "/app/campaigns");
    const { TourOverlay } = await import("@/components/tour/TourOverlay");
    const { root } = await renderPage(TourOverlay);
    try {
      await settle(1650);
      expect(mocks.skipStep).not.toHaveBeenCalled();
      expect(overlay().querySelector("[role='dialog']")).not.toBeNull();
      window.history.replaceState({}, "", "/app/subscribers");
      plantTarget("compose-button", BOX);
      await settle(350);
      expect(
        overlay().querySelector('[data-testid="tour-spotlight"]'),
      ).not.toBeNull();
      expect(mocks.skipStep).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });
  it("portals a spotlight and a labelled tooltip for the current step", async () => {
    plantTarget("dashboard-nav", BOX);
    const { TourOverlay } = await import("@/components/tour/TourOverlay");
    const { container, root } = await renderPage(TourOverlay);
    try {
      await settle();

      // Portalled: the render container itself holds nothing.
      expect(container.textContent).toBe("");

      const dialog = overlay().querySelector("[role='dialog']");
      expect(dialog).not.toBeNull();
      expect(dialog?.getAttribute("aria-modal")).toBe("true");
      // Named by its own title, described by its own body.
      const titleId = dialog?.getAttribute("aria-labelledby");
      const bodyId = dialog?.getAttribute("aria-describedby");
      expect(document.getElementById(titleId ?? "")?.textContent).toBe(
        STEPS[0]!.title,
      );
      expect(document.getElementById(bodyId ?? "")?.textContent).toBe(
        STEPS[0]!.body,
      );
      // The tooltip opens with its 1-indexed step badge.
      expect(dialog?.textContent?.startsWith("1")).toBe(true);
      // One progress dot per step in the tour.
      const dots = [
        ...overlay().querySelectorAll<HTMLElement>("[aria-hidden='true']"),
      ].find((d) => d.tagName === "DIV" && d.children.length > 0);
      expect(dots?.children.length).toBe(STEPS.length);

      // The spotlight sits on the measured target, padded by TARGET_PAD (8).
      const spot = [...overlay().querySelectorAll<HTMLElement>("div")].find(
        (d) => d.style.width === "316px",
      );
      expect(spot).toBeDefined();
      expect(spot!.style.top).toBe("112px");
      expect(spot!.style.left).toBe("192px");
      expect(spot!.style.height).toBe("64px");

      // Tint and backdrop blur share the actual rounded cutout. A ring above
      // a full-screen blur used to leave the entire highlighted area blurred.
      const backdrop = overlay().querySelector<HTMLElement>(
        '[data-testid="tour-backdrop"]',
      );
      expect(backdrop?.style.clipPath).toMatch(/^path\(evenodd,/);
      expect(backdrop?.style.clipPath).toContain(
        `H ${window.innerWidth} V ${window.innerHeight}`,
      );
      expect(backdrop?.style.clipPath).toContain("M 204 112 H 496");

      // The target may stay put while the viewport grows. The outer glass
      // must still cover the full viewport after resize.
      vi.stubGlobal("innerWidth", 1400);
      await act(async () => window.dispatchEvent(new Event("resize")));
      await settle(100);
      expect(backdrop?.style.clipPath).toContain("H 1400 V 768");
    } finally {
      unmount(root);
    }
  });

  it("wires Next / Skip / backdrop to the tour context", async () => {
    plantTarget("dashboard-nav", BOX);
    const { TourOverlay } = await import("@/components/tour/TourOverlay");
    const { root } = await renderPage(TourOverlay);
    try {
      await settle();

      // Not the last step, so the primary advances rather than completing.
      await click(button("Next"));
      expect(mocks.next).toHaveBeenCalledTimes(1);
      expect(mocks.complete).not.toHaveBeenCalled();

      await click(button("Skip tour"));
      expect(mocks.skip).toHaveBeenCalledTimes(1);

      // The backdrop dismisses too — a click-outside that did nothing would
      // trap the user behind a modal scrim.
      const backdrop = overlay().querySelector<HTMLElement>(
        "[role='presentation']",
      );
      expect(backdrop).not.toBeNull();
      await click(backdrop!);
      expect(mocks.skip).toHaveBeenCalledTimes(2);
    } finally {
      unmount(root);
    }
  });

  it("completes instead of advancing on the last step, and offers Back", async () => {
    mocks.stepIndex = 1;
    plantTarget("compose-button", BOX);
    const { TourOverlay } = await import("@/components/tour/TourOverlay");
    const { root } = await renderPage(TourOverlay);
    try {
      await settle();

      expect(overlay().textContent).toContain(STEPS[1]!.title);
      // …badged as step 2, not step 1.
      expect(
        overlay()
          .querySelector("[role='dialog']")
          ?.textContent?.startsWith("2"),
      ).toBe(true);
      // Last step: the primary is "Got it" and it finishes the tour.
      await click(button("Got it"));
      expect(mocks.complete).toHaveBeenCalledTimes(1);
      expect(mocks.next).not.toHaveBeenCalled();

      // Back is offered once past the first step.
      await click(button("Back"));
      expect(mocks.back).toHaveBeenCalledTimes(1);
    } finally {
      unmount(root);
    }
  });

  it("skips the tour on Escape", async () => {
    plantTarget("dashboard-nav", BOX);
    const { TourOverlay } = await import("@/components/tour/TourOverlay");
    const { root } = await renderPage(TourOverlay);
    try {
      await settle();
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(mocks.skip).toHaveBeenCalledTimes(1);
    } finally {
      unmount(root);
    }
  });

  it("does not double-advance when Enter activates the focused primary button", async () => {
    plantTarget("dashboard-nav", BOX);
    const { TourOverlay } = await import("@/components/tour/TourOverlay");
    const { root } = await renderPage(TourOverlay);
    try {
      await settle();
      const next = button("Next");

      // Enter is already a native button activation key. A second global Enter
      // shortcut used to call next() on keydown and then let the button's click
      // call it again.
      next.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(mocks.next).not.toHaveBeenCalled();

      await click(next);
      expect(mocks.next).toHaveBeenCalledTimes(1);
    } finally {
      unmount(root);
    }
  });

  it("keeps the focused dialog usable while an anchor is replaced", async () => {
    const first = plantTarget("dashboard-nav", BOX);
    const { TourOverlay } = await import("@/components/tour/TourOverlay");
    const { root } = await renderPage(TourOverlay);
    try {
      await settle();
      expect(document.activeElement).toBe(button("Next"));

      first.remove();
      await settle(350);
      expect(overlay().querySelector("[role='dialog']")).not.toBeNull();
      expect(document.activeElement).toBe(button("Next"));
      expect(
        [...overlay().querySelectorAll<HTMLElement>("div")].some(
          (element) => element.style.width === "316px",
        ),
      ).toBe(false);
      expect(
        overlay().querySelector<HTMLElement>('[data-testid="tour-backdrop"]')
          ?.style.clipPath,
      ).toBe("");

      const replacementBox = {
        ...BOX,
        top: 260,
        left: 40,
        right: 340,
        bottom: 308,
      } as DOMRect;
      plantTarget("dashboard-nav", replacementBox);
      await settle(350);

      const replacementSpotlight = [
        ...overlay().querySelectorAll<HTMLElement>("div"),
      ].find((element) => element.style.width === "316px");
      expect(replacementSpotlight?.style.top).toBe("252px");
      expect(replacementSpotlight?.style.left).toBe("32px");
      expect(
        overlay().querySelector<HTMLElement>('[data-testid="tour-backdrop"]')
          ?.style.clipPath,
      ).toContain("M 44 252 H 336");
      expect(mocks.skipStep).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });

  it("uses instant scrolling when reduced motion is requested", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        media: "(prefers-reduced-motion: reduce)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    const target = plantTarget("dashboard-nav", BOX);
    const scrollIntoView = vi.fn();
    target.scrollIntoView = scrollIntoView;
    const { TourOverlay } = await import("@/components/tour/TourOverlay");
    const { root } = await renderPage(TourOverlay);
    try {
      await settle();
      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: "auto",
        block: "center",
      });
    } finally {
      unmount(root);
    }
  });

  it("skips a persistently missing optional target exactly once", async () => {
    mocks.stepIndex = 1;
    const { TourOverlay } = await import("@/components/tour/TourOverlay");
    const { root } = await renderPage(TourOverlay);
    try {
      await settle(1_650);
      expect(mocks.skipStep).toHaveBeenCalledTimes(1);
      await settle(500);
      expect(mocks.skipStep).toHaveBeenCalledTimes(1);
    } finally {
      unmount(root);
    }
  });

  it("renders centred with no spotlight when the target never appears", async () => {
    // Nothing planted: after ~1.2s of retries the overlay must still show the
    // tooltip rather than leaving the user staring at a bare scrim.
    const { TourOverlay } = await import("@/components/tour/TourOverlay");
    const { root } = await renderPage(TourOverlay);
    try {
      await settle(1600);
      expect(overlay().querySelector("[role='dialog']")).not.toBeNull();
      expect(overlay().textContent).toContain(STEPS[0]!.title);
      expect(mocks.skipStep).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });
});
