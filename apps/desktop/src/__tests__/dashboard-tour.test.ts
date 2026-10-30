// Validates the dashboardTour configuration. The tour engine lives in
// TourProvider but the canonical step list is a plain export — we
// guard against accidental edits that break the state machine
// invariants (first step has hideBack, last step has isFinal, every
// step has a unique id, etc.).

import { describe, expect, it } from "vitest";

import { DASHBOARD_TOUR_STEPS } from "../components/tour/dashboardTour";
import {
  FULL_WORKSPACE_TOUR_SECTIONS,
  FULL_WORKSPACE_TOUR_STEPS,
  WORKSPACE_TOUR_COPY,
} from "../components/tour/workspaceTour";
import { PERSISTENT_DESKTOP_SECTIONS } from "../lib/desktop-routes";
import { isKnownOnboardingStep } from "../lib/onboarding-manifest";

describe("DASHBOARD_TOUR_STEPS", () => {
  it("has at least 5 steps so the tour feels substantial", () => {
    expect(DASHBOARD_TOUR_STEPS.length).toBeGreaterThanOrEqual(5);
  });

  it("starts with hideBack so the user can't navigate before step 0", () => {
    expect(DASHBOARD_TOUR_STEPS[0].hideBack).toBe(true);
  });

  it("ends with isFinal so the engine knows to flip to completed", () => {
    const last = DASHBOARD_TOUR_STEPS[DASHBOARD_TOUR_STEPS.length - 1];
    expect(last.isFinal).toBe(true);
  });

  it("has only one final step", () => {
    const finals = DASHBOARD_TOUR_STEPS.filter((s) => s.isFinal);
    expect(finals.length).toBe(1);
  });

  it("ids are unique", () => {
    const ids = DASHBOARD_TOUR_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every step has a non-empty title and body", () => {
    for (const step of DASHBOARD_TOUR_STEPS) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.body.length).toBeGreaterThan(0);
    }
  });

  it("steps with a target also declare a navigateTo section", () => {
    for (const step of DASHBOARD_TOUR_STEPS) {
      if (step.targetSelector !== null) {
        expect(step.navigateTo).toBeTruthy();
      }
    }
  });
});

describe("FULL_WORKSPACE_TOUR_STEPS", () => {
  it("covers every persistent sidebar destination exactly once", () => {
    expect(new Set(FULL_WORKSPACE_TOUR_SECTIONS)).toEqual(
      new Set(PERSISTENT_DESKTOP_SECTIONS),
    );
    expect(FULL_WORKSPACE_TOUR_SECTIONS).toHaveLength(
      PERSISTENT_DESKTOP_SECTIONS.length,
    );
  });

  it("keeps a complete, human-written introduction for every destination", () => {
    for (const section of PERSISTENT_DESKTOP_SECTIONS) {
      const copy = WORKSPACE_TOUR_COPY[section];
      expect(copy.title.length).toBeGreaterThan(8);
      expect(copy.body.length).toBeGreaterThan(80);
      expect(copy.body).not.toMatch(
        /\b(?:leverage AI|AI-powered|seamlessly)\b/i,
      );
    }
  });

  it("describes Helpdesk as internal recorded work while delivery is held", () => {
    const copy = WORKSPACE_TOUR_COPY.helpdesk;
    expect(copy.body).toContain("private internal notes");
    expect(copy.body).toContain("reply delivery");
    expect(copy.body).toContain("release-held");
    expect(copy.body).not.toMatch(/\breply,|close the loop/iu);
  });

  it("describes push registry truth without a provider-setup gate", () => {
    const copy = WORKSPACE_TOUR_COPY.pushSuppressions;
    expect(copy.body).toContain("Customer push dispatch is held");
    expect(copy.body).toContain("suppression-gated");
    expect(copy.body).toContain("Web remains registry-only");
    expect(copy.body).not.toMatch(/provider availability controls/iu);
  });

  it("describes retention as bounded stored evidence, not a customer outcome", () => {
    const copy = WORKSPACE_TOUR_COPY.retentionOffers;
    expect(copy.body).toContain("bounded stored offer rows");
    expect(copy.body).toContain("stored win-back settings");
    expect(copy.body).toContain("aggregate event counters");
    expect(copy.body).toContain("release-held");
    expect(`${copy.title} ${copy.body}`).not.toMatch(
      /helped a customer stay|offers and interventions shown|review the customer|learn what works/iu,
    );
  });

  it("keeps affiliate and discount introductions inside their qualified boundaries", () => {
    const affiliates = WORKSPACE_TOUR_COPY.affiliates;
    expect(affiliates.body).toContain("without loading partner records");
    expect(affiliates.body).toContain("remain unavailable");
    expect(affiliates.body).not.toMatch(
      /follow partner attribution|referred customers|commission outcomes/iu,
    );

    const discounts = WORKSPACE_TOUR_COPY.discounts;
    expect(discounts.body).toContain("without exposing coupon codes or customer identity");
    expect(discounts.body).toContain("record label, benefit, currency, or scope");
    expect(discounts.body).not.toMatch(/search by customer or code/iu);
  });

  it("opens and highlights the matching page for each workspace stop", () => {
    for (const section of PERSISTENT_DESKTOP_SECTIONS) {
      const step = FULL_WORKSPACE_TOUR_STEPS.find(
        (candidate) => candidate.id === `workspace-${section}`,
      );
      expect(step?.navigateTo).toBe(section);
      expect(step?.targetSelector).toBe(`nav-${section}`);
    }
  });

  it("has a safe introduction and a single final step", () => {
    expect(FULL_WORKSPACE_TOUR_STEPS[0]).toMatchObject({
      id: "workspace-welcome",
      hideBack: true,
      targetSelector: null,
    });
    const finals = FULL_WORKSPACE_TOUR_STEPS.filter((step) => step.isFinal);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.id).toBe("workspace-done");
  });

  it("is accepted end to end by the persisted onboarding state machine", () => {
    for (const step of FULL_WORKSPACE_TOUR_STEPS) {
      expect(isKnownOnboardingStep("tour", step.id)).toBe(true);
    }
  });
});

