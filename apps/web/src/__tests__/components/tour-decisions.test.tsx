// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The dashboard tour was the last per-device answer left. All three clients
// kept their own `postwave_tour_dashboard_*` key in local storage, so a person
// dismissed the tour on their laptop, opened the phone, and it ran again — the
// product asking a question that had already been answered, once per device.
//
// These tests pin the three halves that matter, all through the SAME mechanism
// the getting-started checklist already uses (`GET/PUT /api/v1/onboarding/steps`):
//
//   1. a decision made anywhere is honoured here,
//   2. a decision made here is recorded for the person, and
//   3. the tour is never on screen BEFORE the decision arrives — a tour that
//      runs for a beat and then vanishes is worse than the bug.
//
// Every post-load assertion waits on a signal that is FALSE before the query
// resolves. "The tour is not open" is true on the very first render, so a
// `waitFor` on it alone returns on attempt zero and asserts nothing — the exact
// defect found twice in the checklist's own decision tests.

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHECKLIST_GOALS,
  TOUR_DECISION_STEP_KEY,
  type OnboardingProgress,
} from "@postwave/onboarding-schema";

import {
  TourProvider,
  TOUR_DECISION_ADOPTED_REASON,
  useTour,
} from "@/components/tour/TourProvider";
import {
  onboardingAuthorityFromFields,
  onboardingDecisionsKey,
  onboardingProgressKey,
} from "@/lib/onboarding-authority";
import {
  tourAutoStartGate,
  tourDecisionStepKey,
} from "@/components/tour/tour-routing";
import type { RoleKey } from "@/lib/query-keys";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const DECISIONS_PATH = "/api/v1/onboarding/steps";
const WHOAMI_PATH = "/api/v1/auth/me";
const LOCAL_KEY = "postwave_tour_dashboard_completed_at";
/** Mirrors the provider's pre-launch settle delay. */
const AUTO_START_MS = 600;

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  track: vi.fn(),
  pathname: { current: "/app" },
  routerPush: vi.fn(),
  identity: {
    tenantId: "tnt_1",
    userId: "usr_1",
    role: "admin" as RoleKey,
    viewerMode: false,
  },
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, get: mocks.apiGet, put: mocks.apiPut },
  };
});

vi.mock("@/lib/telemetry", () => ({ track: mocks.track }));
vi.mock("@/lib/use-online", () => ({ useOnline: () => "online" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mocks.routerPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => mocks.pathname.current,
  useSearchParams: () => new URLSearchParams(),
}));

// The overlay measures real DOM geometry and is irrelevant here — the probe
// below reports the tour's state directly, which is what the gate controls.
vi.mock("next/dynamic", () => ({
  default: () =>
    function TourOverlayStub() {
      return null;
    },
}));

function progress(completedKeys: readonly string[] = []): OnboardingProgress {
  const completed = new Set(completedKeys);
  return {
    steps: CHECKLIST_GOALS.map((goal) => ({
      key: goal.key,
      label: goal.label,
      description: goal.description,
      completed: completed.has(goal.key),
    })),
    completed: completed.size,
    total: CHECKLIST_GOALS.length,
    percent: Math.round((completed.size / CHECKLIST_GOALS.length) * 100),
    all_done: completed.size === CHECKLIST_GOALS.length,
  };
}

/**
 * A durable stand-in for the server's `onboarding_step_state` row.
 *
 * Stateful on purpose: a static GET mock would let an optimistic update look
 * correct while the write went nowhere. Here a PUT has to land for a later
 * mount — the "other device" — to see it.
 */
function serve(steps: Record<string, unknown> = {}): {
  steps: Record<string, unknown>;
} {
  const store = { steps: { ...steps } };
  mocks.apiGet.mockImplementation((path: string) => {
    if (path === DECISIONS_PATH) {
      return Promise.resolve({ steps: { ...store.steps } });
    }
    if (path === WHOAMI_PATH) {
      return Promise.resolve({
        user_id: mocks.identity.userId,
        tenant_id: mocks.identity.tenantId,
        email: "person@example.test",
        role: mocks.identity.role,
        effective_role: mocks.identity.role,
        viewer_mode: mocks.identity.viewerMode,
        auth_provider: "password",
        email_verified: true,
        workspace_name: "Workspace",
        workspace_slug: "workspace",
      });
    }
    return Promise.resolve(progress());
  });
  mocks.apiPut.mockImplementation(
    (
      _path: string,
      body: { step_key: string; state: string; reason?: string },
    ) => {
      store.steps = {
        ...store.steps,
        [body.step_key]: body.reason
          ? { state: body.state, reason: body.reason }
          : { state: body.state },
      };
      return Promise.resolve({ ok: true });
    },
  );
  return store;
}

