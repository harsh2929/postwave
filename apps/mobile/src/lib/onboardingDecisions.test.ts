import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHECKLIST_DECISION_STEP_KEY,
  TOUR_DECISION_STEP_KEY,
} from "@postwave/onboarding-schema";

const { getItem, setItem, removeItem, listStepDecisions, setStepDecision } =
  vi.hoisted(() => ({
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    listStepDecisions: vi.fn(),
    setStepDecision: vi.fn(),
  }));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem, setItem, removeItem },
}));
vi.mock("@/api/sdkClient", () => ({
  getClient: () => ({
    client: { onboarding: { listStepDecisions, setStepDecision } },
  }),
}));

const {
  CHECKLIST_DISMISSED_KEY,
  CHECKLIST_STEP_KEY,
  TOUR_DISMISSED_AT_KEY,
  TOUR_STEP_KEY,
  dismissChecklist,
  dismissTour,
  isChecklistDismissed,
  isTourDismissed,
  restoreChecklist,
} = await import("./onboardingDecisions");

beforeEach(() => {
  vi.clearAllMocks();
  getItem.mockResolvedValue(null);
  setItem.mockResolvedValue(undefined);
  removeItem.mockResolvedValue(undefined);
  listStepDecisions.mockResolvedValue({ steps: {} });
  setStepDecision.mockResolvedValue({ state: "dismissed" });
});

describe("a decision follows the person, not the device", () => {
  it("honours a dismissal made on another device", async () => {
    // The whole point: this device has NOTHING in local storage, because the
    // user dismissed the checklist on desktop. Before this, the phone would
    // show it again and ask the same question a second time.
    getItem.mockResolvedValue(null);
    listStepDecisions.mockResolvedValue({
      steps: { [CHECKLIST_STEP_KEY]: { state: "dismissed" } },
    });

    expect(await isChecklistDismissed()).toBe(true);
  });

  it("caches the server answer so a cold start does not flash the checklist", async () => {
    listStepDecisions.mockResolvedValue({
      steps: { [CHECKLIST_STEP_KEY]: { state: "dismissed" } },
    });
    await isChecklistDismissed();
    expect(setItem).toHaveBeenCalledWith(CHECKLIST_DISMISSED_KEY, "1");
  });

  it("records a dismissal for every device", async () => {
    await dismissChecklist();
    expect(setStepDecision).toHaveBeenCalledWith(
      CHECKLIST_STEP_KEY,
      "dismissed",
    );
  });

  it("writes the key the other clients read", async () => {
    // Desktop and mobile each used to spell this literal themselves. One
    // rename would have split one shared decision into two unshared ones,
    // each device writing a key the others never read.
    expect(CHECKLIST_STEP_KEY).toBe(CHECKLIST_DECISION_STEP_KEY);
  });

  it.each(["dismissed", "skipped", "inapplicable", "delegated"] as const)(
    "honours a '%s' decision made elsewhere",
    async (state) => {
      // The server's vocabulary has five states and this screen can only
      // produce two of them. `inapplicable` ("not us") and `delegated`
      // ("someone else has it") can arrive from another surface, and reading
      // only `dismissed`/`skipped` brought back a step the person had already
      // called impossible.
      getItem.mockResolvedValue(null);
      listStepDecisions.mockResolvedValue({
        steps: { [CHECKLIST_STEP_KEY]: { state } },
      });
      expect(await isChecklistDismissed()).toBe(true);
    },
  );

  it("treats a snooze as 'show it to me again'", async () => {
    getItem.mockResolvedValue("1");
    listStepDecisions.mockResolvedValue({
      steps: { [CHECKLIST_STEP_KEY]: { state: "snoozed" } },
    });
    expect(await isChecklistDismissed()).toBe(false);
    // And the stale local cache is cleared, or the next cold start would
    // re-hide a checklist the person just asked to see.
    expect(removeItem).toHaveBeenCalledWith(CHECKLIST_DISMISSED_KEY);
  });
});

describe("it stays usable when the network does not", () => {
  it("falls back to the local answer when the server is unreachable", async () => {
    listStepDecisions.mockRejectedValue(new Error("offline"));
    getItem.mockResolvedValue("1");
    expect(await isChecklistDismissed()).toBe(true);
  });

  it("still dismisses locally when the server call fails", async () => {
    // A preference is not a mutation someone is waiting on. Refusing to dismiss
    // a checklist because a request failed would be a worse product for a
    // strictly cosmetic guarantee.
    setStepDecision.mockRejectedValue(new Error("offline"));
    await expect(dismissChecklist()).resolves.toBeUndefined();
    expect(setItem).toHaveBeenCalledWith(CHECKLIST_DISMISSED_KEY, "1");
  });
});

