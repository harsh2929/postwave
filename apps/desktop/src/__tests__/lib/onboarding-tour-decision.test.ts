import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ONBOARDING_DECISION_STATES,
  TOUR_DECISION_STEP_KEY,
  decisionHidesSurface,
} from "@postwave/onboarding-schema";

import {
  OnboardingStateController,
  type OnboardingDecisionPort,
} from "../../lib/onboarding-state-controller";

/**
 * The dashboard tour was the last onboarding answer a device kept to itself.
 *
 * All three clients stored `postwave_tour_dashboard_dismissed_at` locally, so a
 * person dismissed the tour on their laptop, opened the phone, and it ran
 * again. The checklist stopped doing this when its decision moved to
 * `GET/PUT /api/v1/onboarding/steps`; the tour kept doing it, once per device,
 * forever. These tests hold the tour to the SAME mechanism — the same
 * controller, the same port, the same closed vocabulary — rather than a second
 * one that would drift from it.
 */

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
}

const identity = {
  workspaceId: "ws-1",
  userId: "user-1",
  role: "admin",
} as const;

let port: OnboardingDecisionPort & { set: ReturnType<typeof vi.fn> };

function controllerWith(storage: Storage = memoryStorage()) {
  return new OnboardingStateController({ storage, identity, decisions: port });
}

beforeEach(() => {
  port = {
    list: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(undefined),
  };
});

describe("a tour decision made elsewhere is honoured here", () => {
  it("hides the tour on a device that never saw the dismissal", () => {
    const controller = controllerWith();
    // The pre-state matters: without it this assertion could pass on a device
    // that simply never shows the tour.
    expect(controller.getSnapshot().surfaces.tour.outcome).toBe("not-started");

    const changed = controller.syncFromRemote({
      [TOUR_DECISION_STEP_KEY]: "dismissed",
    });

    expect(changed).toBe(true);
    expect(controller.getSnapshot().surfaces.tour.outcome).toBe("dismissed");
  });

  it.each(ONBOARDING_DECISION_STATES)(
    "agrees with the shared contract about '%s'",
    (state) => {
      const controller = controllerWith();
      controller.syncFromRemote({ [TOUR_DECISION_STEP_KEY]: state });
      const outcome = controller.getSnapshot().surfaces.tour.outcome;
      const hiddenHere = outcome === "dismissed" || outcome === "skipped";
      expect(hiddenHere).toBe(decisionHidesSurface(state));
    },
  );

  it("does not re-ask a question the server has simply never heard", () => {
    // An ABSENT row means "never decided", not "restore me". This is the path
    // every pre-existing local dismissal takes on its first hydration.
    const storage = memoryStorage();
    const controller = controllerWith(storage);
    controller.dispatch({
      type: "dismiss-surface",
      surface: "tour",
      now: Date.now(),
    });

    expect(controller.syncFromRemote({})).toBe(false);
    expect(controller.getSnapshot().surfaces.tour.outcome).toBe("dismissed");
  });

  it("leaves a finished tour finished rather than rewriting it as thrown away", () => {
    // Completion is published as `dismissed` (the wire has no "completed"), so
    // the row this device wrote comes straight back on the next hydration.
    // Applying it would churn storage and quietly restate "you finished the
    // tour" as "you threw the tour away".
    const controller = controllerWith();
    controller.dispatch({
      type: "complete-surface",
      surface: "tour",
      now: Date.now(),
    });

    const changed = controller.syncFromRemote({
      [TOUR_DECISION_STEP_KEY]: "dismissed",
    });

    expect(changed).toBe(false);
    expect(controller.getSnapshot().surfaces.tour.outcome).toBe("completed");
  });

  it("un-hides a device that had already applied the dismissal", () => {
    const controller = controllerWith();
    controller.dispatch({
      type: "dismiss-surface",
      surface: "tour",
      now: Date.now(),
    });

    controller.syncFromRemote({ [TOUR_DECISION_STEP_KEY]: "snoozed" });

    expect(controller.getSnapshot().surfaces.tour.outcome).not.toBe(
      "dismissed",
    );
  });

  it("does not echo an arriving decision back to the server", () => {
    const controller = controllerWith();
    controller.syncFromRemote({ [TOUR_DECISION_STEP_KEY]: "delegated" });
    expect(port.set).not.toHaveBeenCalled();
  });
});

