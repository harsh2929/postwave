// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The wait the page tests share (./_wait.ts). Every page test that waits on a
// next/dynamic panel relies on these properties, so they are pinned here
// instead of being inferred from the page suites passing.

import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, TestRunner } from "vitest";

import {
  currentTaskClock,
  importBeforeTests,
  readClocks,
  TEST_TIMEOUT_HEADROOM_MS,
  WAIT_DEADLINE_MS,
  testTimeoutCap,
  turnWithin,
  waitFor,
  type TurnClock,
} from "./_wait";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`rejected with a non-Error: ${String(error)}`);
  }
  throw new Error("expected the wait to reject, but it resolved");
}

async function sleep(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

// Commits its label from a timer, the way a query or a lazily loaded chunk
// lands: after mount, outside any act() the test itself opened.
function LateLabel() {
  const [label, setLabel] = useState("loading");
  useEffect(() => {
    const timer = window.setTimeout(() => setLabel("ready"), 40);
    return () => window.clearTimeout(timer);
  }, []);
  return createElement("p", null, label);
}

let root: Root | null = null;

afterEach(() => {
  if (root) {
    const mounted = root;
    act(() => {
      mounted.unmount();
    });
    root = null;
  }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("waitFor (shared page-test wait)", () => {
  it("keeps its budget and headroom inside the timeout the suite runs tests with", ({
    task,
  }) => {
    expect(WAIT_DEADLINE_MS + TEST_TIMEOUT_HEADROOM_MS).toBeLessThanOrEqual(
      task.timeout,
    );
  });

  it("returns once the assertion holds, committing the late update inside act()", async () => {
    const consoleError = vi.spyOn(console, "error");
    const container = document.createElement("div");
    document.body.append(container);
    const mounted = createRoot(container);
    root = mounted;
    act(() => {
      mounted.render(createElement(LateLabel));
    });
    expect(container.textContent).toBe("loading");

    let calls = 0;
    await waitFor(() => {
      calls += 1;
      expect(container.textContent).toBe("ready");
    });

    expect(calls).toBeGreaterThan(1);
    const actWarnings = consoleError.mock.calls.filter((args) =>
      args.some((arg) => String(arg).includes("not wrapped in act")),
    );
    expect(actWarnings).toEqual([]);
  });

  it("rethrows the assertion's last error, with the elapsed time, once its budget is spent", async () => {
    let calls = 0;
    const startedAt = Date.now();
    const error = await rejectionOf(
      waitFor(
        () => {
          calls += 1;
          expect(`attempt ${calls}`).toBe("never");
        },
        { timeoutMs: 200 },
      ),
    );

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
    // The last attempt's error, not the first one's, and still the assertion's
    // own error, so the reporter keeps its expected/actual diff.
    expect(error.message).toContain(`'attempt ${calls}'`);
    expect((error as Error & { actual?: unknown }).actual).toBe(
      `attempt ${calls}`,
    );
    expect(error.message).toMatch(
      new RegExp(
        `\\n\\nwaitFor gave up after \\d+ ms and ${calls} attempts \\(budget 200 ms\\)\\.$`,
      ),
    );
    expect(calls).toBeGreaterThan(1);
  });

  it("never calls the assertion again once it has given up", async () => {
    let calls = 0;
    await rejectionOf(
      waitFor(
        () => {
          calls += 1;
          throw new Error("still loading");
        },
        { timeoutMs: 100 },
      ),
    );
    const callsAtGiveUp = calls;

    await sleep(150);

    expect(calls).toBe(callsAtGiveUp);
  });

  it("abandons a turn that never settles when the deadline passes", async () => {
    let calls = 0;
    const startedAt = Date.now();
    const error = await rejectionOf(
      waitFor(
        () => {
          calls += 1;
          throw new Error("still loading");
        },
        { timeoutMs: 150, step: () => new Promise<void>(() => {}) },
      ),
    );

    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(WAIT_DEADLINE_MS);
    // One attempt, the stuck turn, then one last attempt at the deadline.
    expect(calls).toBe(2);
    expect(error.message).toMatch(
      /^still loading\n\nwaitFor gave up after \d+ ms and 2 attempts \(budget 150 ms\)\.$/,
    );

    // The stuck turn's act() scope closed with it. A scope left open would
    // hold every later act() in its queue, and this render would never commit.
    const container = document.createElement("div");
    document.body.append(container);
    const mounted = createRoot(container);
    root = mounted;
    await act(async () => {
      mounted.render(createElement("p", null, "still flushing"));
    });
    expect(container.textContent).toBe("still flushing");
  });

  // The test above, many times over on the real clock. A Node timer can run a
  // millisecond before Date.now() reaches the time it was armed for (the test
  // above got one in 6 of 102 loaded runs). A wait that took such a timer as
  // the deadline either ran a spare turn and a spare attempt or gave up a
  // millisecond short of its budget. Neither may happen in any run here.
  it("gives up on a stuck turn only once the deadline has passed, and with no spare turn, every time", { timeout: 10_000 }, async () => {
    for (let run = 0; run < 20; run += 1) {
      let calls = 0;
      let turns = 0;
      const startedAt = Date.now();
      const error = await rejectionOf(
        waitFor(
          () => {
            calls += 1;
            throw new Error("still loading");
          },
          {
            timeoutMs: 25,
            step: () => {
              turns += 1;
              return new Promise<void>(() => {});
            },
          },
        ),
      );

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
      // The stuck turn, then one last attempt. (A host that stalls this
      // process for the whole 25 ms before the first attempt returns leaves
      // no time for the turn, and the first attempt is the last.)
      expect(turns).toBeLessThanOrEqual(1);
      expect(calls).toBe(turns + 1);
      expect(error.message).toContain(` and ${calls} attempts (budget 25 ms).`);
    }
  });

  it("refuses an assertion that returns a promise, whose rejection it could not see", async () => {
    const error = await rejectionOf(
      waitFor(async () => {
        await Promise.resolve();
        throw new Error("this failure would be lost");
      }),
    );

    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toContain("synchronous assertion");
  });

  it("cuts a wait to the time its test has left, so the assertion fails before the test times out", { timeout: 1_500 }, async () => {
    const startedAt = Date.now();
    const error = await rejectionOf(
      waitFor(
        () => {
          throw new Error("still loading");
        },
        { timeoutMs: 60_000 },
      ),
    );

    expect(error.message).toMatch(
      /^still loading\n\nwaitFor gave up after \d+ ms and \d+ attempts \(budget 60000 ms, cut to \d+ ms by the 1500 ms timeout it runs under\)\.$/,
    );
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });
});

// vitest arms a test's timeout when it invokes the body, after the beforeEach
// hooks. The cap used to count from result.startTime, which vitest stamps
// before those hooks, so here a wait lost the whole 1.5 s the hook took.
describe("waitFor after a slow beforeEach", () => {
  const HOOK_MS = 1_500;
  const TIMEOUT_MS = 3_000;
  let hookClockTimeout: number | undefined;

  beforeEach(async () => {
    // Inside a hook, the clock is the hook's own.
    hookClockTimeout = currentTaskClock()?.timeoutMs;
    await new Promise((resolve) => setTimeout(resolve, HOOK_MS));
  });

  it("measures the test's time from the body's start, not from before its hooks", { timeout: TIMEOUT_MS }, async ({ task }) => {
    const bodyStartedAt = Date.now();
    const clock = currentTaskClock();
    expect(clock?.timeoutMs).toBe(TIMEOUT_MS);
    expect(hookClockTimeout).not.toBe(TIMEOUT_MS);
    expect(hookClockTimeout).toBeGreaterThan(0);
    // result.startTime predates the hook. (A timer can land a millisecond
    // short of its delay on Date.now(), hence the small allowance.)
    expect(
      bodyStartedAt - (task.result?.startTime ?? bodyStartedAt),
    ).toBeGreaterThanOrEqual(HOOK_MS - 20);

    const cap = testTimeoutCap(TestRunner.getCurrentTest());
    // The body has nearly all of its 3 s; counted from result.startTime it
    // would have had about 1.25 s.
    expect(cap?.deadline).toBeGreaterThan(
      bodyStartedAt + TIMEOUT_MS - TEST_TIMEOUT_HEADROOM_MS - 200,
    );
    expect(cap?.deadline).toBeLessThanOrEqual(
      bodyStartedAt + TIMEOUT_MS - TEST_TIMEOUT_HEADROOM_MS,
    );

    // And the wait gets that time: this condition holds 1.8 s into the body,
    // after a cap counted from result.startTime would already have fired.
    await waitFor(() => {
      expect(Date.now() - bodyStartedAt).toBeGreaterThanOrEqual(1_800);
    });
  });
});

// A TurnClock whose time moves only when the test sets it, and whose timers
// run only when the test runs them.
interface FakeTimer {
  run: () => void;
  ms: number;
  cleared: boolean;
}

function fakeTurnClock(start: number): TurnClock & {
  wall: number;
  timers: FakeTimer[];
} {
  const clock = {
    wall: start,
    timers: [] as FakeTimer[],
    now: (): number => clock.wall,
    setTimeout(callback: () => void, ms: number): unknown {
      const timer: FakeTimer = { run: callback, ms, cleared: false };
      clock.timers.push(timer);
      return timer;
    },
    clearTimeout(handle: unknown): void {
      for (const timer of clock.timers) {
        if (timer === handle) timer.cleared = true;
      }
    },
  };
  return clock;
}

/** Lets every promise callback already queued run. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("turnWithin", () => {
  it("ends a stuck turn only once the clock reaches the deadline, arming again a timer that ran early", async () => {
    const clock = fakeTurnClock(1_000);
    let steps = 0;
    let ended: boolean | undefined;
    const turn = turnWithin(
      () => {
        steps += 1;
        return new Promise<void>(() => {});
      },
      1_150,
      clock,
    ).then((result) => {
      ended = result;
    });
    expect(clock.timers.map((timer) => timer.ms)).toEqual([150]);

    // The timer runs with the clock a millisecond short of the deadline, as a
    // Node timer can on Date.now(). The turn goes on, with a timer for the
    // millisecond left.
    clock.wall = 1_149;
    clock.timers[0]?.run();
    await settled();
    expect(ended).toBeUndefined();
    expect(clock.timers.map((timer) => timer.ms)).toEqual([150, 1]);

    clock.wall = 1_150;
    clock.timers[1]?.run();
    await settled();
    expect(ended).toBe(true);
    expect(clock.timers).toHaveLength(2);
    expect(steps).toBe(1);
    await turn;
  });

  it("reports a turn whose step settled first as not ended by the deadline, and clears its timer", async () => {
    const clock = fakeTurnClock(1_000);
    await expect(
      turnWithin(() => Promise.resolve(), 1_150, clock),
    ).resolves.toBe(false);
    expect(clock.timers.map((timer) => timer.ms)).toEqual([150]);
    expect(clock.timers[0]?.cleared).toBe(true);
  });
});

describe("testTimeoutCap", () => {
  const clockAt = { wall: 10_000, perf: 700 };

  it("counts from the clock vitest armed for the body, not from result.startTime", () => {
    // The body started 500 ms ago on the performance clock.
    expect(
      testTimeoutCap(
        { timeout: 5_000, result: { startTime: 1_000 } },
        { startedAt: 200, timeoutMs: 5_000 },
        clockAt,
      ),
    ).toEqual({
      deadline: 10_000 - 500 + 5_000 - TEST_TIMEOUT_HEADROOM_MS,
      timeoutMs: 5_000,
    });
  });

  it("uses the clock's own timeout, which is a hook's while a hook runs", () => {
    expect(
      testTimeoutCap(
        { timeout: 5_000, result: { startTime: 1_000 } },
        { startedAt: 200, timeoutMs: 10_000 },
        clockAt,
      ),
    ).toEqual({
      deadline: 10_000 - 500 + 10_000 - TEST_TIMEOUT_HEADROOM_MS,
      timeoutMs: 10_000,
    });
  });

  it("caps a retry or a repeat too, because vitest re-arms the clock for each try", () => {
    expect(
      testTimeoutCap(
        { timeout: 5_000, result: { startTime: 1_000, retryCount: 1, repeatCount: 1 } },
        { startedAt: 200, timeoutMs: 5_000 },
        clockAt,
      )?.deadline,
    ).toBe(10_000 - 500 + 5_000 - TEST_TIMEOUT_HEADROOM_MS);
  });

  it("rounds a fractional deadline down, never later", () => {
    expect(
      testTimeoutCap(
        { timeout: 5_000 },
        { startedAt: 200.4, timeoutMs: 5_000 },
        { wall: 10_000, perf: 700.9 },
      )?.deadline,
    ).toBe(Math.floor(10_000 - 500.5 + 5_000 - TEST_TIMEOUT_HEADROOM_MS));
  });

  it("ignores a clock that does not fit and falls back to result.startTime", () => {
    const fallback = {
      deadline: 1_000 + 5_000 - TEST_TIMEOUT_HEADROOM_MS,
      timeoutMs: 5_000,
    };
    const test = { timeout: 5_000, result: { startTime: 1_000 } };
    // Started after "now": a reading from another clock.
    expect(
      testTimeoutCap(test, { startedAt: 900, timeoutMs: 5_000 }, clockAt),
    ).toEqual(fallback);
    // Older than its own timeout: left over from a task that timed out.
    expect(
      testTimeoutCap(test, { startedAt: 700 - 5_001, timeoutMs: 5_000 }, clockAt),
    ).toEqual(fallback);
    // No usable timeout.
    expect(testTimeoutCap(test, { startedAt: 200, timeoutMs: 0 }, clockAt)).toEqual(
      fallback,
    );
    expect(
      testTimeoutCap(test, { startedAt: Number.NaN, timeoutMs: 5_000 }, clockAt),
    ).toEqual(fallback);
  });

  it("does not cap a wait outside a running test, whatever the clock says", () => {
    expect(
      testTimeoutCap(undefined, { startedAt: 200, timeoutMs: 5_000 }, clockAt),
    ).toBeUndefined();
  });

  it("reads the running test's own clock", ({ task }) => {
    const clock = currentTaskClock();
    const now = readClocks();
    expect(clock?.timeoutMs).toBe(task.timeout);
    expect(clock?.startedAt).toBeLessThanOrEqual(now.perf);
    expect(now.perf - (clock?.startedAt ?? Number.NaN)).toBeLessThan(task.timeout);
  });

  it("without a clock, is the owning test's timeout from its start, less the headroom", () => {
    expect(
      testTimeoutCap({ timeout: 5_000, result: { startTime: 1_000 } }, null),
    ).toEqual({
      deadline: 1_000 + 5_000 - TEST_TIMEOUT_HEADROOM_MS,
      timeoutMs: 5_000,
    });
  });

  it("without a clock, does not cap a wait outside a running test", () => {
    expect(testTimeoutCap(undefined, null)).toBeUndefined();
    expect(testTimeoutCap({ timeout: 5_000 }, null)).toBeUndefined();
    expect(testTimeoutCap({ timeout: 5_000, result: {} }, null)).toBeUndefined();
  });

  it("without a clock, does not cap a retry or a repeat, whose start time is the first try's", () => {
    expect(
      testTimeoutCap(
        { timeout: 5_000, result: { startTime: 1_000, retryCount: 1 } },
        null,
      ),
    ).toBeUndefined();
    expect(
      testTimeoutCap(
        { timeout: 5_000, result: { startTime: 1_000, repeatCount: 1 } },
        null,
      ),
    ).toBeUndefined();
  });

  it("without a clock, does not cap a test that has no timeout", () => {
    expect(
      testTimeoutCap({ timeout: 0, result: { startTime: 1_000 } }, null),
    ).toBeUndefined();
    expect(
      testTimeoutCap(
        {
          timeout: Number.POSITIVE_INFINITY,
          result: { startTime: 1_000 },
        },
        null,
      ),
    ).toBeUndefined();
  });
});

describe("importBeforeTests", () => {
  const events: string[] = [];
  const loader = (name: string) => async () => {
    events.push(`start ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.push(`end ${name}`);
  };
  importBeforeTests(loader("a"), loader("b"));

  it("runs every loader to completion, one at a time, before the suite's first test", () => {
    expect(events).toEqual(["start a", "end a", "start b", "end b"]);
  });
});
