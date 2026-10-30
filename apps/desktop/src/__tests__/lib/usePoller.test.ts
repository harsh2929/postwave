/**
 * Tests for the createPoller state machine that backs usePoller.
 *
 * The desktop vitest config uses the `node` environment (jsdom is not
 * in the workspace), so instead of rendering React we drive the
 * underlying engine directly via an injected `PollerDeps` stub. The
 * React hook itself is a 6-line adapter on top — `useEffect` mount =
 * createPoller, unmount = dispose — so the state-machine tests cover
 * the meaningful behaviour.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPoller, type PollerDeps, type PollerFn } from "../../hooks/usePoller";

/* ------------------------------------------------------------------ */
/*  Test harness — fake timers + observable visibility + listeners     */
/* ------------------------------------------------------------------ */

interface Harness {
  deps: PollerDeps;
  setHidden: (h: boolean) => void;
  fireVisibility: () => void;
  controllers: AbortController[];
  listeners: Array<() => void>;
}

function makeHarness(): Harness {
  let hidden = false;
  const controllers: AbortController[] = [];
  const listeners: Array<() => void> = [];

  const deps: PollerDeps = {
    setInterval: (cb, ms) => setInterval(cb, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    isHidden: () => hidden,
    addVisibilityListener: (cb) => {
      listeners.push(cb);
    },
    removeVisibilityListener: (cb) => {
      const idx = listeners.indexOf(cb);
      if (idx >= 0) listeners.splice(idx, 1);
    },
    createAbortController: () => {
      const c = new AbortController();
      controllers.push(c);
      return c;
    },
  };

  return {
    deps,
    setHidden: (h) => {
      hidden = h;
    },
    fireVisibility: () => {
      // Snapshot in case a listener mutates the array.
      [...listeners].forEach((cb) => cb());
    },
    controllers,
    listeners,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ */
/*  Lifecycle + interval                                                */
/* ------------------------------------------------------------------ */

describe("createPoller — interval ticking", () => {
  it("does not fire an immediate tick on mount (mirrors setInterval)", () => {
    const h = makeHarness();
    const fn = vi.fn<PollerFn>();
    const poller = createPoller(() => fn, 1000, h.deps);

    expect(fn).not.toHaveBeenCalled();
    poller.dispose();
  });

  it("fires once per interval", () => {
    const h = makeHarness();
    const fn = vi.fn<PollerFn>();
    const poller = createPoller(() => fn, 1000, h.deps);

    vi.advanceTimersByTime(999);
    expect(fn).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(3);

    poller.dispose();
  });

  it("passes an AbortSignal in the ctx arg", () => {
    const h = makeHarness();
    const fn = vi.fn<PollerFn>();
    const poller = createPoller(() => fn, 100, h.deps);

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    const arg = fn.mock.calls[0][0];
    expect(arg).toBeDefined();
    expect(arg.signal).toBeInstanceOf(AbortSignal);
    expect(arg.signal.aborted).toBe(false);

    poller.dispose();
  });

  it("dispose() stops further ticks and removes the visibility listener", () => {
    const h = makeHarness();
    const fn = vi.fn<PollerFn>();
    const poller = createPoller(() => fn, 100, h.deps);

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(h.listeners.length).toBe(1);

    poller.dispose();
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(h.listeners.length).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  document.hidden gating                                              */
/* ------------------------------------------------------------------ */

describe("createPoller — visibility gating", () => {
  it("does not start the interval if hidden at mount", () => {
    const h = makeHarness();
    h.setHidden(true);
    const fn = vi.fn<PollerFn>();
    const poller = createPoller(() => fn, 100, h.deps);

    vi.advanceTimersByTime(10_000);
    expect(fn).not.toHaveBeenCalled();

    poller.dispose();
  });

  it("starts on visibility → visible and fires an immediate catch-up tick", () => {
    const h = makeHarness();
    h.setHidden(true);
    const fn = vi.fn<PollerFn>();
    const poller = createPoller(() => fn, 100, h.deps);

    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();

    h.setHidden(false);
    h.fireVisibility();
    expect(fn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);

    poller.dispose();
  });

  it("pauses ticking + aborts in-flight work when hidden", () => {
    const h = makeHarness();
    const fn = vi.fn<PollerFn>(async () => {
      /* never resolves within the test window */
      await new Promise(() => {});
    });
    const poller = createPoller(() => fn, 100, h.deps);

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    const firstController = h.controllers[0];
    expect(firstController.signal.aborted).toBe(false);

    h.setHidden(true);
    h.fireVisibility();
    expect(firstController.signal.aborted).toBe(true);

    vi.advanceTimersByTime(10_000);
    expect(fn).toHaveBeenCalledTimes(1);

    poller.dispose();
  });

  it("skips a tick that the interval timer fires while hidden (defence-in-depth)", () => {
    // Simulates a race where the interval already exists but the
    // visibility flag flips between two ticks. Even if start/stop
    // bookkeeping lags, the per-tick hidden check guarantees fn never
    // runs while hidden.
    const h = makeHarness();
    const fn = vi.fn<PollerFn>();
    const poller = createPoller(() => fn, 100, h.deps);

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);

    // Flip hidden but DON'T fire visibility — simulates the racey case
    // where the timer fires before the visibility listener runs.
    h.setHidden(true);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);

    poller.dispose();
  });
});

/* ------------------------------------------------------------------ */
/*  AbortController + monotonic version                                 */
/* ------------------------------------------------------------------ */

describe("createPoller — AbortController plumbing", () => {
  it("aborts the previous tick's controller before firing the next", () => {
    const h = makeHarness();
    const resolvers: Array<() => void> = [];
    const fn = vi.fn<PollerFn>(async () => {
      await new Promise<void>((r) => {
        resolvers.push(r);
      });
    });
    const poller = createPoller(() => fn, 100, h.deps);

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    const first = h.controllers[0];
    expect(first.signal.aborted).toBe(false);

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(first.signal.aborted).toBe(true);
    expect(h.controllers[1].signal.aborted).toBe(false);

    // Drain any pending awaiters so dispose() leaves no hanging
    // promises behind.
    resolvers.forEach((r) => r());
    poller.dispose();
  });

  it("aborts the in-flight controller on dispose", () => {
    const h = makeHarness();
    const fn = vi.fn<PollerFn>(async () => {
      await new Promise(() => {});
    });
    const poller = createPoller(() => fn, 100, h.deps);

    vi.advanceTimersByTime(100);
    const ctrl = h.controllers[0];
    expect(ctrl.signal.aborted).toBe(false);

    poller.dispose();
    expect(ctrl.signal.aborted).toBe(true);
  });

  it("swallows async rejections from stale ticks (no unhandled promise)", async () => {
    const h = makeHarness();
    const fn = vi.fn<PollerFn>(async () => {
      throw new Error("boom");
    });
    const poller = createPoller(() => fn, 100, h.deps);

    vi.advanceTimersByTime(100);
    // Allow the rejected promise's .catch handler to run.
    await Promise.resolve();
    await Promise.resolve();

    // No unhandled-rejection assertion API in vitest by default, but
    // if the .catch above wasn't wired the test runner would flag it.
    expect(fn).toHaveBeenCalledTimes(1);
    poller.dispose();
  });

  it("swallows sync throws from fn", () => {
    const h = makeHarness();
    const fn = vi.fn<PollerFn>(() => {
      throw new Error("sync boom");
    });
    const poller = createPoller(() => fn, 100, h.deps);

    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);

    poller.dispose();
  });

  it("supports sync (non-promise) fn returns", () => {
    const h = makeHarness();
    const fn = vi.fn<PollerFn>(() => undefined);
    const poller = createPoller(() => fn, 100, h.deps);

    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(3);

    poller.dispose();
  });

  it("always reads the latest fn via getFn() (closures stay fresh)", () => {
    const h = makeHarness();
    const calls: string[] = [];
    let label = "a";
    const getFn = (): PollerFn => () => {
      calls.push(label);
    };
    const poller = createPoller(getFn, 100, h.deps);

    vi.advanceTimersByTime(100);
    label = "b";
    vi.advanceTimersByTime(100);
    label = "c";
    vi.advanceTimersByTime(100);

    expect(calls).toEqual(["a", "b", "c"]);
    poller.dispose();
  });
});

/* ------------------------------------------------------------------ */
/*  Disabled / no-op intervals                                          */
/* ------------------------------------------------------------------ */

describe("createPoller — disabled intervals", () => {
  it("intervalMs = 0 is a no-op (no timer, no listener)", () => {
    const h = makeHarness();
    const fn = vi.fn<PollerFn>();
    const poller = createPoller(() => fn, 0, h.deps);

    vi.advanceTimersByTime(10_000);
    expect(fn).not.toHaveBeenCalled();
    expect(h.listeners.length).toBe(0);

    // dispose() is safe to call on the no-op handle.
    expect(() => poller.dispose()).not.toThrow();
  });

  it("negative intervalMs is a no-op", () => {
    const h = makeHarness();
    const fn = vi.fn<PollerFn>();
    const poller = createPoller(() => fn, -100, h.deps);
    vi.advanceTimersByTime(10_000);
    expect(fn).not.toHaveBeenCalled();
    poller.dispose();
  });

  it("NaN intervalMs is a no-op", () => {
    const h = makeHarness();
    const fn = vi.fn<PollerFn>();
    const poller = createPoller(() => fn, Number.NaN, h.deps);
    vi.advanceTimersByTime(10_000);
    expect(fn).not.toHaveBeenCalled();
    poller.dispose();
  });
});
