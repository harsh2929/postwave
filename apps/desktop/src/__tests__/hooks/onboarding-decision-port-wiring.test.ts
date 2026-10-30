// @vitest-environment happy-dom
//
// The desktop decision port was declared, documented, and unit-tested against
// a FAKE — and never constructed against the real transport. Every test in
// src/__tests__/lib/onboarding-cross-device-decisions.test.ts passed while
// `getOnboardingStateController` built a controller with no `decisions` option
// at all, so in the shipping app a dismissal still lived only in this device's
// localStorage: dismiss the setup checklist on desktop, open the web app, and
// it was back; dismiss it there, pick up the phone, and it was back again.
//
// These tests bind the port to the REAL construction site, so a controller
// built without a decision port fails here rather than shipping.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHECKLIST_DECISION_STEP_KEY,
  TOUR_DECISION_STEP_KEY,
} from "@postwave/onboarding-schema";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  set: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  onboardingDecisionsApi: { list: mocks.list, set: mocks.set },
}));

const {
  getOnboardingStateController,
  hydrateOnboardingDecisions,
  resetOnboardingStateForTests,
} = await import("../../hooks/useOnboardingState");

const identity = {
  workspaceId: "ws-decisions",
  userId: "user-decisions",
  role: "admin",
} as const;

beforeEach(() => {
  resetOnboardingStateForTests();
  window.localStorage.clear();
  mocks.list.mockReset().mockResolvedValue({ data: { steps: {} } });
  mocks.set.mockReset().mockResolvedValue({ data: { ok: true } });
});

afterEach(() => {
  resetOnboardingStateForTests();
  window.localStorage.clear();
});