/** Reports what the provider decided, and offers the three write paths. */
function Probe(): JSX.Element {
  const { state, steps, hasCompleted, skip, complete, replay, start } =
    useTour();
  return createElement(
    "div",
    {
      "data-testid": "probe",
      "data-open": state.isOpen ? "true" : "false",
      "data-has-completed": hasCompleted ? "true" : "false",
      "data-step-ids": steps.map((step) => step.id).join(","),
    },
    createElement("button", {
      key: "skip",
      type: "button",
      "data-testid": "probe-skip",
      onClick: skip,
    }),
    createElement("button", {
      key: "complete",
      type: "button",
      "data-testid": "probe-complete",
      onClick: complete,
    }),
    createElement("button", {
      key: "replay",
      type: "button",
      "data-testid": "probe-replay",
      onClick: replay,
    }),
    createElement("button", {
      key: "start",
      type: "button",
      "data-testid": "probe-start",
      onClick: () => start(),
    }),
  );
}

function render(
  ui: ReactNode,
  withQueryClient = true,
): {
  queryClient: QueryClient;
  root: Root;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      withQueryClient
        ? createElement(QueryClientProvider, { client: queryClient }, ui)
        : ui,
    );
  });
  return { queryClient, root };
}

function mount(
  options: {
    tour?: string;
    tenantId?: string;
    userId?: string;
    role?: RoleKey;
    viewerMode?: boolean;
    autoStart?: boolean;
    withQueryClient?: boolean;
  } = {},
): { queryClient: QueryClient; root: Root } {
  const {
    tour = "dashboard",
    tenantId = "tnt_1",
    userId = "usr_1",
    role = "admin",
    viewerMode = false,
    autoStart = true,
    withQueryClient = true,
  } = options;
  mocks.identity.tenantId = tenantId ?? "tnt_1";
  mocks.identity.userId = userId ?? "usr_1";
  mocks.identity.role = role;
  mocks.identity.viewerMode = viewerMode;
  return render(
    <TourProvider
      tour={tour}
      tenantId={tenantId}
      userId={userId}
      role={role}
      viewerMode={viewerMode}
      autoStart={autoStart}
    >
      <Probe />
    </TourProvider>,
    withQueryClient,
  );
}

/**
 * Polls in REAL time, because the provider's launch is real-timer driven.
 *
 * The first version stepped with `setTimeout(0)`, which advances essentially no
 * wall clock — so "the tour launched" was really "the tour launched within a
 * few microtasks", and it flaked one run in three. The budget below (60 × 20ms)
 * comfortably clears the 600ms launch delay while still returning immediately
 * for the assertions that are already true.
 */
async function waitFor(assertion: () => void, gapMs = 20): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, gapMs));
      });
    }
  }
  throw lastError;
}

/**
 * Resolves once every in-flight query has landed AND React has re-rendered.
 *
 * `isFetching() === 0` means the DATA arrived, not that the tree has committed
 * with it; asserting straight after still read the pre-settle paint, so the act
 * flush is load-bearing rather than decorative.
 */
async function settled(queryClient: QueryClient): Promise<void> {
  await waitFor(() => {
    expect(mocks.apiGet).toHaveBeenCalled();
  });
  await waitFor(() => {
    expect(queryClient.isFetching()).toBe(0);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

/**
 * Let the launch window pass with room to spare, for the assertions that the
 * tour did NOT launch. Generous on purpose: a short wait would let "did not
 * launch" mean "had not launched yet", which asserts nothing.
 */
async function elapseAutoStartWindow(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) =>
      window.setTimeout(resolve, AUTO_START_MS + 500),
    );
  });
}

/** Wait for the tour to actually be on screen. */
async function waitForTourOpen(): Promise<void> {
  await waitFor(() => {
    expect(probe().dataset.open).toBe("true");
  });
}

function probe(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-testid="probe"]');
  if (!element) throw new Error("probe not rendered");
  return element;
}

function click(testId: string): void {
  act(() => {
    document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.click();
  });
}

function decisionPuts(): Array<Record<string, unknown>> {
  return mocks.apiPut.mock.calls
    .filter((call) => call[0] === DECISIONS_PATH)
    .map((call) => call[1] as Record<string, unknown>);
}

