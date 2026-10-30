/**
 * What a clock is allowed to cost while a screen sits open.
 *
 * `useTickingNow` exists because a "how old is this?" badge needs a re-render
 * to age, and it is already gated twice — on the caller's focus flag and on
 * AppState — so it does not tick off-screen or in the background. Neither gate
 * asks the third question: does a new value change anything a reader can see.
 *
 * Almost every caller feeds `now` into `relativeTime`, whose finest unit is the
 * MINUTE. At 1 Hz that is 59 wasted renders out of every 60 — of the whole
 * screen, of its filter/sort memo, and (because `now` is a row prop) of every
 * `React.memo`'d row on it, which is precisely the memo-defeating shape the
 * lookalike list was fixed for in `list-render-cost.native.test.tsx`.
 *
 * Measured on `app/(tabs)/agent-routines` with 30 routines loaded and 10 rows
 * in the render window, over 180 seconds of focused idle time:
 *
 *     raw 1 Hz clock   1,800 clock-driven row renders
 *     MINUTE_MS clock     20 clock-driven row renders
 *
 * Two claims are pinned below, and the second is what keeps the first honest:
 * a clock frozen at mount would satisfy any render CEILING while quietly
 * stopping "Overdue" from ever appearing.
 *
 * The default resolution is asserted too, as the measurement's vacuity floor —
 * if the harness could not see a 1 Hz clock at all, the minute assertion would
 * pass for the wrong reason.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import React, { type ReactNode } from "react";
import { AppState, Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as QueryHooks from "@/hooks/useOnlineQueryGate";
import { MINUTE_MS, useTickingNow } from "@/hooks/useTickingNow";
import { parseRoutine, type AgentRoutine } from "@/lib/agentRoutines";

import AgentRoutines from "../app/(tabs)/agent-routines";

/**
 * The row is replaced by a recorder rather than counted through its real
 * `React.memo`, for the reason the lookalike case documents: what the screen
 * controls is how often it hands the row a CHANGED `now`, and asserting on
 * that keeps the test independent of the stand-in also being memoised.
 */
const routineRowProps: Record<string, unknown>[] = [];
jest.mock("@/components/agent-routines/AgentRoutineRow", () => ({
  AgentRoutineRow: (props: Record<string, unknown>) => {
    routineRowProps.push(props);
    return null;
  },
}));

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};
const gateHarness = QueryHooks as unknown as {
  __resetOnlineGateForTests: () => void;
};

