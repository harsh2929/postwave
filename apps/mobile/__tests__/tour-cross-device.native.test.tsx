/**
 * The dashboard tour asks once per PERSON, not once per device.
 *
 * All three clients used to keep their own
 * `postwave_tour_dashboard_dismissed_at`, so someone skipped the tour on their
 * laptop, opened the phone, and it ran again. The decision now lives on the
 * server under the shared `dashboard_tour` step key, and this file pins the two
 * halves of that at the PROVIDER level, where the resolver's own unit tests
 * (src/lib/onboardingDecisions.test.ts) cannot reach:
 *
 *   1. auto-launch is gated on the shared decision, not on this device's key;
 *   2. the tour does NOT open while that decision is still in flight — the
 *      pre-load state is closed, because opening the tour and yanking it away
 *      a moment later is worse than opening it a beat late.
 *
 * The resolver is mocked with a DEFERRED promise on purpose. Resolving it
 * before the first render would assert (2) against a state that is already
 * true on frame zero and prove nothing; here the timers run all the way past
 * the 600ms auto-launch defer while the decision is still pending — precisely
 * the window the old device-local code launched in — and the same test then
 * resolves it and watches the tour open, so the earlier absence cannot be
 * satisfied by a tour that never opens at all.
 *
 * The provider is imported by RELATIVE path: `@/components/tour/TourProvider`
 * is mapped to a stub for the route suites, and this is the one file that needs
 * the real state machine.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { act, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { AccessibilityInfo, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as ReactQuery from "@tanstack/react-query";

const mockIsTourDismissed = jest.fn<() => Promise<boolean>>();
const mockDismissTour = jest.fn<() => Promise<void>>(async () => undefined);
const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};

jest.mock("@/lib/onboardingDecisions", () => ({
  TOUR_DISMISSED_AT_KEY: "postwave_tour_dashboard_dismissed_at",
  TOUR_STEP_KEY: "dashboard_tour",
  isTourDismissed: () => mockIsTourDismissed(),
  dismissTour: () => mockDismissTour(),
}));

// The route Jest config maps workspace packages to a generic proxy whose
// functions return undefined. This provider test supplies the real contract
// shape needed by its adaptive-step branch; the one-step fixture has no goal
// gate, so identity is the exact result the real `adaptiveSteps` returns.
jest.mock("@postwave/onboarding-schema", () => ({
  adaptiveSteps: <T,>(steps: readonly T[]) => [...steps],
  // onboarding-schema and telemetry share one generic Jest mapper target, so
  // overriding the former must preserve the latter's event-name surface.
  EVENTS: new Proxy({}, { get: (_target, property) => String(property) }),
}));

/**
 * The overlay is stubbed, and not to make anything pass.
 *
 * WHAT this file tests is whether the tour DECIDES to run, which lives
 * entirely in the provider; the spotlight is a separate concern with its own
 * surface. Rendering it here also cannot work under the shared reanimated
 * mock: `useSharedValue` hands back a fresh object on every render, so the
 * overlay's measure effect — which lists those values as deps and calls
 * setRect with a freshly built rect — re-fires forever and takes the worker
 * out of memory. That is a mock artifact, not a product bug (the real library
 * returns a stable object), and it is why the route suites stub the tour
 * wholesale. This file stubs one component instead so the real state machine
 * still runs.
 */
jest.mock("../src/components/tour/TourOverlay", () => ({
  TourOverlay: () => null,
}));

// eslint-disable-next-line import/first
import {
  TOUR_STORAGE_KEYS,
  TourProvider,
  useTour,
} from "../src/components/tour/TourProvider";
// eslint-disable-next-line import/first
import type { TourContextValue, TourStep } from "../src/components/tour/types";

const STEPS = [
  { id: "welcome", title: "Welcome", body: "A short walk through Moosewave." },
] as unknown as readonly TourStep[];

function progress(completed: number) {
  return {
    steps: [],
    completed,
    total: 4,
    percent: completed * 25,
    all_done: completed === 4,
  };
}