function expectDecisionWrite(body: Record<string, unknown>): void {
  expect(mocks.apiPut).toHaveBeenCalledWith(
    DECISIONS_PATH,
    body,
    expect.objectContaining({
      signal: expect.any(AbortSignal),
      requireOnline: true,
      maxAttempts: 1,
      idempotencyKey: expect.any(String),
    }),
  );
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.pathname.current = "/app";
  mocks.identity.tenantId = "tnt_1";
  mocks.identity.userId = "usr_1";
  mocks.identity.role = "admin";
  mocks.identity.viewerMode = false;
  window.localStorage.clear();
  document.body.innerHTML = "";
});

describe("the gate itself", () => {
  const gate = (over: Partial<Parameters<typeof tourAutoStartGate>[0]> = {}) =>
    tourAutoStartGate({
      recordsDecision: true,
      decisionLoaded: true,
      recordedState: null,
      dismissedOnThisDevice: false,
      ...over,
    });

  it("waits while the answer is unknown", () => {
    expect(gate({ decisionLoaded: false })).toBe("unknown");
    // Even for someone this device has never seen: guessing "launch" is what
    // re-asks a question that may already be answered.
    expect(gate({ decisionLoaded: false, dismissedOnThisDevice: true })).toBe(
      "unknown",
    );
  });

  it("lets a recorded decision outrank this device's cache", () => {
    expect(gate({ recordedState: "dismissed" })).toBe("blocked");
    // Not only `dismissed` — `inapplicable` means the person said it is
    // impossible for them, the case where re-asking is worst.
    expect(gate({ recordedState: "inapplicable" })).toBe("blocked");
    expect(gate({ recordedState: "delegated" })).toBe("blocked");
    // The direction that makes local storage a CACHE and not the authority:
    // they hit "Restart tour" elsewhere, so this laptop shows it again even
    // though it remembers them dismissing it here.
    expect(
      gate({ recordedState: "snoozed", dismissedOnThisDevice: true }),
    ).toBe("allowed");
  });

  it("still honours a local dismissal when nothing was ever recorded", () => {
    // The person who dismissed the tour before this shipped, and the person
    // whose write the server refuses. Their answer is only here — and it counts.
    expect(gate({ dismissedOnThisDevice: true })).toBe("blocked");
    expect(gate({})).toBe("allowed");
  });

  it("keeps the signed-out tour working on the local key alone", () => {
    // No (tenant, user) to record for. Gating it on a decision that can never
    // arrive would silently kill the marketing tour.
    expect(gate({ recordsDecision: false, decisionLoaded: false })).toBe(
      "allowed",
    );
    expect(
      gate({
        recordsDecision: false,
        decisionLoaded: false,
        dismissedOnThisDevice: true,
      }),
    ).toBe("blocked");
  });

  it("records the dashboard tour against the shared step key only", () => {
    expect(tourDecisionStepKey("dashboard")).toBe(TOUR_DECISION_STEP_KEY);
    expect(tourDecisionStepKey("marketing")).toBeNull();
  });
});

