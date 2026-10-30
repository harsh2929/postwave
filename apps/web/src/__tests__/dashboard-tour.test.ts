// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import { adaptiveSteps } from "@postwave/onboarding-schema";

import { dashboardTour } from "@/components/tour/tours/dashboard";

describe("dashboard tour route-independent finish", () => {
  it("keeps an actionable final card when adaptive progress removes Settings navigation", () => {
    const steps = adaptiveSteps(
      dashboardTour.steps,
      (goal) => goal === "verified_sending_identity",
    );
    const finish = steps.at(-1);

    expect(steps.map((step) => step.id)).not.toContain("to-settings");
    expect(finish).toMatchObject({
      id: "finish",
      placement: "center",
      primaryLabel: "Finish",
      celebrate: true,
    });
    expect(finish?.target).toBeUndefined();
    expect(finish?.skipIfMissing).not.toBe(true);
  });

  it("filters a route-only dependent spotlight with its adaptive navigation step", () => {
    const steps = adaptiveSteps(
      dashboardTour.steps,
      (goal) => goal === "created_subscriber",
    );

    expect(steps.map((step) => step.id)).not.toContain("to-subscribers");
    expect(steps.map((step) => step.id)).not.toContain("segments");
    expect(steps.map((step) => step.id)).not.toContain("subscriber-directory");
    expect(steps.map((step) => step.id)).not.toContain("saved-segments");
  });

  it("has substantive destination scenes after each core navigation action", () => {
    for (const [id, route] of [
      ["campaign-library", "/app/campaigns"],
      ["subscriber-directory", "/app/subscribers"],
      ["saved-segments", "/app/subscribers/segments"],
      ["sequence-drafts", "/app/sequences"],
      ["analytics-overview", "/app/analytics"],
      ["workspace-settings", "/app/settings"],
    ]) {
      const step = dashboardTour.steps.find((step) => step.id === id);
      expect(step?.route).toBe(route);
      expect(step?.target).toBeTruthy();
      expect(step?.skipIfMissing).not.toBe(true);
    }
  });
});