describe("a tour decision made here is recorded for the person", () => {
  it("publishes a dismissal", () => {
    const controller = controllerWith();
    controller.dispatch({
      type: "dismiss-surface",
      surface: "tour",
      now: Date.now(),
    });
    expect(port.set).toHaveBeenCalledWith(TOUR_DECISION_STEP_KEY, "dismissed");
  });

  it("publishes a skip", () => {
    const controller = controllerWith();
    controller.dispatch({
      type: "skip-surface",
      surface: "tour",
      now: Date.now(),
    });
    expect(port.set).toHaveBeenCalledWith(TOUR_DECISION_STEP_KEY, "skipped");
  });

  it("publishes having watched it through, which no server query can derive", () => {
    // There are no rows anywhere that say "this person has seen the dashboard
    // tour". If finishing it is not recorded as a decision, the next device
    // asks them to repeat something they completed — the same clause the
    // dismissal case violates, reached by the happier path.
    const controller = controllerWith();
    controller.dispatch({
      type: "complete-surface",
      surface: "tour",
      now: Date.now(),
    });
    expect(port.set).toHaveBeenCalledWith(TOUR_DECISION_STEP_KEY, "dismissed");
  });

  it("publishes the undo when the tour is replayed after a dismissal", () => {
    // Without this the row still says `dismissed` while the tour is running,
    // and the next hydration — a route change mid-tour is enough to cause one —
    // closes the tour the person just asked to see.
    const controller = controllerWith();
    controller.dispatch({
      type: "dismiss-surface",
      surface: "tour",
      now: Date.now(),
    });
    port.set.mockClear();

    controller.dispatch({
      type: "reset-surface",
      surface: "tour",
      now: Date.now(),
    });

    expect(port.set).toHaveBeenCalledWith(TOUR_DECISION_STEP_KEY, "snoozed");
  });

  it("publishes the undo when the tour is replayed after finishing it", () => {
    const controller = controllerWith();
    controller.dispatch({
      type: "complete-surface",
      surface: "tour",
      now: Date.now(),
    });
    port.set.mockClear();

    controller.dispatch({
      type: "reset-surface",
      surface: "tour",
      now: Date.now(),
    });

    expect(port.set).toHaveBeenCalledWith(TOUR_DECISION_STEP_KEY, "snoozed");
  });

  it("does not publish an undo for a tour nobody put away", () => {
    const controller = controllerWith();
    controller.dispatch({
      type: "reset-surface",
      surface: "tour",
      now: Date.now(),
    });
    expect(port.set).not.toHaveBeenCalled();
  });

  it("still dismisses locally when the port rejects", async () => {
    port.set.mockRejectedValue(new Error("offline"));
    const controller = controllerWith();
    controller.dispatch({
      type: "dismiss-surface",
      surface: "tour",
      now: Date.now(),
    });
    await Promise.resolve();
    expect(controller.getSnapshot().surfaces.tour.outcome).toBe("dismissed");
  });

  it("works with no port at all", () => {
    const controller = new OnboardingStateController({
      storage: memoryStorage(),
      identity,
    });
    expect(() =>
      controller.dispatch({
        type: "dismiss-surface",
        surface: "tour",
        now: Date.now(),
      }),
    ).not.toThrow();
  });
});