describe("restoring clears both sides", () => {
  it("does not leave the server saying dismissed", async () => {
    // Clearing only the local key was the old behaviour and would now be worse
    // than before: the next read would put the checklist straight back and the
    // Settings control would look broken.
    await restoreChecklist();
    expect(removeItem).toHaveBeenCalledWith(CHECKLIST_DISMISSED_KEY);
    expect(setStepDecision).toHaveBeenCalledWith(CHECKLIST_STEP_KEY, "snoozed");
  });
});

// ─────────────────────────── THE DASHBOARD TOUR ───────────────────────────

/**
 * Back the AsyncStorage mock with a real map for the tour tests.
 *
 * The tour reads ONE key and the checklist reads another, so a blanket
 * `getItem.mockResolvedValue("1")` would answer for both and let a test pass
 * while the code read the wrong key entirely.
 */
function localStorage(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial };
  getItem.mockImplementation(async (key: string) => store[key] ?? null);
  setItem.mockImplementation(async (key: string, value: string) => {
    store[key] = value;
  });
  removeItem.mockImplementation(async (key: string) => {
    delete store[key];
  });
  return store;
}

describe("the tour is not asked again on the next device", () => {
  it("honours a skip taken on another device", async () => {
    // The whole gap: this phone has NOTHING in AsyncStorage, because the
    // person skipped the tour on their laptop. Before this, the tour ran a
    // second time and asked a question that was already answered.
    localStorage();
    listStepDecisions.mockResolvedValue({
      steps: { [TOUR_STEP_KEY]: { state: "dismissed" } },
    });

    expect(await isTourDismissed()).toBe(true);
  });

  it.each(["dismissed", "skipped", "inapplicable", "delegated"] as const)(
    "honours a '%s' decision made elsewhere",
    async (state) => {
      // This surface can only produce `dismissed`, but the vocabulary has
      // five states and the other two clients can write any of them. Reading
      // only our own would re-run a tour someone already called inapplicable.
      localStorage();
      listStepDecisions.mockResolvedValue({
        steps: { [TOUR_STEP_KEY]: { state } },
      });
      expect(await isTourDismissed()).toBe(true);
    },
  );

  it("caches the server answer so a cold start does not flash the tour", async () => {
    localStorage();
    listStepDecisions.mockResolvedValue({
      steps: { [TOUR_STEP_KEY]: { state: "dismissed" } },
    });
    await isTourDismissed();
    expect(setItem).toHaveBeenCalledWith(
      TOUR_DISMISSED_AT_KEY,
      expect.any(String),
    );
  });

  it("does not overwrite when the person decided", async () => {
    // The cached value is the timestamp of the decision, not a boolean.
    // Rewriting it to "now" on every read would erase when it happened.
    const decidedAt = "2026-01-02T03:04:05.000Z";
    localStorage({ [TOUR_DISMISSED_AT_KEY]: decidedAt });
    listStepDecisions.mockResolvedValue({
      steps: { [TOUR_STEP_KEY]: { state: "dismissed" } },
    });
    expect(await isTourDismissed()).toBe(true);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("keeps the tour and the checklist on separate keys", async () => {
    // A copy-paste that reused the checklist's key would make dismissing one
    // surface silently dismiss the other.
    expect(TOUR_STEP_KEY).not.toBe(CHECKLIST_STEP_KEY);
    localStorage();
    listStepDecisions.mockResolvedValue({
      steps: { [CHECKLIST_STEP_KEY]: { state: "dismissed" } },
    });
    expect(await isTourDismissed()).toBe(false);
  });

  it("writes the step key the other clients read", async () => {
    expect(TOUR_STEP_KEY).toBe(TOUR_DECISION_STEP_KEY);
  });

  it("records a skip for every device", async () => {
    localStorage();
    await dismissTour();
    expect(setStepDecision).toHaveBeenCalledWith(TOUR_STEP_KEY, "dismissed");
  });
});

describe("an answer given before this shipped still counts", () => {
  it("honours a local dismissal the server has never heard of", async () => {
    // Somebody dismissed the tour last month, when the flag was this device's
    // to hold. Letting the server's silence win would have re-run the tour for
    // every existing user the day this shipped.
    localStorage({ [TOUR_DISMISSED_AT_KEY]: "2026-01-02T03:04:05.000Z" });
    listStepDecisions.mockResolvedValue({ steps: {} });

    expect(await isTourDismissed()).toBe(true);
  });

  it("teaches the server about it so the NEXT device asks nobody", async () => {
    localStorage({ [TOUR_DISMISSED_AT_KEY]: "2026-01-02T03:04:05.000Z" });
    listStepDecisions.mockResolvedValue({ steps: {} });

    await isTourDismissed();
    expect(setStepDecision).toHaveBeenCalledWith(TOUR_STEP_KEY, "dismissed");
  });

  it("does not delete the local answer it has not yet uploaded", async () => {
    // The backfill is best-effort. Clearing the cache before the server has
    // acknowledged it would lose the decision entirely on a flaky connection.
    localStorage({ [TOUR_DISMISSED_AT_KEY]: "2026-01-02T03:04:05.000Z" });
    listStepDecisions.mockResolvedValue({ steps: {} });
    setStepDecision.mockRejectedValue(new Error("offline"));

    expect(await isTourDismissed()).toBe(true);
    expect(removeItem).not.toHaveBeenCalled();
  });
});

describe("a skip taken offline is deferred, never lost", () => {
  it("still records locally when the server call fails", async () => {
    localStorage();
    setStepDecision.mockRejectedValue(new Error("offline"));
    await expect(dismissTour()).resolves.toBeUndefined();
    expect(setItem).toHaveBeenCalledWith(
      TOUR_DISMISSED_AT_KEY,
      expect.any(String),
    );
  });

  it("survives the round trip: skipped offline, then online again", async () => {
    // The full journey, because the two halves pass individually while the
    // seam between them leaks: dismiss with no network, then read with one.
    const store = localStorage();
    setStepDecision.mockRejectedValue(new Error("offline"));
    listStepDecisions.mockRejectedValue(new Error("offline"));

    await dismissTour();
    expect(await isTourDismissed()).toBe(true);
    expect(store[TOUR_DISMISSED_AT_KEY]).toEqual(expect.any(String));

    // Network returns. The server never heard about the skip.
    setStepDecision.mockResolvedValue({ ok: true });
    listStepDecisions.mockResolvedValue({ steps: {} });

    expect(await isTourDismissed()).toBe(true);
    expect(setStepDecision).toHaveBeenCalledWith(TOUR_STEP_KEY, "dismissed");
  });

  it("falls back to the local answer when the server is unreachable", async () => {
    localStorage({ [TOUR_DISMISSED_AT_KEY]: "2026-01-02T03:04:05.000Z" });
    listStepDecisions.mockRejectedValue(new Error("offline"));
    expect(await isTourDismissed()).toBe(true);
  });

  it("shows the tour offline when nobody has ever put it away", async () => {
    // Failing toward SHOWING is the recoverable direction: a first-run user on
    // a plane still gets the tour, and dismissing it again costs one tap.
    localStorage();
    listStepDecisions.mockRejectedValue(new Error("offline"));
    expect(await isTourDismissed()).toBe(false);
  });
});

describe("a person can get the tour back", () => {
  it("treats a snooze as 'show it to me again' and drops the stale cache", async () => {
    // `snoozed` is what a restore control writes. Honouring the local cache
    // over it would make that control look broken on this device forever.
    const store = localStorage({
      [TOUR_DISMISSED_AT_KEY]: "2026-01-02T03:04:05.000Z",
    });
    listStepDecisions.mockResolvedValue({
      steps: { [TOUR_STEP_KEY]: { state: "snoozed" } },
    });

    expect(await isTourDismissed()).toBe(false);
    expect(removeItem).toHaveBeenCalledWith(TOUR_DISMISSED_AT_KEY);
    expect(store[TOUR_DISMISSED_AT_KEY]).toBeUndefined();
  });
});

describe("one spelling of one fact", () => {
  const providerSource = readFileSync(
    new URL("../components/tour/TourProvider.tsx", import.meta.url),
    "utf8",
  );
  const launchSource = readFileSync(
    new URL("../components/tour/useTourLaunchLifecycle.ts", import.meta.url),
    "utf8",
  );

  it("routes every tour-dismissal read and write through this module", () => {
    // The provider owning its own AsyncStorage access is how the decision
    // stayed per-device. If it touches the key directly again, the server
    // never hears about a skip taken here.
    expect(launchSource).toContain('from "@/lib/onboardingDecisions"');
    expect(launchSource).toContain("isTourDismissed");
    expect(providerSource).toContain("dismissTour");
    expect(`${providerSource}\n${launchSource}`).not.toContain(
      "TOUR_STORAGE_KEYS.dismissedAt",
    );
  });

  it("does not respell the storage key", () => {
    // Two copies of one literal is how a shared decision quietly becomes two
    // unshared ones, each client writing a key the others never read.
    expect(launchSource).toContain("dismissedAt: TOUR_DISMISSED_AT_KEY");
  });
});
