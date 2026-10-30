// @vitest-environment happy-dom
//
// The dashboard tour asked a question that had already been answered.
//
// Every client kept `postwave_tour_dashboard_dismissed_at` in its own local
// storage, so a person dismissed the tour on their laptop, opened the phone,
// and it ran again — once per device, forever. Moving the decision to
// `GET/PUT /api/v1/onboarding/steps` fixes that, but only if the tour WAITS for
// it: a device that has never toured reads `not-started` from its own cache,
// which is indistinguishable from "never dismissed" until the answer arrives.
//
// So there are two failures to prevent, and the second is the nastier one:
//   1. the tour runs on a device where the person already dismissed it, and
//   2. the tour runs for a moment and is then torn away when the decision
//      lands, which is worse than (1) because it looks like a bug in the app.
//
// These tests exercise the REAL hook, the REAL controller and the REAL
// provider, with only the transport faked, because the gate is only worth
// anything at the seam where those three meet.

import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TOUR_DECISION_STEP_KEY } from "@postwave/onboarding-schema";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  set: vi.fn(),
  navigate: vi.fn(),
  // A workspace that has finished its first send. The tour deliberately waits
  // for the setup wizard to settle before it auto-opens, so a half-set-up
  // workspace would keep the tour shut for a reason that has nothing to do with
  // the decision under test.
  progress: {
    steps: [],
    completedStepIds: [
      "verify-domain",
      "import-subscribers",
      "send-first-campaign",
    ] as string[],
    completion: 60,
    ratio: { done: 3, total: 5 },
    done: false,
    dismissed: false,
    applicable: true,
    available: true,
    liveConfirmed: true,
    loading: false,
    refreshing: false,
    failed: false,
    stale: false,
    retry: () => undefined,
    dismiss: () => undefined,
    restore: () => undefined,
    skipStep: () => undefined,
  },
}));

vi.mock("../../lib/api-client", () => ({
  onboardingDecisionsApi: { list: mocks.list, set: mocks.set },
}));

vi.mock("../../hooks/useOnboardingProgress", () => ({
  useOnboardingProgress: () => mocks.progress,
}));

vi.mock("../../lib/desktop-router", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  navigateDesktopRoute: mocks.navigate,
}));

vi.mock("../../lib/onboarding-analytics", () => ({
  emitOnboardingAnalyticsIntent: vi.fn(),
}));

const { TourProvider, useTour } = await import(
  "../../components/tour/TourProvider"
);
const { resetOnboardingStateForTests } = await import(
  "../../hooks/useOnboardingState"
);
const { setMe } = await import("../../lib/store");

/**
 * Reads the one predicate that decides whether the tour is on screen:
 * `TourProvider` renders the spotlight and the tooltip if and only if this is
 * true, so a marker driven by it is the tour running, not a proxy for it.
 */
function TourProbe(): ReactElement {
  const tour = useTour();
  const [started, setStarted] = useState(false);
  return (
    <div>
      <span data-testid="tour-state">{tour.isOpen ? "open" : "closed"}</span>
      <button
        type="button"
        onClick={() => {
          setStarted(true);
          tour.start();
        }}
      >
        {started ? "Started" : "Start tour"}
      </button>
    </div>
  );
}

let container: HTMLDivElement;
let root: Root;

function tourState(): string {
  return (
    container.querySelector('[data-testid="tour-state"]')?.textContent ?? ""
  );
}

/** Let pending promise callbacks and the renders they cause both land. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Push past the provider's deliberate 600ms settle before it auto-opens. */
async function advancePastAutoOpen(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
  });
}

function render(): void {
  act(() => {
    root.render(
      <TourProvider>
        <TourProbe />
      </TourProvider>,
    );
  });
}