const T0 = Date.parse("2026-08-22T10:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const RUN_SECONDS = 180;

/**
 * jest-expo leaves `AppState.currentState` as a mock FUNCTION, which is truthy
 * but never `"active"` — so the hook's second gate holds the interval shut and
 * every render count in this file would read zero. Stubbing it is what makes
 * the measurement possible at all, not a convenience.
 */
function foregroundTheApp() {
  (AppState as { currentState: string }).currentState = "active";
  jest
    .spyOn(AppState, "addEventListener")
    .mockReturnValue({ remove: () => undefined } as ReturnType<
      typeof AppState.addEventListener
    >);
}

afterEach(() => {
  jest.useRealTimers();
  queryHarness.__resetQueryResultForTests();
  gateHarness.__resetOnlineGateForTests();
});

function wrapper({ children }: { children: ReactNode }) {
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

/* ------------------------------------------------------------------ *
 * 1. The hook itself: renders per minute, not per second.
 * ------------------------------------------------------------------ */

/**
 * Two probes rather than one with a branch: a conditional hook call would be
 * the very thing the rules-of-hooks lint exists to stop, and the point of the
 * pair is that the DEFAULT argument is exercised as written at 19 call sites.
 */
function minuteProbe() {
  const seen: number[] = [];
  function Probe() {
    const now = useTickingNow(true, MINUTE_MS);
    seen.push(now);
    return <Text>{String(now)}</Text>;
  }
  return { seen, Probe };
}

function defaultProbe() {
  const seen: number[] = [];
  function Probe() {
    const now = useTickingNow(true);
    seen.push(now);
    return <Text>{String(now)}</Text>;
  }
  return { seen, Probe };
}

async function tickThrough(seconds: number) {
  for (let i = 0; i < seconds; i += 1) {
    await jest.advanceTimersByTimeAsync(1000);
  }
}

describe("the ticking clock's render budget", () => {
  it("re-renders once per minute boundary at MINUTE_MS, not once per second", async () => {
    foregroundTheApp();
    jest.useFakeTimers();
    jest.setSystemTime(new Date(T0));
    const { seen, Probe } = minuteProbe();

    await render(<Probe />);
    await tickThrough(RUN_SECONDS);

    // Vacuity floor: the clock has to have moved at all — see the next test
    // for the version of this that a frozen clock cannot pass.
    expect(seen.length).toBeGreaterThan(1);
    // Three minutes of wall time, at most one render per boundary crossed.
    expect(seen.length).toBeLessThanOrEqual(RUN_SECONDS / 60 + 1);
  });

  it("still ages the value once the minute rolls over", async () => {
    foregroundTheApp();
    jest.useFakeTimers();
    jest.setSystemTime(new Date(T0));
    const { seen, Probe } = minuteProbe();

    await render(<Probe />);
    await tickThrough(RUN_SECONDS);

    // A clock frozen at mount satisfies every ceiling in this file. It must
    // still produce a distinct value for each minute that passed, and each of
    // those must be a whole minute — the bucket is what callers reason about.
    const distinct = [...new Set(seen)];
    expect(distinct.length).toBeGreaterThanOrEqual(RUN_SECONDS / 60);
    for (const value of distinct) expect(value % MINUTE_MS).toBe(0);
  });

  it("leaves the default resolution ticking every second", async () => {
    foregroundTheApp();
    jest.useFakeTimers();
    jest.setSystemTime(new Date(T0));
    const { seen, Probe } = defaultProbe();

    await render(<Probe />);
    await tickThrough(RUN_SECONDS);

    // The measurement's own floor: this harness CAN see a 1 Hz clock, so the
    // minute assertions above are a real reduction rather than a broken probe.
    // It is also the contract for the callers that must keep sub-minute
    // resolution — the dashboard's 90-second "Live" badge, the audit sink's
    // `<1m` cooldown, an approval's expiry (which gates the Approve button).
    expect(seen.length).toBeGreaterThanOrEqual(RUN_SECONDS);
  });
});

/* ------------------------------------------------------------------ *
 * 2. The screen: how much of that reaches the rows.
 * ------------------------------------------------------------------ */

function routines(count: number): AgentRoutine[] {
  return Array.from(
    { length: count },
    (_, i) =>
      parseRoutine({
        id: `r-${i}`,
        name: `Routine ${i}`,
        prompt: "Draft a win-back campaign for subscribers idle 90 days",
        kind: "draft_campaign",
        schedule: i % 2 ? "weekly" : "daily",
        require_approval: true,
        enabled: true,
        last_run_at: new Date(T0 - (i + 1) * DAY_MS).toISOString(),
        created_by: "ops@example.test",
        created_at: "2026-06-01T09:00:00Z",
      })!,
  );
}

function loaded(rows: readonly unknown[]) {
  return {
    data: rows,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: rows })),
  };
}

describe("the routines list's idle cost", () => {
  it("does not re-render its rows once a second for a label that moves once a minute", async () => {
    foregroundTheApp();
    jest.useFakeTimers();
    jest.setSystemTime(new Date(T0));
    queryHarness.__setQueryResultForTests(loaded(routines(30)));
    routineRowProps.length = 0;

    await render(<AgentRoutines />, { wrapper });
    const onMount = routineRowProps.length;
    // Vacuity floor: rows must have rendered, and the list must be
    // virtualizing rather than mounting all thirty.
    expect(onMount).toBeGreaterThan(0);
    expect(onMount).toBeLessThan(30);

    await tickThrough(RUN_SECONDS);
    const fromTheClock = routineRowProps.length - onMount;

    // The raw 1 Hz clock produced 1,800 here (10 rows x 180 ticks). The
    // ceiling is a boundary's worth of rows per minute, with slack for the
    // window growing; anything near 1,800 means the screen went back to
    // asking for second resolution.
    expect(fromTheClock).toBeLessThanOrEqual(onMount * (RUN_SECONDS / 60 + 1));

    // ...and the rows must still HAVE aged: a clock frozen at mount would
    // satisfy the ceiling and silently stop "Overdue" ever appearing.
    const first = routineRowProps[0]!.now;
    const last = routineRowProps.at(-1)!.now;
    expect(last).not.toBe(first);
  });
});