// The state machine tests below model `next/back/complete` over the
// step indices since the actual TourProvider is React-coupled and
// can't be unit-tested without DOM. The shape here mirrors the
// reducer that lives inline in TourProvider.
function reduce(
  state: { idx: number; status: "open" | "closed" | "complete" },
  action:
    | { type: "start" }
    | { type: "next" }
    | { type: "back" }
    | { type: "complete" }
    | { type: "skip" },
): typeof state {
  const total = DASHBOARD_TOUR_STEPS.length;
  switch (action.type) {
    case "start":
      return { idx: 0, status: "open" };
    case "next": {
      if (state.status !== "open") return state;
      const next = state.idx + 1;
      if (next >= total) return { idx: total - 1, status: "complete" };
      return { ...state, idx: next };
    }
    case "back": {
      if (state.status !== "open") return state;
      return { ...state, idx: Math.max(0, state.idx - 1) };
    }
    case "complete":
      return { idx: total - 1, status: "complete" };
    case "skip":
      return { idx: 0, status: "closed" };
  }
}

describe("tour state machine (modeled)", () => {
  it("starts at idx 0", () => {
    const s = reduce({ idx: -1, status: "closed" }, { type: "start" });
    expect(s.idx).toBe(0);
    expect(s.status).toBe("open");
  });

  it("next advances by one", () => {
    let s = reduce({ idx: -1, status: "closed" }, { type: "start" });
    s = reduce(s, { type: "next" });
    expect(s.idx).toBe(1);
  });

  it("next from the last step transitions to complete", () => {
    const last = DASHBOARD_TOUR_STEPS.length - 1;
    const s0: { idx: number; status: "open" | "closed" | "complete" } = {
      idx: last,
      status: "open",
    };
    const s = reduce(s0, { type: "next" });
    expect(s.status).toBe("complete");
  });

  it("back at idx 0 stays at idx 0", () => {
    const s = reduce({ idx: 0, status: "open" }, { type: "back" });
    expect(s.idx).toBe(0);
  });

  it("skip closes without completing", () => {
    const s = reduce({ idx: 3, status: "open" }, { type: "skip" });
    expect(s.status).toBe("closed");
  });
});