describe("adaptive progress settles before automatic launch", () => {
  it("waits for a slow progress read and freezes the adapted step list", async () => {
    let releaseProgress:
      | ((value: OnboardingProgress | PromiseLike<OnboardingProgress>) => void)
      | undefined;
    const progressResponse = new Promise<OnboardingProgress>((resolve) => {
      releaseProgress = resolve;
    });
    mocks.apiGet.mockImplementation((path: string) =>
      path === DECISIONS_PATH
        ? Promise.resolve({ steps: {} })
        : progressResponse,
    );
    mocks.apiPut.mockResolvedValue({ ok: true });

    const { queryClient, root } = mount();
    try {
      await waitFor(() => {
        expect(
          mocks.apiGet.mock.calls.some(
            (call) => call[0] === "/api/v1/onboarding-progress",
          ),
        ).toBe(true);
      });

      // The decision has answered and the old provider's 600ms timer has had
      // ample time to fire. Progress is still unknown, so no unadapted tour may
      // be frozen merely because this request lost the race.
      await elapseAutoStartWindow();
      expect(probe().dataset.open).toBe("false");

      act(() => {
        releaseProgress?.(
          progress(["created_subscriber", "verified_sending_identity"]),
        );
      });
      await settled(queryClient);
      await waitForTourOpen();

      const stepIds = probe().dataset.stepIds?.split(",") ?? [];
      expect(stepIds).not.toContain("to-subscribers");
      expect(stepIds).not.toContain("to-settings");
      expect(stepIds).toContain("finish");

      // A later cache publication cannot shift this active list underneath its
      // current numeric index.
      act(() => {
        queryClient.setQueryData(
          onboardingProgressKey(
            onboardingAuthorityFromFields({
              tenantId: "tnt_1",
              userId: "usr_1",
              role: "admin",
              viewerMode: false,
            }),
          ),
          progress(),
        );
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(probe().dataset.stepIds?.split(",")).toEqual(stepIds);
    } finally {
      releaseProgress?.(progress());
      act(() => root.unmount());
    }
  });
});

describe("tour focus handoff", () => {
  it("restores the launch control after dismissal", async () => {
    serve({});
    const { queryClient, root } = mount({ autoStart: false });
    try {
      await settled(queryClient);
      const trigger = document.querySelector<HTMLButtonElement>(
        '[data-testid="probe-start"]',
      );
      expect(trigger).not.toBeNull();
      trigger?.focus();
      click("probe-start");
      await waitForTourOpen();

      // Stand in for the real overlay's initially focused primary action.
      const tooltipAction = document.createElement("button");
      document.body.append(tooltipAction);
      tooltipAction.focus();
      expect(document.activeElement).toBe(tooltipAction);

      click("probe-skip");
      await waitFor(() => expect(probe().dataset.open).toBe("false"));
      await act(async () => {
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
      });
      expect(document.activeElement).toBe(trigger);
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("same-tick tour closure", () => {
  it("records one dismissal when the close action fires twice before commit", async () => {
    serve({});
    const { queryClient, root } = mount({ autoStart: false });
    try {
      await settled(queryClient);
      click("probe-start");
      await waitForTourOpen();

      act(() => {
        const close = document.querySelector<HTMLButtonElement>(
          '[data-testid="probe-skip"]',
        );
        close?.click();
        close?.click();
      });

      await waitFor(() => expect(decisionPuts()).toHaveLength(1));
      expect(
        mocks.track.mock.calls.filter(
          (call) => call[0] === "onboarding.tour_dismissed",
        ),
      ).toHaveLength(1);
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("a decision made on another device is honoured here", () => {
  it("still launches for someone who has not decided", async () => {
    // The positive control. Without it, every "did not launch" assertion below
    // would also pass on a provider that never launches the tour at all.
    serve({});
    const { queryClient, root } = mount();
    try {
      await settled(queryClient);
      await waitForTourOpen();
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not run the tour again after a dismissal made elsewhere", async () => {
    serve({ [TOUR_DECISION_STEP_KEY]: { state: "dismissed" } });
    const { queryClient, root } = mount();
    try {
      await settled(queryClient);
      await elapseAutoStartWindow();
      // `data-has-completed` is FALSE until the decision lands, so this line is
      // what proves the assertion below ran against the server's answer rather
      // than the first paint.
      expect(probe().dataset.hasCompleted).toBe("true");
      expect(probe().dataset.open).toBe("false");
    } finally {
      act(() => root.unmount());
    }
  });

  it("honours 'not applicable to us', not only 'dismissed'", async () => {
    serve({ [TOUR_DECISION_STEP_KEY]: { state: "inapplicable" } });
    const { queryClient, root } = mount();
    try {
      await settled(queryClient);
      await elapseAutoStartWindow();
      expect(probe().dataset.hasCompleted).toBe("true");
      expect(probe().dataset.open).toBe("false");
    } finally {
      act(() => root.unmount());
    }
  });

  it("runs again after a snooze — 'show me this again' is honoured too", async () => {
    serve({ [TOUR_DECISION_STEP_KEY]: { state: "snoozed" } });
    const { queryClient, root } = mount();
    try {
      await settled(queryClient);
      await waitForTourOpen();
    } finally {
      act(() => root.unmount());
    }
  });

  it("tells the help menu the person has already been through it", async () => {
    // TourLauncher offers "Take the tour" vs "Restart tour" off `hasCompleted`.
    // A laptop that never ran the tour used to greet someone who finished it on
    // their phone that morning as though it were brand new.
    serve({ [TOUR_DECISION_STEP_KEY]: { state: "dismissed" } });
    const { queryClient, root } = mount();
    try {
      expect(probe().dataset.hasCompleted).toBe("false");
      await settled(queryClient);
      expect(probe().dataset.hasCompleted).toBe("true");
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("the tour never runs before the decision arrives", () => {
  it("waits out the launch window rather than starting and vanishing", async () => {
    // The decisions GET is left in flight for longer than the launch delay. A
    // provider that launches on the timer alone opens the tour here — and then
    // has to take it back when the dismissal lands, which is worse than the bug
    // being fixed.
    let release: ((value: unknown) => void) | null = null;
    mocks.apiGet.mockImplementation((path: string) =>
      path === DECISIONS_PATH
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(progress()),
    );

    const { queryClient, root } = mount();
    try {
      await elapseAutoStartWindow();
      expect(mocks.apiGet).toHaveBeenCalledWith(
        DECISIONS_PATH,
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          requireOnline: true,
          maxAttempts: 1,
        }),
      );
      expect(probe().dataset.open).toBe("false");

      // And it is a WAIT, not a cancellation: the answer arrives late and the
      // tour starts then.
      act(() => {
        release?.({ steps: {} });
      });
      await settled(queryClient);
      await waitForTourOpen();
    } finally {
      act(() => root.unmount());
    }
  });

  it("never closes a tour the person opened by hand", async () => {
    // The reverse flash. A late-arriving dismissal must not yank an open tour
    // off the screen — the person asked for it just now, which outranks an
    // answer they gave last week.
    let release: ((value: unknown) => void) | null = null;
    mocks.apiGet.mockImplementation((path: string) =>
      path === DECISIONS_PATH
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(progress()),
    );

    const { queryClient, root } = mount();
    try {
      click("probe-start");
      expect(probe().dataset.open).toBe("true");
      act(() => {
        release?.({
          steps: { [TOUR_DECISION_STEP_KEY]: { state: "dismissed" } },
        });
      });
      await settled(queryClient);
      expect(probe().dataset.hasCompleted).toBe("true");
      expect(probe().dataset.open).toBe("true");
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not restart under someone who already started it by hand", async () => {
    // The other half of the late arrival. Starting by hand CONSUMES the
    // automatic launch: if it did not, the decision landing mid-tour would open
    // the auto-launch window and yank them back to step one a beat later.
    let release: ((value: unknown) => void) | null = null;
    mocks.apiGet.mockImplementation((path: string) =>
      path === DECISIONS_PATH
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(progress()),
    );

    const { queryClient, root } = mount();
    try {
      click("probe-start");
      expect(probe().dataset.open).toBe("true");
      // The decision arrives and does NOT put the tour away, so the auto-launch
      // gate opens — the exact condition that would re-launch it.
      act(() => {
        release?.({ steps: {} });
      });
      await settled(queryClient);
      await elapseAutoStartWindow();
      expect(probe().dataset.open).toBe("true");
      expect(
        mocks.track.mock.calls.filter(
          (call) => call[0] === "onboarding.tour_started",
        ),
      ).toHaveLength(1);
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("a decision made here is recorded for the person", () => {
  it("writes a dismissal when the tour is skipped", async () => {
    const store = serve({});
    const { queryClient, root } = mount();
    try {
      await settled(queryClient);
      await waitForTourOpen();

      click("probe-skip");
      await waitFor(() => {
        expectDecisionWrite({
          step_key: TOUR_DECISION_STEP_KEY,
          state: "dismissed",
        });
      });
      expect(probe().dataset.open).toBe("false");
      await waitFor(() => {
        expect(store.steps[TOUR_DECISION_STEP_KEY]).toEqual({
          state: "dismissed",
        });
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("writes a dismissal when the tour is completed", async () => {
    // Finishing the tour is the canonical "completed step": no other device may
    // ask them to sit through it again.
    const store = serve({});
    const { queryClient, root } = mount();
    try {
      await settled(queryClient);
      await waitForTourOpen();

      click("probe-complete");
      await waitFor(() => {
        expectDecisionWrite({
          step_key: TOUR_DECISION_STEP_KEY,
          state: "dismissed",
        });
      });
      await waitFor(() => {
        expect(store.steps[TOUR_DECISION_STEP_KEY]).toEqual({
          state: "dismissed",
        });
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("carries a dismissal to the next device", async () => {
    // The whole point, end to end: dismiss here, and the "other device" — a
    // fresh mount with its own cache and empty local storage — does not ask.
    const store = serve({});
    const first = mount();
    try {
      await settled(first.queryClient);
      await elapseAutoStartWindow();
      click("probe-skip");
      await waitFor(() => {
        expect(store.steps[TOUR_DECISION_STEP_KEY]).toBeDefined();
      });
    } finally {
      act(() => first.root.unmount());
    }
    window.localStorage.clear();
    document.body.innerHTML = "";

    const second = mount();
    try {
      await settled(second.queryClient);
      await elapseAutoStartWindow();
      expect(probe().dataset.hasCompleted).toBe("true");
      expect(probe().dataset.open).toBe("false");
    } finally {
      act(() => second.root.unmount());
    }
  });

  it("writes a snooze on replay, not a local-only unhide", async () => {
    // Same word the checklist's "Show checklist" writes, so the two ways back
    // agree instead of each inventing one.
    serve({ [TOUR_DECISION_STEP_KEY]: { state: "dismissed" } });
    const { queryClient, root } = mount();
    try {
      await settled(queryClient);
      click("probe-replay");
      await waitFor(() => {
        expectDecisionWrite({
          step_key: TOUR_DECISION_STEP_KEY,
          state: "snoozed",
        });
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("replays every demo section after sample contacts satisfy onboarding goals", async () => {
    serve({ [TOUR_DECISION_STEP_KEY]: { state: "dismissed" } });
    const originalGet = mocks.apiGet.getMockImplementation()!;
    mocks.apiGet.mockImplementation((path: string) =>
      path === "/api/v1/onboarding-progress"
        ? Promise.resolve(
            progress(["created_subscriber", "verified_sending_identity"]),
          )
        : originalGet(path),
    );
    mocks.pathname.current = "/app/settings";
    const { queryClient, root } = mount();
    try {
      await settled(queryClient);
      click("probe-replay");
      await waitForTourOpen();
      const ids = probe().dataset.stepIds?.split(",") ?? [];
      expect(ids).toEqual(
        expect.arrayContaining([
          "to-subscribers",
          "subscriber-directory",
          "segments",
          "saved-segments",
          "sequence-drafts",
          "analytics-overview",
          "workspace-settings",
        ]),
      );
      expect(mocks.routerPush).toHaveBeenCalledWith("/app");
    } finally {
      act(() => root.unmount());
    }
  });

  it("never writes done-ness, only a decision", async () => {
    serve({});
    const { queryClient, root } = mount();
    try {
      await settled(queryClient);
      await elapseAutoStartWindow();
      click("probe-complete");
      await waitFor(() => {
        expect(mocks.apiPut).toHaveBeenCalled();
      });
      for (const body of decisionPuts()) {
        expect(body).not.toHaveProperty("completed");
        expect(body.step_key).toBe(TOUR_DECISION_STEP_KEY);
        expect([
          "dismissed",
          "snoozed",
          "skipped",
          "inapplicable",
          "delegated",
        ]).toContain(body.state);
      }
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("a dismissal made before this shipped", () => {
  it("is honoured, and promoted so the other devices stop asking", async () => {
    // The migration case. Deleting the local key would re-ask them everywhere;
    // merely keeping it would re-ask them on every OTHER device. The answer has
    // to be carried across.
    window.localStorage.setItem(LOCAL_KEY, "2026-01-01T00:00:00.000Z");
    const store = serve({});
    const first = mount();
    try {
      await settled(first.queryClient);
      await elapseAutoStartWindow();
      expect(probe().dataset.open).toBe("false");
      await waitFor(() => {
        expectDecisionWrite({
          step_key: TOUR_DECISION_STEP_KEY,
          state: "dismissed",
          reason: TOUR_DECISION_ADOPTED_REASON,
        });
      });
      await waitFor(() => {
        expect(store.steps[TOUR_DECISION_STEP_KEY]).toBeDefined();
      });
    } finally {
      act(() => first.root.unmount());
    }

    // The other device: no local key of its own, and it must not ask.
    window.localStorage.clear();
    document.body.innerHTML = "";
    const second = mount();
    try {
      await settled(second.queryClient);
      await elapseAutoStartWindow();
      expect(probe().dataset.hasCompleted).toBe("true");
      expect(probe().dataset.open).toBe("false");
    } finally {
      act(() => second.root.unmount());
    }
  });

  it("does not overwrite a real decision the person already made", async () => {
    // A recorded row — in ANY state — is a later, better-sourced answer than
    // this device's leftovers. Promoting over a `snoozed` would re-hide a tour
    // the person just asked to see again.
    window.localStorage.setItem(LOCAL_KEY, "2026-01-01T00:00:00.000Z");
    serve({ [TOUR_DECISION_STEP_KEY]: { state: "snoozed" } });
    const { queryClient, root } = mount();
    try {
      await settled(queryClient);
      await elapseAutoStartWindow();
      expect(decisionPuts()).toEqual([]);
    } finally {
      act(() => root.unmount());
    }
  });

  it("holds even when the write is refused, so it is never re-asked here", async () => {
    // The race-free version of the case above. A viewer cannot upload their
    // dismissal, so nothing will ever be recorded — and this device must still
    // honour the answer it already has instead of asking again every visit.
    window.localStorage.setItem(LOCAL_KEY, "2026-01-01T00:00:00.000Z");
    serve({});
    const { queryClient, root } = mount({ role: "viewer" });
    try {
      await settled(queryClient);
      await elapseAutoStartWindow();
      expect(decisionPuts()).toEqual([]);
      expect(probe().dataset.open).toBe("false");
    } finally {
      act(() => root.unmount());
    }
  });

  it("gives way to a newer 'show me again' from another device", async () => {
    // The direction that makes local storage a CACHE rather than the authority.
    // They dismissed the tour on this laptop, then hit "Restart tour" on their
    // phone. The server's answer is the newer one, and it wins.
    window.localStorage.setItem(LOCAL_KEY, "2026-01-01T00:00:00.000Z");
    serve({ [TOUR_DECISION_STEP_KEY]: { state: "snoozed" } });
    const { queryClient, root } = mount();
    try {
      await settled(queryClient);
      await waitForTourOpen();
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps working with no network at all", async () => {
    // Offline, the request never answers, so the gate never opens and the
    // person is not interrupted — and the local key still tells the help menu
    // they have been through it, with no server round-trip.
    window.localStorage.setItem(LOCAL_KEY, "2026-01-01T00:00:00.000Z");
    mocks.apiGet.mockRejectedValue(new Error("offline"));
    const { root } = mount();
    try {
      await elapseAutoStartWindow();
      expect(probe().dataset.open).toBe("false");
      expect(probe().dataset.hasCompleted).toBe("true");
      expect(decisionPuts()).toEqual([]);
    } finally {
      act(() => root.unmount());
    }
  });

  it("never adopts one principal's hydrated legacy answer after an identity switch", async () => {
    window.localStorage.setItem(LOCAL_KEY, "2026-01-01T00:00:00.000Z");
    let releaseA: ((value: unknown) => void) | undefined;
    const aDecision = new Promise((resolve) => {
      releaseA = resolve;
    });
    mocks.apiGet.mockImplementation((path: string) => {
      if (path === DECISIONS_PATH) {
        return mocks.identity.userId === "usr_1"
          ? aDecision
          : Promise.resolve({ steps: {} });
      }
      if (path === WHOAMI_PATH) {
        return Promise.resolve({
          user_id: mocks.identity.userId,
          tenant_id: mocks.identity.tenantId,
          role: mocks.identity.role,
          effective_role: mocks.identity.role,
          viewer_mode: mocks.identity.viewerMode,
        });
      }
      return Promise.resolve(progress());
    });

    const firstAuthority = onboardingAuthorityFromFields({
      tenantId: "tnt_1",
      userId: "usr_1",
      role: "admin",
      viewerMode: false,
    });
    const secondAuthority = onboardingAuthorityFromFields({
      tenantId: "tnt_2",
      userId: "usr_2",
      role: "editor",
      viewerMode: false,
    });
    const firstExactKey = `postwave_tour_dashboard_${encodeURIComponent(firstAuthority.key)}_completed_at`;
    const secondExactKey = `postwave_tour_dashboard_${encodeURIComponent(secondAuthority.key)}_completed_at`;

    const mounted = mount({ autoStart: false });
    try {
      await waitFor(() => {
        expect(window.localStorage.getItem(firstExactKey)).not.toBeNull();
      });
      expect(window.localStorage.getItem(LOCAL_KEY)).toBeNull();

      Object.assign(mocks.identity, {
        tenantId: "tnt_2",
        userId: "usr_2",
        role: "editor" as RoleKey,
        viewerMode: false,
      });
      act(() => {
        mounted.root.render(
          <QueryClientProvider client={mounted.queryClient}>
            <TourProvider
              tour="dashboard"
              tenantId="tnt_2"
              userId="usr_2"
              role="editor"
              viewerMode={false}
              autoStart={false}
            >
              <Probe />
            </TourProvider>
          </QueryClientProvider>,
        );
      });
      await waitFor(() => {
        expect(
          mounted.queryClient.getQueryData(
            onboardingDecisionsKey(secondAuthority),
          ),
        ).toEqual({ steps: {} });
      });

      await act(async () => {
        releaseA?.({ steps: {} });
        await Promise.resolve();
      });
      await elapseAutoStartWindow();
      expect(decisionPuts()).toEqual([]);
      expect(window.localStorage.getItem(secondExactKey)).toBeNull();
      expect(probe().dataset.hasCompleted).toBe("false");
    } finally {
      releaseA?.({ steps: {} });
      act(() => mounted.root.unmount());
    }
  });

  it("closes an active run on principal change without navigation or completion writes", async () => {
    serve({});
    const mounted = mount({ autoStart: false });
    try {
      await settled(mounted.queryClient);
      click("probe-start");
      await waitForTourOpen();

      Object.assign(mocks.identity, {
        tenantId: "tnt_2",
        userId: "usr_2",
        role: "admin" as RoleKey,
        viewerMode: false,
      });
      act(() => {
        mounted.root.render(
          <QueryClientProvider client={mounted.queryClient}>
            <TourProvider
              tour="dashboard"
              tenantId="tnt_2"
              userId="usr_2"
              role="admin"
              viewerMode={false}
              autoStart={false}
            >
              <Probe />
            </TourProvider>
          </QueryClientProvider>,
        );
      });
      await waitFor(() => expect(probe().dataset.open).toBe("false"));
      click("probe-skip");
      await act(async () => Promise.resolve());

      const secondAuthority = onboardingAuthorityFromFields({
        tenantId: "tnt_2",
        userId: "usr_2",
        role: "admin",
        viewerMode: false,
      });
      expect(
        window.localStorage.getItem(
          `postwave_tour_dashboard_${encodeURIComponent(secondAuthority.key)}_completed_at`,
        ),
      ).toBeNull();
      expect(decisionPuts()).toEqual([]);
      expect(
        mocks.track.mock.calls.some(
          (call) =>
            call[0] === "onboarding.tour_dismissed" ||
            call[0] === "onboarding.tour_completed",
        ),
      ).toBe(false);
    } finally {
      act(() => mounted.root.unmount());
    }
  });
});

describe("a write the server would refuse is not attempted", () => {
  it("records nothing for a viewer", async () => {
    // PUT /api/v1/onboarding/steps requires the editor session role, so a
    // viewer's write would 403 and roll straight back.
    serve({});
    const { queryClient, root } = mount({ role: "viewer" });
    try {
      await settled(queryClient);
      await waitForTourOpen();
      click("probe-skip");
      await elapseAutoStartWindow();
      expect(decisionPuts()).toEqual([]);
    } finally {
      act(() => root.unmount());
    }
  });

  it("still honours a viewer's own decision recorded elsewhere", async () => {
    // Reading is a viewer-level scope, so a decision made from their own
    // editor-capable session on another device still applies.
    serve({ [TOUR_DECISION_STEP_KEY]: { state: "dismissed" } });
    const { queryClient, root } = mount({ role: "viewer" });
    try {
      await settled(queryClient);
      await elapseAutoStartWindow();
      expect(probe().dataset.hasCompleted).toBe("true");
      expect(probe().dataset.open).toBe("false");
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("the signed-out marketing tour is untouched", () => {
  it("asks for no decision and needs no query client", async () => {
    // The marketing layout mounts TourProvider OUTSIDE any QueryClientProvider,
    // so a decision hook in the provider body would crash every signed-out
    // page. There is also no (tenant, user) to record a decision for.
    serve({});
    mocks.pathname.current = "/";
    const { root } = mount({
      tour: "marketing",
      tenantId: undefined,
      role: null,
      withQueryClient: false,
    });
    try {
      await elapseAutoStartWindow();
      expect(mocks.apiGet).not.toHaveBeenCalled();
      // And it is not gated into never running.
      expect(probe().dataset.open).toBe("true");
    } finally {
      act(() => root.unmount());
    }
  });

  it("still honours its own local key", async () => {
    // Its local key is the only answer it can ever have, so the gate must keep
    // reading it rather than treating "no decision recorded" as "never asked".
    serve({});
    mocks.pathname.current = "/";
    window.localStorage.setItem(
      "postwave_tour_marketing_completed_at",
      "2026-01-01T00:00:00.000Z",
    );
    const { root } = mount({
      tour: "marketing",
      tenantId: undefined,
      role: null,
      withQueryClient: false,
    });
    try {
      await elapseAutoStartWindow();
      expect(probe().dataset.open).toBe("false");
    } finally {
      act(() => root.unmount());
    }
  });
});