/** A `list()` whose resolution this test controls, like a slow network. */
function deferredDecisions(): (steps: Record<string, unknown>) => void {
  let settle: (value: unknown) => void = () => undefined;
  mocks.list.mockReturnValue(
    new Promise((resolve) => {
      settle = resolve;
    }),
  );
  return (steps) => settle({ data: { steps } });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetOnboardingStateForTests();
  window.localStorage.clear();
  mocks.list.mockReset().mockResolvedValue({ data: { steps: {} } });
  mocks.set.mockReset().mockResolvedValue({ data: { ok: true } });
  mocks.navigate.mockReset();
  setMe({
    user: "user-tour",
    tenant: "ws-tour",
    role: "admin",
    effectiveRole: "admin",
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setMe(null);
  resetOnboardingStateForTests();
  window.localStorage.clear();
  vi.useRealTimers();
});

describe("the tour waits for the answer instead of guessing", () => {
  it("stays shut while the decision is in flight, and stays shut once it says dismissed", async () => {
    const resolveDecisions = deferredDecisions();
    render();

    // The window in which the old code ran the tour: local storage says
    // `not-started` because this device has never toured, and the dismissal is
    // still on the wire.
    await advancePastAutoOpen();
    expect(tourState()).toBe("closed");

    resolveDecisions({ [TOUR_DECISION_STEP_KEY]: { state: "dismissed" } });
    await flush();
    await advancePastAutoOpen();

    expect(tourState()).toBe("closed");
  });

  it("runs the tour once the decision comes back empty", async () => {
    // The other half, and the half that stops the gate from being a way to
    // switch onboarding off: `closed` here is FALSE before the query resolves
    // and TRUE after, so the transition is what is being asserted.
    const resolveDecisions = deferredDecisions();
    render();

    await advancePastAutoOpen();
    expect(tourState()).toBe("closed");

    resolveDecisions({});
    await flush();
    await advancePastAutoOpen();

    expect(tourState()).toBe("open");
  });

  it("keeps a tour dismissed elsewhere shut for good, not just once", async () => {
    mocks.list.mockResolvedValue({
      data: { steps: { [TOUR_DECISION_STEP_KEY]: { state: "dismissed" } } },
    });
    render();
    await flush();
    await advancePastAutoOpen();

    expect(tourState()).toBe("closed");
    expect(window.localStorage.length).toBeGreaterThan(0);
  });

  it("still runs a tour the person asks for by hand while the fetch hangs", async () => {
    // The gate answers "has this been decided?", and a person clicking Start is
    // deciding right now. Blocking that would turn a slow request into a dead
    // button.
    deferredDecisions();
    render();
    await advancePastAutoOpen();
    expect(tourState()).toBe("closed");

    const start = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Start tour"),
    );
    expect(start).toBeTruthy();
    await act(async () => {
      start?.click();
      await Promise.resolve();
    });

    expect(tourState()).toBe("open");
  });

  it("falls back to the local cache when the decision cannot be fetched", async () => {
    // Offline is not "dismissed" and it is not "suppress onboarding forever"
    // either — local storage is still the best answer available.
    mocks.list.mockResolvedValue({ error: { message: "offline" } });
    render();
    await flush();
    await advancePastAutoOpen();

    expect(tourState()).toBe("open");
  });
});

describe("a tour decided here is recorded for the person", () => {
  it("publishes the dismissal when the tour is skipped away", async () => {
    mocks.list.mockResolvedValue({ data: { steps: {} } });
    render();
    await flush();
    await advancePastAutoOpen();
    expect(tourState()).toBe("open");

    const skip = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.trim().startsWith("Skip"),
    );
    expect(skip).toBeTruthy();
    await act(async () => {
      skip?.click();
      await Promise.resolve();
    });
    const confirm = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Skip tour",
    );
    await act(async () => {
      confirm?.click();
      await Promise.resolve();
    });

    expect(tourState()).toBe("closed");
    expect(mocks.set).toHaveBeenCalledWith(TOUR_DECISION_STEP_KEY, "skipped");
  });
});
