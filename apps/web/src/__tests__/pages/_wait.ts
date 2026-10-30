// SPDX-License-Identifier: AGPL-3.0-only
//
// The one wait the page tests share: retry an assertion until it holds or a
// wall-clock deadline passes, flushing React between attempts.
//
// WHY A DEADLINE AND NOT A TURN COUNT. Each page test used to give up after a
// fixed number of event-loop turns: 40 to 100 turns of a few milliseconds
// each, so a few hundred milliseconds in all. Content from a next/dynamic
// panel, or from a module a page imports on first use, only arrives after
// vitest's main process has transformed and imported that module. That is
// wall-clock work, and every test file running at the same time shares it, so
// a loaded CI host stretches it past any fixed number of cheap turns. The
// waits then ran out while the chunk was still on its way. A budget in
// milliseconds means the same thing on every host.
//
// WHY 4 S, AND WHY THE OWNING TEST'S TIMEOUT ALSO CAPS IT. apps/web keeps
// vitest's default 5 s test timeout. A wait that outlives its test does
// three kinds of damage. The test is reported as a bare "Test timed out"
// instead of the assertion that never held. The loop keeps running into the
// next test and asserts against that test's DOM. And the act() scope it has
// open closes during the next test's act() calls. React's act() depth count
// is then off by one, so React stops flushing, and every later test in the
// file renders nothing. (On a loaded run, an unbounded act() in
// analytics-mounts' renderPage did exactly that to the eleven tests after
// it.) So the budget sits under the timeout, and a wait that starts late in a
// test gets only the time that test has left.
//
// WHERE "THE TIME THAT TEST HAS LEFT" IS MEASURED FROM. vitest starts a
// test's timeout clock when it invokes the test body, after every beforeEach
// hook has run, and the same goes for a hook's own clock. The test's
// result.startTime is stamped earlier, before those hooks, so a cap anchored
// on it came due early by however long the hooks took. The cap therefore
// reads the clock vitest itself armed (see currentTaskClock), and only falls
// back to result.startTime when that clock cannot be read. The fallback can
// only cut a wait early, never let one outlive its test.
//
// WHY EACH TURN IS CUT OFF AT THE DEADLINE. The deadline only holds if nothing
// between two attempts can outlast it. The wait never starts a turn after the
// deadline, and the one turn in flight when it passes is abandoned, which
// also closes its act() scope. So the wait settles within one assertion call
// of its deadline.
//
// WHY THE WALL CLOCK, NOT THE TIMER, ENDS THAT TURN. The deadline is a
// Date.now() reading. The timer that wakes a stuck turn runs on the event
// loop's own millisecond clock, which ticks over at different moments, so a
// timer can run up to a millisecond before Date.now() reaches the time it was
// armed for. When the turn ended on the timer's word, the wait found itself
// just short of its deadline and ran one more short turn and one more attempt
// (6 of 102 runs of wait-deadline.test.tsx on a loaded host). Giving up at
// once instead would have ended the wait a millisecond short of its budget.
// So the timer only wakes the turn: the turn ends once Date.now() has
// reached the deadline, and a timer that runs early is armed again for the
// time left. The wait then makes its last attempt and gives up on
// turnWithin's word, without reading the clock a second time.
//
// WHY importBeforeTests EXISTS. A wait can only bound what happens inside it.
// A test that imports its page in its body pays the page's whole cold module
// graph on its own 5 s clock. On a loaded host that import alone outlasted
// the test, and the test timed out mid-import. Its body then resumed inside
// the next test, and its act() calls crossed that test's act() calls, so
// React stopped flushing for the rest of the file. importBeforeTests pays
// that import in a beforeAll hook, whose timeout is sized for cold imports.
import { performance } from "node:perf_hooks";
import { act } from "react";
import { beforeAll, TestRunner } from "vitest";

/** Wall-clock budget for one wait, under vitest's default 5 s test timeout. */
export const WAIT_DEADLINE_MS = 4_000;

/**
 * Time kept back from the owning test's timeout, so the rethrown assertion
 * reaches the runner before the timeout does.
 */
export const TEST_TIMEOUT_HEADROOM_MS = 250;

// The first turns are as cheap as the old fixed-count loops were, which is
// what a query or a state update needs to settle. After that the wait is
// usually on module transform work in vitest's main process, so each turn
// sleeps briefly instead of competing with it for the CPU.
const FAST_TURNS = 60;
const SLOW_TURN_MS = 10;

// Read once, when this module loads, so that fake timers installed by a test
// cannot freeze the deadline clock or the timer that ends a turn.
const realNow = Date.now;
const realPerformanceNow = performance.now.bind(performance);
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

export interface WaitForOptions {
  /**
   * Budget for this wait in ms. Defaults to WAIT_DEADLINE_MS. The time the
   * owning test has left still caps it.
   */
  timeoutMs?: number;
  /**
   * One turn between attempts. It runs inside act(). The default is one
   * animation frame, then one macrotask; after the first FAST_TURNS turns that
   * macrotask waits SLOW_TURN_MS.
   */
  step?: () => Promise<void>;
}

