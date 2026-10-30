/**
 * usePoller — single source of truth for "fetch on an interval while
 * the tab is visible" loops. Replaces the 30+ ad-hoc copies of the
 * same setInterval + document.hidden + visibilitychange + AbortController
 * pattern scattered through Dashboard, Audit, Analytics, etc.
 *
 * Contract
 * --------
 *
 *   useEffect-shaped: re-runs whenever any value in `deps` changes,
 *   and tears down on unmount.
 *
 *   fn receives an { signal } so it can abort an in-flight request when
 *   the poll is torn down, the tab is backgrounded, or a new tick fires
 *   before the previous one settled.
 *
 *   Polling pauses while `document.hidden === true`. On visibilitychange
 *   → visible, we fire one immediate tick and then resume the interval
 *   from "now" (i.e. we don't double-fire if the interval timer also
 *   happens to be near boundary).
 *
 *   A monotonic request-version guard means callers can safely call
 *   setState inside fn — stale responses (e.g. a slow request from a
 *   previous tick or a previous deps value) are silently dropped via
 *   the AbortController, but the guard is also exposed for callers
 *   that want to gate their own setState calls (returned from `fn` as
 *   `signal.aborted` after teardown).
 *
 * Usage
 * -----
 *
 *   usePoller(
 *     async ({ signal }) => {
 *       const r = await api.listSomething({ signal });
 *       if (signal.aborted) return;
 *       setRows(r.data?.rows ?? []);
 *     },
 *     30_000,
 *     [tenantId],
 *   );
 *
 *   // Skip polling entirely: pass intervalMs = 0 (or negative). The
 *   // hook does nothing — handy for conditional polls behind a flag.
 *
 * Notes
 * -----
 *
 *   - Does NOT fire an initial tick by default; the first tick fires
 *     after `intervalMs` (matches the legacy setInterval behaviour at
 *     all the call sites we're migrating). Callers that want an
 *     immediate fetch should call fn themselves before mounting, or
 *     trigger one via React Query / their own useEffect.
 *
 *   - Safe to call with intervalMs = 0 / negative / NaN (no-op).
 *
 *   - `fn` is captured via a ref so callers don't need useCallback —
 *     deps drive lifecycle, not identity.
 */

import { useEffect, useRef, type DependencyList } from "react";

export interface PollerContext {
  signal: AbortSignal;
}

export type PollerFn = (
  ctx: PollerContext,
) => Promise<void> | void;

/**
 * The portable, framework-free state machine that backs `usePoller`.
 *
 * Extracted so it can be unit-tested without rendering React (the
 * desktop vitest config uses the `node` env and we don't ship jsdom
 * or @testing-library). The React hook below is a thin adapter that
 * wires `fnRef` and `useEffect`'s mount/unmount into this engine.
 *
 * Behaviour mirrors the legacy hand-rolled pattern at Dashboard.tsx
 * lines ~304-338 and ~30 other call sites.
 */
export interface PollerDeps {
  setInterval: (cb: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  isHidden: () => boolean;
  addVisibilityListener: (cb: () => void) => void;
  removeVisibilityListener: (cb: () => void) => void;
  createAbortController: () => AbortController;
}

export function createPoller(
  getFn: () => PollerFn,
  intervalMs: number,
  deps: PollerDeps,
): { dispose: () => void } {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return { dispose: () => {} };
  }

  let timer: unknown = null;
  let currentController: AbortController | null = null;
  // Monotonic version — every tick (and every teardown) bumps it.
  // Anything resolving against an older version is treated as stale.
  let version = 0;
  let disposed = false;

  const abortInFlight = (): void => {
    if (currentController && !currentController.signal.aborted) {
      currentController.abort();
    }
    currentController = null;
  };

  const tick = (): void => {
    if (disposed) return;
    // Skip if hidden — visibility handler fires a catch-up when shown.
    if (deps.isHidden()) return;

    // Abort any prior in-flight request — newer tick wins.
    abortInFlight();
    version += 1;
    const myVersion = version;
    const controller = deps.createAbortController();
    currentController = controller;

    try {
      const out = getFn()({ signal: controller.signal });
      if (out && typeof (out as Promise<void>).then === "function") {
        void (out as Promise<void>)
          .catch(() => {
            /* Caller is responsible for surfacing errors. We swallow
               here so an unhandled rejection from a stale poll tick
               doesn't crash the page. AbortError during teardown is
               the expected case. */
          })
          .finally(() => {
            // Only clear if we're still the active request.
            if (myVersion === version) currentController = null;
          });
      } else {
        if (myVersion === version) currentController = null;
      }
    } catch {
      // Sync throw — same treatment as async rejection.
      if (myVersion === version) currentController = null;
    }
  };

  const start = (): void => {
    if (timer !== null || disposed) return;
    timer = deps.setInterval(tick, intervalMs);
  };
  const stop = (): void => {
    if (timer !== null) {
      deps.clearInterval(timer);
      timer = null;
    }
  };

  const onVisibility = (): void => {
    if (deps.isHidden()) {
      // Backgrounded → pause timer + cancel in-flight work.
      stop();
      abortInFlight();
    } else {
      // Foregrounded → catch-up tick + resume from now.
      tick();
      start();
    }
  };

  // Start only if currently visible. If hidden at mount, the visibility
  // handler will start us once the tab is shown.
  if (!deps.isHidden()) start();
  deps.addVisibilityListener(onVisibility);

  return {
    dispose: () => {
      disposed = true;
      stop();
      abortInFlight();
      deps.removeVisibilityListener(onVisibility);
    },
  };
}

/**
 * Build the default DOM-backed PollerDeps. Safe to call in SSR /
 * non-browser contexts — falls back to "always visible, no listener".
 */
function browserDeps(): PollerDeps {
  const hasDoc = typeof document !== "undefined";
  return {
    setInterval: (cb, ms) => setInterval(cb, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    isHidden: () => (hasDoc ? document.hidden : false),
    addVisibilityListener: (cb) => {
      if (hasDoc) document.addEventListener("visibilitychange", cb);
    },
    removeVisibilityListener: (cb) => {
      if (hasDoc) document.removeEventListener("visibilitychange", cb);
    },
    createAbortController: () => new AbortController(),
  };
}

export function usePoller(
  fn: PollerFn,
  intervalMs: number,
  deps: DependencyList = [],
): void {
  // Capture latest fn in a ref so callers don't need useCallback.
  // Deps drive the *lifecycle*, fn is read each tick.
  const fnRef = useRef<PollerFn>(fn);
  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  useEffect(
    () => {
      const handle = createPoller(
        () => fnRef.current,
        intervalMs,
        browserDeps(),
      );
      return () => handle.dispose();
    },
    // We intentionally read intervalMs + deps as the lifecycle inputs.
    // fn is captured via ref above, so it's not in deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [intervalMs, ...deps],
  );
}
