import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHECKLIST_DECISION_STEP_KEY,
  TOUR_DECISION_STEP_KEY,
  ONBOARDING_DECISION_STATES,
  decisionHidesSurface,
} from "@postwave/onboarding-schema";

import {
  OnboardingStateController,
  type OnboardingDecisionPort,
} from "../../lib/onboarding-state-controller";

/**
 * A decision belongs to the person, not the device.
 *
 * Every onboarding decision — dismissed, skipped — lived only in this device's
 * localStorage. The same user dismissed the setup checklist on desktop, opened
 * the web app, and it was back; dismissed it there, picked up their phone, and
 * it was back again. The product asked one question on every device until it
 * was answered on every device.
 *
 * `GET/PUT /api/v1/onboarding/steps` is the durable per-(tenant, user, step)
 * home for those decisions, and shipped with no client calling it.
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

const identity = { workspaceId: "ws-1", userId: "user-1", role: "admin" } as const;

let port: OnboardingDecisionPort & { set: ReturnType<typeof vi.fn> };

beforeEach(() => {
  port = {
    list: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(undefined),
  };
});

describe("decisions made elsewhere are honoured here", () => {
  it("applies a dismissal recorded on another device", () => {
    // This device has a clean slate — the user dismissed the checklist on their
    // phone. Before this, desktop showed it again and asked a second time.
    const controller = new OnboardingStateController({
      storage: memoryStorage(),
      identity,
      decisions: port,
    });
    expect(controller.getSnapshot().surfaces.checklist?.outcome).not.toBe(
      "dismissed",
    );

    const changed = controller.syncFromRemote({
      dashboard_checklist: "dismissed",
    });

    expect(changed).toBe(true);
    expect(controller.getSnapshot().surfaces.checklist?.outcome).toBe(
      "dismissed",
    );
  });

  it("does not tear the tour off the screen while someone is walking through it", () => {
    // The failure this whole change exists to avoid, arriving from the far side.
    //
    // The OPENING gate exempts a hand start, so clicking "Take the tour" works
    // even before the decision lands. Nothing protected it afterwards:
    // "in-progress" is not terminal, so a remote `dismissed` sailed past the
    // terminal-outcome guard and finished the surface. The person clicked Start,
    // the tour opened, painted, and vanished under them — worse than the bug it
    // replaces, which merely asked a question twice.
    //
    // The remote answer is not wrong here, only OLDER than what they are doing
    // right now, and it is not lost: leaving the tour publishes a terminal
    // outcome of their own, which is the better-sourced answer.
    const controller = new OnboardingStateController({
      storage: memoryStorage(),
      identity,
      decisions: port,
    });
    // "manual" is the whole point: this is the person clicking Take the tour,
    // which the opening gate deliberately exempts — so it is the one path that
    // needed protecting downstream.
    controller.dispatch({
      type: "open",
      surface: "tour",
      trigger: "manual",
      now: Date.now(),
    });
    expect(controller.getSnapshot().surfaces.tour?.outcome).toBe("in-progress");

    controller.syncFromRemote({ [TOUR_DECISION_STEP_KEY]: "dismissed" });

    expect(controller.getSnapshot().surfaces.tour?.outcome).toBe("in-progress");
  });

  it("is a no-op when the remote agrees with local", () => {
    const controller = new OnboardingStateController({
      storage: memoryStorage(),
      identity,
      decisions: port,
    });
    controller.syncFromRemote({ dashboard_checklist: "dismissed" });
    expect(controller.syncFromRemote({ dashboard_checklist: "dismissed" })).toBe(
      false,
    );
  });

  it("ignores remote states that are not decisions", () => {
    // "in-progress" says where someone got to on one machine. That is not a
    // fact about the person and must not travel.
    const controller = new OnboardingStateController({
      storage: memoryStorage(),
      identity,
      decisions: port,
    });
    expect(controller.syncFromRemote({ dashboard_checklist: "snoozed" })).toBe(
      false,
    );
  });
});

describe("desktop honours the whole vocabulary, not a private subset", () => {
  // `onboarding-state-controller.ts` keeps its OWN remote→local map, because
  // the local state machine has two hiding outcomes and the wire has four.
  // That map is a hand-maintained parallel of the schema's `HIDING_STATES`,
  // and nothing tied the two together: adding a sixth state to the shared
  // contract would leave desktop silently reading it as "no decision" and
  // re-asking a question the person had already answered on another device.
  // This drives the map from the contract instead of trusting it.
  it.each(ONBOARDING_DECISION_STATES)(
    "agrees with the shared contract about '%s'",
    (state) => {
      const controller = new OnboardingStateController({
        storage: memoryStorage(),
        identity,
        decisions: port,
      });
      controller.syncFromRemote({ [CHECKLIST_DECISION_STEP_KEY]: state });
      const outcome = controller.getSnapshot().surfaces.checklist?.outcome;
      const hiddenHere = outcome === "dismissed" || outcome === "skipped";
      expect(hiddenHere).toBe(decisionHidesSurface(state));
    },
  );

  it("applying a remote decision does not echo it back to the server", () => {
    // `syncFromRemote` must not re-publish what it just received, or two
    // devices hydrating at once write over each other forever.
    const controller = new OnboardingStateController({
      storage: memoryStorage(),
      identity,
      decisions: port,
    });
    controller.syncFromRemote({
      [CHECKLIST_DECISION_STEP_KEY]: "inapplicable",
    });
    expect(port.set).not.toHaveBeenCalled();
  });
});

describe("a decision and its undo both survive the next mount", () => {
  /** The endpoint, modelled as what it is: one row per (person, step). */
  function fakeServer(): OnboardingDecisionPort & {
    rows: Record<string, string>;
  } {
    const rows: Record<string, string> = {};
    return {
      rows,
      list: () => Promise.resolve({ ...rows }),
      set: (stepKey, state) => {
        rows[stepKey] = state;
        return Promise.resolve();
      },
    };
  }

  function mount(server: OnboardingDecisionPort): OnboardingStateController {
    return new OnboardingStateController({
      storage: memoryStorage(),
      identity,
      decisions: server,
    });
  }

  it("a dismissal here is honoured on a device that never saw it", async () => {
    const server = fakeServer();
    const laptop = mount(server);
    laptop.dispatch({
      type: "dismiss-surface",
      surface: "checklist",
      now: Date.now(),
    });

    // A different device, clean storage, same person.
    const phone = mount(server);
    phone.syncFromRemote(await server.list());

    expect(phone.getSnapshot().surfaces.checklist?.outcome).toBe("dismissed");
  });

  it("a restore here is still a restore on the next mount", async () => {
    // The regression this whole port exists to prevent, in its sharpest form:
    // the user dismisses, changes their mind, clicks Restore — and the app
    // re-hides the card the moment they reopen it, because the server was
    // never told. It looks exactly like a broken button.
    const server = fakeServer();
    const laptop = mount(server);
    laptop.dispatch({
      type: "dismiss-surface",
      surface: "checklist",
      now: Date.now(),
    });
    laptop.dispatch({
      type: "reset-surface",
      surface: "checklist",
      now: Date.now(),
    });

    const reopened = mount(server);
    reopened.syncFromRemote(await server.list());

    expect(reopened.getSnapshot().surfaces.checklist?.outcome).not.toBe(
      "dismissed",
    );
  });

  it("un-hides a device that had already applied the dismissal", async () => {
    // The symmetric half, and the one a fresh-controller test cannot see: the
    // laptop has `dismissed` PERSISTED locally. The person restores on their
    // phone. `syncFromRemote` only ever applied hiding states, so the laptop
    // read `snoozed`, found no hiding outcome to apply, and stayed hidden
    // forever — the undo travelled to devices that had never seen the
    // dismissal and to no others. An undo is a decision too.
    const server = fakeServer();
    const laptop = mount(server);
    laptop.dispatch({
      type: "dismiss-surface",
      surface: "checklist",
      now: Date.now(),
    });
    expect(laptop.getSnapshot().surfaces.checklist?.outcome).toBe("dismissed");

    // …restored elsewhere.
    await server.set(CHECKLIST_DECISION_STEP_KEY, "snoozed");
    laptop.syncFromRemote(await server.list());

    expect(laptop.getSnapshot().surfaces.checklist?.outcome).not.toBe(
      "dismissed",
    );
  });

  it("does not un-hide when the person simply has no recorded decision", async () => {
    // An ABSENT row means "never asked", not "restore me". A device that
    // dismissed locally before this port existed must keep its dismissal
    // rather than have it silently undone by an empty server response.
    const server = fakeServer();
    const laptop = new OnboardingStateController({
      storage: memoryStorage(),
      identity,
    });
    laptop.dispatch({
      type: "dismiss-surface",
      surface: "checklist",
      now: Date.now(),
    });

    laptop.syncFromRemote(await server.list());

    expect(laptop.getSnapshot().surfaces.checklist?.outcome).toBe("dismissed");
  });

  it("the undo reaches the OTHER devices too, not just this one", async () => {
    // Restoring on the laptop has to un-hide the phone as well, or the person
    // has to answer the same question twice again — the exact failure the
    // durable row was introduced to end.
    const server = fakeServer();
    const laptop = mount(server);
    laptop.dispatch({
      type: "dismiss-surface",
      surface: "checklist",
      now: Date.now(),
    });

    const phone = mount(server);
    phone.syncFromRemote(await server.list());
    expect(phone.getSnapshot().surfaces.checklist?.outcome).toBe("dismissed");

    laptop.dispatch({
      type: "reset-surface",
      surface: "checklist",
      now: Date.now(),
    });

    const phoneReopened = mount(server);
    phoneReopened.syncFromRemote(await server.list());
    expect(phoneReopened.getSnapshot().surfaces.checklist?.outcome).not.toBe(
      "dismissed",
    );
  });
});