/** One animation frame, then one macrotask: what the old loops waited per turn. */
async function nextFrame(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

/**
 * Retries `assertion` until it stops throwing. Between attempts it runs one
 * turn inside act(), so React commits whatever landed. If the deadline passes
 * first, it rethrows the assertion's last error with the elapsed time
 * appended.
 *
 * The assertion must be synchronous. A promise it returned would carry its
 * failure where this loop cannot see it, so the wait refuses one.
 */
export async function waitFor(
  assertion: () => void,
  options: WaitForOptions = {},
): Promise<void> {
  const startedAt = realNow();
  const budgetMs = options.timeoutMs ?? WAIT_DEADLINE_MS;
  const testCap = testTimeoutCap(TestRunner.getCurrentTest());
  const capped = testCap !== undefined && testCap.deadline < startedAt + budgetMs;
  const deadline = capped ? testCap.deadline : startedAt + budgetMs;
  const budget = capped
    ? `budget ${budgetMs} ms, cut to ${Math.max(0, deadline - startedAt)} ms by the ${testCap.timeoutMs} ms timeout it runs under`
    : `budget ${budgetMs} ms`;

  // Set when the deadline ended the last turn. The attempt after that turn is
  // the last one.
  let deadlineEndedTurn = false;
  for (let attempt = 1; ; attempt += 1) {
    let failed = false;
    let failure: unknown;
    let returned: unknown;
    try {
      returned = assertion();
    } catch (error) {
      failed = true;
      failure = error;
    }
    if (!failed) {
      if (isPromiseLike(returned)) {
        // The TypeError below is the failure. Handle the orphaned promise so
        // its own rejection cannot surface later as an unhandled error.
        void Promise.resolve(returned).catch(() => undefined);
        throw new TypeError(
          "waitFor retries a synchronous assertion, but this one returned a promise. Its rejection would never reach the wait.",
        );
      }
      return;
    }

    if (deadlineEndedTurn || realNow() >= deadline) {
      throw withElapsed(
        failure,
        `waitFor gave up after ${realNow() - startedAt} ms and ${attempt} attempts (${budget}).`,
      );
    }

    const step =
      options.step ??
      (() => nextFrame(attempt < FAST_TURNS ? 0 : SLOW_TURN_MS));
    await act(async () => {
      deadlineEndedTurn = await turnWithin(step, deadline);
    });
  }
}

/** The clock and the timer turnWithin runs on. Tests pass a fake one. */
export interface TurnClock {
  /** The clock `deadline` is read on, as Date.now(). */
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTurnClock: TurnClock = {
  now: () => realNow(),
  setTimeout: (callback, ms) => realSetTimeout(callback, ms),
  clearTimeout: (handle) => {
    realClearTimeout(handle as ReturnType<typeof realSetTimeout> | undefined);
  },
};

/**
 * Runs one turn, abandoning it if `clock.now()` reaches `deadline` before the
 * step settles. Resolves true when the deadline ended the turn, and false
 * when the step settled first.
 *
 * The timer only wakes the turn; the clock decides. A timer that runs before
 * `clock.now()` has reached the deadline is armed again for the time left,
 * so a turn the deadline ends has always reached it.
 */
export async function turnWithin(
  step: () => Promise<void>,
  deadline: number,
  clock: TurnClock = realTurnClock,
): Promise<boolean> {
  let timer: unknown;
  try {
    return await Promise.race([
      step().then(() => false),
      new Promise<boolean>((resolve) => {
        const wake = () => {
          const leftMs = deadline - clock.now();
          if (leftMs <= 0) {
            resolve(true);
            return;
          }
          timer = clock.setTimeout(wake, leftMs);
        };
        wake();
      }),
    ]);
  } finally {
    clock.clearTimeout(timer);
  }
}

/** Hook timeout for importing modules cold, one after another. */
export const COLD_IMPORT_TIMEOUT_MS = 60_000;

/**
 * Registers a beforeAll hook in the current suite that runs each loader once,
 * in order, before the suite's first test. Pass the imports a suite's tests
 * make in their bodies. Those imports then resolve from the module cache,
 * and no test's 5 s budget includes a cold module graph.
 *
 * The loaders run one at a time: two concurrent imports of a module mocked
 * with vi.mock(path, importOriginal) can hand one caller the real module.
 */
export function importBeforeTests(
  ...loaders: ReadonlyArray<() => Promise<unknown>>
): void {
  beforeAll(async () => {
    for (const load of loaders) {
      await load();
    }
  }, COLD_IMPORT_TIMEOUT_MS);
}

/** The parts of vitest's running test that the cap reads. */
export interface RunningTest {
  timeout: number;
  result?: { startTime?: number; retryCount?: number; repeatCount?: number };
}

/**
 * The timeout clock vitest armed for the body or hook running now: when it
 * invoked it, on performance.now(), and the timeout it gave it.
 */
export interface TaskClock {
  startedAt: number;
  timeoutMs: number;
}

/** Date.now() and performance.now(), read at the same moment. */
export interface ClockReading {
  wall: number;
  perf: number;
}

// vitest keeps the clock it arms for each test body and hook on its runner,
// as _currentTaskStartTime and _currentTaskTimeout (@vitest/runner's
// withTimeout). The runner is not exported, but every try of every test goes
// through TestRunner.prototype.onBeforeTryTask with `this` bound to it, so the
// first copy of this module to load wraps that method once and records the
// runner in a slot kept on the prototype itself. Later copies (one per test
// file) find the slot there instead of wrapping again. If a vitest upgrade
// renames either piece, the slot stays empty or the fields read undefined,
// and the cap falls back to result.startTime. wait-deadline.test.tsx fails
// when that happens, so the regression cannot pass silently.
const RUNNER_SLOT = Symbol.for("postwave.tests.wait.runner");

interface TimedRunner {
  _currentTaskStartTime?: unknown;
  _currentTaskTimeout?: unknown;
}

interface RunnerSlot {
  runner?: TimedRunner;
}

function runnerSlot(): RunnerSlot {
  const proto = TestRunner.prototype as unknown as Record<symbol, unknown> & {
    onBeforeTryTask?: (...args: unknown[]) => unknown;
  };
  const existing = proto[RUNNER_SLOT] as RunnerSlot | undefined;
  if (existing) return existing;
  const slot: RunnerSlot = {};
  const original = proto.onBeforeTryTask;
  proto.onBeforeTryTask = function (this: TimedRunner, ...args: unknown[]) {
    slot.runner = this;
    return typeof original === "function"
      ? original.apply(this, args)
      : undefined;
  };
  proto[RUNNER_SLOT] = slot;
  return slot;
}

const slot = runnerSlot();

/** The clock vitest armed for the running body or hook, if it can be read. */
export function currentTaskClock(): TaskClock | undefined {
  const startedAt = slot.runner?._currentTaskStartTime;
  const timeoutMs = slot.runner?._currentTaskTimeout;
  if (typeof startedAt !== "number" || typeof timeoutMs !== "number") {
    return undefined;
  }
  return { startedAt, timeoutMs };
}

/** Both clocks, read together, for testTimeoutCap. */
export function readClocks(): ClockReading {
  return { wall: realNow(), perf: realPerformanceNow() };
}

/**
 * When the running test will time out, less the headroom, on the Date.now()
 * clock. Undefined outside a test and for a test with no timeout.
 *
 * `clock` defaults to the timer vitest armed for the body or hook running now,
 * so the deadline is the one vitest will enforce: measured from the body's
 * start, after the beforeEach hooks, and re-armed for each retry or repeat.
 * A clock that does not fit (older than its own timeout, or from another
 * clock) is ignored. Pass null to leave the clock out.
 *
 * Without a clock, the deadline is measured from result.startTime, which
 * vitest stamps before the beforeEach hooks run, so it comes due early by the
 * time they took. It is also skipped on a retry or repeat, because vitest
 * keeps the first try's start time for those.
 */
export function testTimeoutCap(
  test: RunningTest | undefined,
  clock: TaskClock | null = currentTaskClock() ?? null,
  now: ClockReading = readClocks(),
): { deadline: number; timeoutMs: number } | undefined {
  if (!test) return undefined;
  if (
    clock &&
    Number.isFinite(clock.startedAt) &&
    Number.isFinite(clock.timeoutMs) &&
    clock.timeoutMs > 0
  ) {
    const elapsed = now.perf - clock.startedAt;
    if (elapsed >= 0 && elapsed <= clock.timeoutMs) {
      // Floor, so rounding can only bring the deadline earlier.
      return {
        deadline: Math.floor(
          now.wall - elapsed + clock.timeoutMs - TEST_TIMEOUT_HEADROOM_MS,
        ),
        timeoutMs: clock.timeoutMs,
      };
    }
  }
  const result = test.result;
  if (result?.startTime === undefined) return undefined;
  if ((result.retryCount ?? 0) > 0 || (result.repeatCount ?? 0) > 0) {
    return undefined;
  }
  if (!Number.isFinite(test.timeout) || test.timeout <= 0) return undefined;
  return {
    deadline: result.startTime + test.timeout - TEST_TIMEOUT_HEADROOM_MS,
    timeoutMs: test.timeout,
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * The assertion's own error, with `note` appended to its message. It keeps its
 * class and its expected/actual fields, so the reporter still prints the diff.
 */
function withElapsed(error: unknown, note: string): Error {
  if (error instanceof Error) {
    const original = error.message;
    error.message = original ? `${original}\n\n${note}` : note;
    // V8 renders `stack` once, on first read. If something read it before the
    // message changed, its first line still carries the old message.
    if (
      typeof error.stack === "string" &&
      !error.stack.includes(note) &&
      original &&
      error.stack.includes(original)
    ) {
      error.stack = error.stack.replace(original, error.message);
    }
    return error;
  }
  return new Error(`${String(error)}\n\n${note}`);
}