function progressQuery(
  data: ReturnType<typeof progress> | undefined,
  state: "pending" | "success" | "error",
) {
  return {
    data,
    error: state === "error" ? new Error("endpoint unavailable") : null,
    isError: state === "error",
    isFetching: state === "pending",
    isLoading: state === "pending",
    isPending: state === "pending",
    isSuccess: state === "success",
    refetch: jest.fn(async () => ({ data })),
  };
}

/** Surfaces the tour's open/closed state, and hands the test its controls. */
let ctx: TourContextValue | null = null;
function Probe() {
  const tour = useTour();
  ctx = tour;
  return <View testID={tour.active ? "tour-open" : "tour-closed"} />;
}

function Harness({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      {children}
    </SafeAreaProvider>
  );
}

function tourNode() {
  return (
    <Harness>
      <TourProvider steps={STEPS} ready>
        <Probe />
      </TourProvider>
    </Harness>
  );
}

/** Mount the real provider. Awaited — the overlay mounts inside act. */
function mountTour() {
  return render(tourNode());
}

/** A promise whose resolution this test controls. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Let every pending microtask (the provider's async hydrate) settle.
 *
 * A tick or two is NOT enough, and the shortfall is silent: the hydrate awaits
 * a Promise.all of three reads before it ever reaches the decision, so a short
 * flush leaves the resolver un-called and every assertion about what it
 * returned passes vacuously. Microtasks ignore fake timers, so draining
 * generously is free.
 */
async function flush() {
  await act(async () => {
    for (let tick = 0; tick < 25; tick += 1) {
      await Promise.resolve();
    }
  });
}

/** Run past the 600ms auto-launch defer. */
async function runAutoLaunchTimer() {
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
}

beforeEach(async () => {
  ctx = null;
  await AsyncStorage.clear();
  mockIsTourDismissed.mockReset();
  mockDismissTour.mockReset();
  mockDismissTour.mockResolvedValue(undefined);
  // Preserve the provider's historical fail-soft baseline for the shared-
  // dismissal tests below. Individual precedence tests override this with a
  // pending or successful progress read.
  queryHarness.__setQueryResultForTests(
    progressQuery(undefined, "error"),
  );
  // Reduced-motion is read in the SAME Promise.all as the storage keys, and
  // the real AccessibilityInfo answers through the native bridge — which fake
  // timers stall, because they fake setImmediate too. Left alone the hydrate
  // never finishes, the decision is never requested, and every assertion here
  // passes for the wrong reason. Pinned rather than worked around: this file
  // is about the decision, not about a11y state.
  jest
    .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
    .mockResolvedValue(false);
  jest
    .spyOn(AccessibilityInfo, "addEventListener")
    .mockReturnValue({ remove: () => undefined } as never);
  jest.useFakeTimers();
});

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  jest.useRealTimers();
});

describe("first-run overlay precedence", () => {
  it("waits while onboarding progress is pending", async () => {
    queryHarness.__setQueryResultForTests(
      progressQuery(undefined, "pending"),
    );
    mockIsTourDismissed.mockResolvedValue(false);

    const view = await mountTour();
    await flush();
    await runAutoLaunchTimer();

    expect(screen.getByTestId("tour-closed")).toBeTruthy();
    expect(mockIsTourDismissed).not.toHaveBeenCalled();

    // Settling non-empty must launch. Without this second half, a provider
    // that simply disabled automatic tours forever would satisfy the wait.
    queryHarness.__setQueryResultForTests(progressQuery(progress(1), "success"));
    await view.rerender(tourNode());
    await flush();
    await runAutoLaunchTimer();
    expect(screen.getByTestId("tour-open")).toBeTruthy();
  });

  it("suppresses auto-launch for an authoritative empty workspace", async () => {
    queryHarness.__setQueryResultForTests(progressQuery(progress(0), "success"));
    mockIsTourDismissed.mockResolvedValue(false);

    await mountTour();
    await flush();
    await runAutoLaunchTimer();

    expect(screen.getByTestId("tour-closed")).toBeTruthy();
    expect(mockIsTourDismissed).not.toHaveBeenCalled();
  });

  it("retains fail-soft auto-launch when the progress endpoint fails", async () => {
    queryHarness.__setQueryResultForTests(progressQuery(undefined, "error"));
    mockIsTourDismissed.mockResolvedValue(false);

    await mountTour();
    await flush();
    await runAutoLaunchTimer();

    expect(screen.getByTestId("tour-open")).toBeTruthy();
  });

  it("does not wait forever when the progress query cannot start", async () => {
    queryHarness.__setQueryResultForTests({
      ...progressQuery(undefined, "pending"),
      // TanStack's disabled/paused initial state: status is pending, but no
      // request is loading. This is the offline-gate equivalent of fail-soft.
      isFetching: false,
      isLoading: false,
    });
    mockIsTourDismissed.mockResolvedValue(false);

    await mountTour();
    await flush();
    await runAutoLaunchTimer();

    expect(screen.getByTestId("tour-open")).toBeTruthy();
  });

  it("auto-launches for a returning non-empty workspace", async () => {
    queryHarness.__setQueryResultForTests(progressQuery(progress(1), "success"));
    mockIsTourDismissed.mockResolvedValue(false);

    await mountTour();
    await flush();
    await runAutoLaunchTimer();

    expect(screen.getByTestId("tour-open")).toBeTruthy();
  });

  it("keeps manual Replay available after empty-workspace suppression", async () => {
    queryHarness.__setQueryResultForTests(progressQuery(progress(0), "success"));
    mockIsTourDismissed.mockResolvedValue(false);

    await mountTour();
    await flush();
    await runAutoLaunchTimer();
    expect(screen.getByTestId("tour-closed")).toBeTruthy();

    await act(async () => {
      ctx?.start();
    });

    expect(screen.getByTestId("tour-open")).toBeTruthy();
  });
});