describe("a dismissal made before this shipped still travels", () => {
  it("backfills the decision this device has been holding alone", () => {
    // Local storage stops being the authority here, but it does not stop being
    // TRUE: the person really did dismiss the tour. Deleting the key would make
    // it come back; leaving it only here would leave every other device asking.
    const storage = memoryStorage();
    const before = new OnboardingStateController({ storage, identity });
    before.dispatch({
      type: "dismiss-surface",
      surface: "tour",
      now: Date.now(),
    });
    expect(port.set).not.toHaveBeenCalled();

    const afterUpgrade = controllerWith(storage);
    expect(afterUpgrade.getSnapshot().surfaces.tour.outcome).toBe("dismissed");
    afterUpgrade.syncFromRemote({});

    expect(port.set).toHaveBeenCalledWith(TOUR_DECISION_STEP_KEY, "dismissed");
  });

  it("carries the pre-versioning localStorage key up, not just across", () => {
    // `postwave_tour_dashboard_dismissed_at` is the exact key all three clients
    // kept privately. Migration already maps it onto the tour surface; this is
    // what gets it out of the device.
    const storage = memoryStorage();
    storage.setItem(
      "postwave_tour_dashboard_dismissed_at",
      new Date().toISOString(),
    );
    const controller = controllerWith(storage);
    controller.activate();

    expect(controller.getSnapshot().surfaces.tour.outcome).toBe("dismissed");
    controller.syncFromRemote({});

    expect(port.set).toHaveBeenCalledWith(TOUR_DECISION_STEP_KEY, "dismissed");
  });

  it("never overwrites a decision the person made somewhere else", () => {
    // The laptop holds a local dismissal and the person has since restored the
    // tour on their phone. A backfill that ignored the present row would undo
    // the restore and re-hide the tour on every device.
    const storage = memoryStorage();
    const before = new OnboardingStateController({ storage, identity });
    before.dispatch({
      type: "dismiss-surface",
      surface: "tour",
      now: Date.now(),
    });

    const afterUpgrade = controllerWith(storage);
    afterUpgrade.syncFromRemote({ [TOUR_DECISION_STEP_KEY]: "snoozed" });

    expect(port.set).not.toHaveBeenCalled();
    expect(afterUpgrade.getSnapshot().surfaces.tour.outcome).not.toBe(
      "dismissed",
    );
  });

  it("leaves an undecided tour alone", () => {
    const controller = controllerWith();
    controller.syncFromRemote({});
    expect(port.set).not.toHaveBeenCalled();
  });
});

describe("the decision gate reports whether it has been consulted", () => {
  it("is unsettled until the decisions arrive", () => {
    const controller = controllerWith();
    expect(controller.getDecisionsSettled()).toBe(false);

    controller.syncFromRemote({});

    expect(controller.getDecisionsSettled()).toBe(true);
  });

  it("settles when the fetch failed, so an offline window is not stuck", () => {
    const controller = controllerWith();
    controller.markDecisionsSettled();
    expect(controller.getDecisionsSettled()).toBe(true);
  });

  it("has nothing to wait for without a port", () => {
    const controller = new OnboardingStateController({
      storage: memoryStorage(),
      identity,
    });
    expect(controller.getDecisionsSettled()).toBe(true);
  });

  it("notifies subscribers when it settles, or nothing re-renders", () => {
    const controller = controllerWith();
    const subscriber = vi.fn();
    controller.subscribe(subscriber);

    // No local state change at all — only the gate moves.
    controller.syncFromRemote({});

    expect(subscriber).toHaveBeenCalled();
  });
});

describe("the checklist keeps its own semantics", () => {
  it("does not publish a completed checklist as a decision", () => {
    // Checklist completion is DERIVED from real setup rows and can be undone by
    // deleting the thing that completed it. A `dismissed` row would outlive the
    // fact and suppress the checklist forever.
    const controller = controllerWith();
    controller.dispatch({
      type: "complete-surface",
      surface: "checklist",
      now: Date.now(),
    });
    expect(port.set).not.toHaveBeenCalled();
  });

  it("still applies a remote dismissal over a completed checklist", () => {
    const controller = controllerWith();
    controller.dispatch({
      type: "complete-surface",
      surface: "checklist",
      now: Date.now(),
    });

    controller.syncFromRemote({ dashboard_checklist: "dismissed" });

    expect(controller.getSnapshot().surfaces.checklist.outcome).toBe(
      "dismissed",
    );
  });
});
