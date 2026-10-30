// Tests the marketing tour configuration. The tour engine is React-
// coupled (TourProvider + DOM measurements), but the canonical step
// list is a plain export — guarding it against accidental edits is a
// useful invariant: empty bodies, duplicate ids, or a missing CTA
// step would silently regress the tour without breaking any other
// surface.

import { describe, expect, it } from "vitest";

import { marketingTour } from "@/components/tour/tours/marketing";

describe("marketingTour", () => {
  it("has at least 4 steps", () => {
    expect(marketingTour.steps.length).toBeGreaterThanOrEqual(4);
  });

  it("starts on /", () => {
    expect(marketingTour.startsOn).toBe("/");
  });

  it("ends with a celebrate step (the CTA)", () => {
    const last = marketingTour.steps[marketingTour.steps.length - 1];
    expect(last.celebrate).toBe(true);
  });

  it("ids are unique", () => {
    const ids = marketingTour.steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every step has a non-empty title and body", () => {
    for (const step of marketingTour.steps) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.body.length).toBeGreaterThan(0);
    }
  });

  it("does not promise timed migrations or unconditional automation translation", () => {
    const copy = marketingTour.steps
      .map((step) => `${step.title}\n${step.body}`)
      .join("\n");

    expect(copy).toContain("Move with proof.");
    expect(copy).toContain("Automations translate only where safe");
    expect(copy).toContain("preserves rebuild evidence");
    expect(copy).not.toContain("20 minutes");
    expect(copy).not.toContain("Even your automations get translated");
  });
});
