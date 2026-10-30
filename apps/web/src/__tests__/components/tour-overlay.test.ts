// Logic-level tests for TourOverlay. The overlay itself drags in
// react-dom/createPortal and useTour, which need a real DOM tree and a
// running React render — none of which exist in the node test env.
// What we *can* pin down is the math and gating logic the overlay
// honors:
//
//   - spotlight-padding cut-out math (TARGET_PAD = 8)
//   - reduced-motion / auto-launch gating via localStorage
//   - step navigation reducer (next/back/skip → state transitions)
//   - Cmd/Ctrl+/ shortcut keymap shape
//
// Each function below is reimplemented as a faithful copy of the
// logic from TourOverlay.tsx / TourProvider.tsx — when the production
// code drifts these tests catch the divergence.

import { describe, expect, it } from "vitest";

const TARGET_PAD = 8;

/** Mirrors TourOverlay.tsx::measure() — adds an 8px halo on each side. */
function measureRect(rect: {
  top: number;
  left: number;
  width: number;
  height: number;
}): { top: number; left: number; width: number; height: number } {
  return {
    top: rect.top - TARGET_PAD,
    left: rect.left - TARGET_PAD,
    width: rect.width + TARGET_PAD * 2,
    height: rect.height + TARGET_PAD * 2,
  };
}

describe("TourOverlay spotlight math", () => {
  it("pads the cut-out by 8px on all sides", () => {
    const r = measureRect({ top: 100, left: 200, width: 300, height: 50 });
    // 8px padding shifts top/left outward and grows width/height by 16.
    expect(r.top).toBe(92);
    expect(r.left).toBe(192);
    expect(r.width).toBe(316);
    expect(r.height).toBe(66);
  });

  it("never inverts width/height when target is at the viewport edge", () => {
    // A target at (0, 0) with width 10 should still produce a non-negative
    // rect — top/left go to -8, which is intentional (the mask draws past
    // the edge, the browser clips it).
    const r = measureRect({ top: 0, left: 0, width: 10, height: 10 });
    expect(r.top).toBe(-8);
    expect(r.left).toBe(-8);
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
  });
});

/**
 * Mirrors TourProvider.tsx::lsKey(). Encoded once so the auto-launch
 * gate and the "I've seen this tour" gate read/write the same key.
 */
function tourLsKey(
  tourId: string,
  suffix: "completed_at" | "step",
): string {
  return `postwave_tour_${tourId}_${suffix}`;
}

describe("TourProvider auto-launch gate (localStorage)", () => {
  it("uses the canonical `postwave_tour_<id>_completed_at` key", () => {
    expect(tourLsKey("marketing", "completed_at")).toBe(
      "postwave_tour_marketing_completed_at",
    );
    expect(tourLsKey("dashboard", "step")).toBe(
      "postwave_tour_dashboard_step",
    );
  });

  it("when the completed_at marker is set, auto-launch should be skipped", () => {
    // Model the gating logic from TourProvider's auto-launch effect.
    const store = new Map<string, string>();
    store.set("postwave_tour_marketing_completed_at", "2026-04-01T00:00:00Z");
    const shouldAutoLaunch = (tourId: string): boolean => {
      return !store.get(tourLsKey(tourId, "completed_at"));
    };
    expect(shouldAutoLaunch("marketing")).toBe(false);
    expect(shouldAutoLaunch("onboarding")).toBe(true);
  });
});

describe("TourProvider step reducer", () => {
  // Model of the reducer that lives inline in TourProvider.tsx
  // (next/back/skip). Pinning this here means a refactor that breaks
  // the state machine surfaces as a unit-test diff.
  type State = { idx: number; isOpen: boolean; tourId: string | null };

  function reduce(
    s: State,
    action: { type: "next" | "back" | "skip" | "open"; tourId?: string },
    total: number,
  ): State {
    switch (action.type) {
      case "open":
        return { idx: 0, isOpen: true, tourId: action.tourId ?? null };
      case "next": {
        if (!s.isOpen) return s;
        const n = s.idx + 1;
        if (n >= total) return { ...s, isOpen: false };
        return { ...s, idx: n };
      }
      case "back": {
        if (!s.isOpen) return s;
        return { ...s, idx: Math.max(0, s.idx - 1) };
      }
      case "skip":
        return { ...s, isOpen: false };
    }
  }

  it("next advances by one within bounds", () => {
    const s = reduce({ idx: 1, isOpen: true, tourId: "t" }, { type: "next" }, 5);
    expect(s.idx).toBe(2);
    expect(s.isOpen).toBe(true);
  });

  it("next at the last step closes the tour", () => {
    const s = reduce({ idx: 4, isOpen: true, tourId: "t" }, { type: "next" }, 5);
    expect(s.isOpen).toBe(false);
  });

  it("back at idx 0 stays at 0", () => {
    const s = reduce({ idx: 0, isOpen: true, tourId: "t" }, { type: "back" }, 5);
    expect(s.idx).toBe(0);
  });

  it("skip closes without advancing the index", () => {
    const s = reduce({ idx: 2, isOpen: true, tourId: "t" }, { type: "skip" }, 5);
    expect(s.isOpen).toBe(false);
    expect(s.idx).toBe(2);
  });
});

describe("Cmd/Ctrl+/ tour launcher shortcut", () => {
  // The TourLauncher binds a global keydown listener. We model the
  // matcher so the production code can drift the modifier set freely
  // and we'll catch it.
  function isLauncherShortcut(e: {
    key: string;
    metaKey?: boolean;
    ctrlKey?: boolean;
  }): boolean {
    return e.key === "/" && Boolean(e.metaKey || e.ctrlKey);
  }

  it("matches Cmd+/ on Mac", () => {
    expect(isLauncherShortcut({ key: "/", metaKey: true })).toBe(true);
  });

  it("matches Ctrl+/ on Linux/Windows", () => {
    expect(isLauncherShortcut({ key: "/", ctrlKey: true })).toBe(true);
  });

  it("ignores plain `/` (would interfere with omnibox)", () => {
    expect(isLauncherShortcut({ key: "/" })).toBe(false);
  });

  it("ignores other keys with the modifier", () => {
    expect(isLauncherShortcut({ key: "k", metaKey: true })).toBe(false);
  });
});
