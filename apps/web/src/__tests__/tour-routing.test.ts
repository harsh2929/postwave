import { describe, expect, it } from "vitest";

import {
  clampTourStartIndex,
  shouldAutoStartTour,
  tourNeedsAuthenticatedProgress,
} from "@/components/tour/tour-routing";

describe("tour route and authentication gates", () => {
  it("only auto-starts on the tour's declared start page", () => {
    expect(shouldAutoStartTour("/", "/")).toBe(true);
    expect(shouldAutoStartTour("/pricing", "/")).toBe(false);
    expect(shouldAutoStartTour("/app/campaigns", "/app")).toBe(false);
  });

  it("clamps resumed steps to the freshly adapted tour length", () => {
    expect(clampTourStartIndex(8, 3)).toBe(2);
    expect(clampTourStartIndex(-4, 3)).toBe(0);
    expect(clampTourStartIndex(Number.NaN, 3)).toBe(0);
    expect(clampTourStartIndex(0, 0)).toBeNull();
  });

  it("never loads authenticated onboarding progress for marketing tours", () => {
    expect(tourNeedsAuthenticatedProgress("marketing")).toBe(false);
    expect(tourNeedsAuthenticatedProgress("dashboard")).toBe(true);
  });
});