describe("decisions made here are recorded for the person", () => {
  it("publishes a dismissal", () => {
    const controller = new OnboardingStateController({
      storage: memoryStorage(),
      identity,
      decisions: port,
    });
    controller.dispatch({
      type: "dismiss-surface",
      surface: "checklist",
      now: Date.now(),
    });
    expect(port.set).toHaveBeenCalledWith("dashboard_checklist", "dismissed");
  });

  it("does not publish the first-run wizard", () => {
    // "Show me this app's tour once" is reasonably a per-install fact, so the
    // wizard is deliberately absent from the remote map.
    const controller = new OnboardingStateController({
      storage: memoryStorage(),
      identity,
      decisions: port,
    });
    controller.dispatch({
      type: "dismiss-surface",
      surface: "wizard",
      now: Date.now(),
    });
    expect(port.set).not.toHaveBeenCalled();
  });

  it("still dismisses locally when the port rejects", async () => {
    // A preference is not a mutation anyone is waiting on.
    port.set.mockRejectedValue(new Error("offline"));
    const controller = new OnboardingStateController({
      storage: memoryStorage(),
      identity,
      decisions: port,
    });
    controller.dispatch({
      type: "dismiss-surface",
      surface: "checklist",
      now: Date.now(),
    });
    await Promise.resolve();
    expect(controller.getSnapshot().surfaces.checklist?.outcome).toBe(
      "dismissed",
    );
  });

  it("publishes the undo, so the restore control is not a lie", () => {
    // The dismissal travels; without this, the UNDO did not. Desktop's
    // "Restore" button resets the surface locally and published nothing, so
    // the server still said `dismissed` — and the very next mount hydrated
    // that back and re-hid the card the person had just asked to see.
    // Mobile's "Show setup checklist" and web's "Show checklist" both write
    // the restore state; desktop was the one surface that did not.
    const controller = new OnboardingStateController({
      storage: memoryStorage(),
      identity,
      decisions: port,
    });
    controller.dispatch({
      type: "dismiss-surface",
      surface: "checklist",
      now: Date.now(),
    });
    port.set.mockClear();

    controller.dispatch({
      type: "reset-surface",
      surface: "checklist",
      now: Date.now(),
    });

    expect(port.set).toHaveBeenCalledWith("dashboard_checklist", "snoozed");
  });

  it("does not publish an undo for a surface nobody decided about", () => {
    // Resetting an untouched checklist is not a decision — publishing
    // `snoozed` for it would write a row for a question the person was never
    // asked, and would overwrite a real dismissal made on another device with
    // a local no-op.
    const controller = new OnboardingStateController({
      storage: memoryStorage(),
      identity,
      decisions: port,
    });
    controller.dispatch({
      type: "reset-surface",
      surface: "checklist",
      now: Date.now(),
    });
    expect(port.set).not.toHaveBeenCalled();
  });

  it("does not publish the wizard's reset either", () => {
    const controller = new OnboardingStateController({
      storage: memoryStorage(),
      identity,
      decisions: port,
    });
    controller.dispatch({
      type: "dismiss-surface",
      surface: "wizard",
      now: Date.now(),
    });
    controller.dispatch({
      type: "reset-surface",
      surface: "wizard",
      now: Date.now(),
    });
    expect(port.set).not.toHaveBeenCalled();
  });

  it("works with no port at all", () => {
    // A signed-out or offline window must behave exactly as before.
    const controller = new OnboardingStateController({
      storage: memoryStorage(),
      identity,
    });
    expect(() =>
      controller.dispatch({
        type: "dismiss-surface",
        surface: "checklist",
        now: Date.now(),
      }),
    ).not.toThrow();
  });
});