describe("the tour waits for the shared decision", () => {
  it("stays closed while the decision is in flight, then opens", async () => {
    const gate = deferred<boolean>();
    mockIsTourDismissed.mockReturnValue(gate.promise);

    await mountTour();

    // Past the auto-launch defer — the exact window the device-local code
    // would have launched in — and still nothing. This is the no-flash rule:
    // a tour that appears and vanishes is worse than one that appears late.
    await flush();
    await runAutoLaunchTimer();
    expect(screen.queryByTestId("tour-open")).toBeNull();
    expect(screen.getByTestId("tour-closed")).toBeTruthy();

    // The answer arrives: nobody has put this tour away.
    await act(async () => {
      gate.resolve(false);
      await gate.promise;
    });
    await flush();
    await runAutoLaunchTimer();

    // …and NOW it opens. Without this half, the assertion above would be
    // satisfied by a tour that can never open at all.
    expect(screen.getByTestId("tour-open")).toBeTruthy();
  });

  it("never runs a tour the person already skipped on another device", async () => {
    // This device has nothing in AsyncStorage — the skip happened on a laptop.
    expect(
      await AsyncStorage.getItem(TOUR_STORAGE_KEYS.dismissedAt),
    ).toBeNull();
    mockIsTourDismissed.mockResolvedValue(true);

    await mountTour();
    await flush();
    await runAutoLaunchTimer();
    await flush();

    expect(mockIsTourDismissed).toHaveBeenCalled();
    expect(screen.queryByTestId("tour-open")).toBeNull();
  });

  it("does not ask at all when this device already finished the tour", async () => {
    // A returning user must not pay a round trip for an answer nothing reads.
    await AsyncStorage.setItem(
      TOUR_STORAGE_KEYS.completedAt,
      "2026-01-02T03:04:05.000Z",
    );
    mockIsTourDismissed.mockResolvedValue(false);

    await mountTour();
    await flush();
    await runAutoLaunchTimer();

    expect(mockIsTourDismissed).not.toHaveBeenCalled();
    expect(screen.queryByTestId("tour-open")).toBeNull();
  });
});

describe("skipping is recorded for every device", () => {
  it("routes the skip through the shared decision writer", async () => {
    mockIsTourDismissed.mockResolvedValue(false);

    await mountTour();
    await flush();
    await runAutoLaunchTimer();
    expect(screen.getByTestId("tour-open")).toBeTruthy();

    await act(async () => {
      ctx?.skip();
    });
    await flush();

    // Writing only the local key was the bug: it left the other two surfaces
    // asking a question this person had just answered.
    expect(mockDismissTour).toHaveBeenCalled();
    expect(screen.queryByTestId("tour-open")).toBeNull();
  });
});