describe("the shipping controller carries a decision port", () => {
  it("records a checklist dismissal for the person, not the device", async () => {
    const controller = getOnboardingStateController(identity);

    controller.dispatch({
      type: "dismiss-surface",
      surface: "checklist",
      now: Date.now(),
    });
    await Promise.resolve();

    expect(mocks.set).toHaveBeenCalledWith(
      CHECKLIST_DECISION_STEP_KEY,
      "dismissed",
    );
  });

  it("still dismisses locally when the server refuses", async () => {
    // A preference is not a mutation anyone is waiting on; a failed PUT must
    // not refuse the dismissal the user just asked for.
    mocks.set.mockResolvedValue({ error: { message: "offline" } });
    const controller = getOnboardingStateController(identity);

    controller.dispatch({
      type: "dismiss-surface",
      surface: "checklist",
      now: Date.now(),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.getSnapshot().surfaces.checklist?.outcome).toBe(
      "dismissed",
    );
  });
});

describe("decisions made on another device arrive here", () => {
  it("applies a dismissal recorded elsewhere", async () => {
    const controller = getOnboardingStateController(identity);
    expect(controller.getSnapshot().surfaces.checklist?.outcome).not.toBe(
      "dismissed",
    );
    mocks.list.mockResolvedValue({
      data: { steps: { [CHECKLIST_DECISION_STEP_KEY]: { state: "dismissed" } } },
    });

    await hydrateOnboardingDecisions(controller);

    expect(controller.getSnapshot().surfaces.checklist?.outcome).toBe(
      "dismissed",
    );
  });

  it("honours 'not applicable to us', not only 'dismissed'", async () => {
    // `inapplicable` is in the server's closed vocabulary and means the step
    // is impossible for this account. A client that understood only
    // `dismissed` went on asking for it forever.
    const controller = getOnboardingStateController(identity);
    mocks.list.mockResolvedValue({
      data: {
        steps: { [CHECKLIST_DECISION_STEP_KEY]: { state: "inapplicable" } },
      },
    });

    await hydrateOnboardingDecisions(controller);

    expect(controller.getSnapshot().surfaces.checklist?.outcome).toBe("skipped");
  });

  it("treats a snooze as 'show me again', not as a dismissal", async () => {
    const controller = getOnboardingStateController(identity);
    mocks.list.mockResolvedValue({
      data: { steps: { [CHECKLIST_DECISION_STEP_KEY]: { state: "snoozed" } } },
    });

    await hydrateOnboardingDecisions(controller);

    expect(controller.getSnapshot().surfaces.checklist?.outcome).not.toBe(
      "dismissed",
    );
  });

  it("shares one request across the surfaces that mount together", async () => {
    // The checklist, the wizard and useOnboardingProgress all consume this
    // hook, so a dashboard mount would otherwise fire three identical GETs.
    const controller = getOnboardingStateController(identity);

    await Promise.all([
      hydrateOnboardingDecisions(controller),
      hydrateOnboardingDecisions(controller),
      hydrateOnboardingDecisions(controller),
    ]);

    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("leaves local state usable when the fetch fails", async () => {
    mocks.list.mockResolvedValue({ error: { message: "network" } });
    const controller = getOnboardingStateController(identity);

    await expect(hydrateOnboardingDecisions(controller)).resolves.toBeUndefined();
    expect(controller.getSnapshot().surfaces.checklist?.outcome).not.toBe(
      "dismissed",
    );
  });
});

describe("the tour travels on the same wire as the checklist", () => {
  // The tour was the last surface whose answer stopped at the device: all three
  // clients kept their own `postwave_tour_dashboard_dismissed_at`, so a person
  // dismissed the tour on the laptop, opened the phone, and it ran again.

  it("records a tour dismissal for the person, not the device", async () => {
    const controller = getOnboardingStateController(identity);

    controller.dispatch({
      type: "dismiss-surface",
      surface: "tour",
      now: Date.now(),
    });
    await Promise.resolve();

    expect(mocks.set).toHaveBeenCalledWith(TOUR_DECISION_STEP_KEY, "dismissed");
  });

  it("applies a tour dismissal recorded elsewhere", async () => {
    const controller = getOnboardingStateController(identity);
    expect(controller.getSnapshot().surfaces.tour?.outcome).toBe("not-started");
    mocks.list.mockResolvedValue({
      data: { steps: { [TOUR_DECISION_STEP_KEY]: { state: "dismissed" } } },
    });

    await hydrateOnboardingDecisions(controller);

    expect(controller.getSnapshot().surfaces.tour?.outcome).toBe("dismissed");
  });

  it("reports the decision as unsettled until the request resolves", async () => {
    // The signal the tour's anti-flash gate reads. It has to be observably
    // FALSE while the request is in flight, or the gate is decorative and the
    // tour opens over an answer that has not arrived yet.
    let resolveList: (value: unknown) => void = () => undefined;
    mocks.list.mockReturnValue(
      new Promise((resolve) => {
        resolveList = resolve;
      }),
    );
    const controller = getOnboardingStateController(identity);

    const hydration = hydrateOnboardingDecisions(controller);
    expect(controller.getDecisionsSettled()).toBe(false);

    resolveList({ data: { steps: {} } });
    await hydration;

    expect(controller.getDecisionsSettled()).toBe(true);
  });

  it("settles the gate even when the request fails", async () => {
    // Otherwise an offline window suppresses the tour forever rather than
    // falling back to the local cache.
    mocks.list.mockResolvedValue({ error: { message: "network" } });
    const controller = getOnboardingStateController(identity);

    await hydrateOnboardingDecisions(controller);

    expect(controller.getDecisionsSettled()).toBe(true);
  });

  it("sends up a dismissal this device has been holding alone", async () => {
    // Someone who dismissed the tour before this shipped has a real decision in
    // local storage and nowhere else. Their other devices must stop asking.
    const controller = getOnboardingStateController(identity);
    controller.dispatch({
      type: "dismiss-surface",
      surface: "tour",
      now: Date.now(),
    });
    mocks.set.mockClear();
    mocks.list.mockResolvedValue({ data: { steps: {} } });

    await hydrateOnboardingDecisions(controller);

    expect(mocks.set).toHaveBeenCalledWith(TOUR_DECISION_STEP_KEY, "dismissed");
  });
});
