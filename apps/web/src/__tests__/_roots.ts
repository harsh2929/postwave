// SPDX-License-Identifier: AGPL-3.0-only
//
// The React roots a test file mounts, and the one place they are unmounted.
//
// WHY THIS EXISTS. apps/web mounts components with react-dom/client
// directly. @testing-library/react is not installed, and vitest runs with
// `globals: false`, so nothing unmounts a root automatically. Emptying
// document.body does not unmount anything either: it detaches the container
// and leaves the root alive. The root's effects, its QueryClient observers
// and its next/dynamic subscriptions keep running after the test that made
// it.
//
// That failed CI, not only leaked memory. subscriber-detail-insights left 26
// roots mounted. After its last test, the next/dynamic sections of
// SubscriberDetailPanels finished loading and committed into roots nobody had
// unmounted. When that happened after vitest had torn down happy-dom, React
// threw "window is not defined". When it happened after the worker's RPC had
// closed, React's act() warning surfaced as "Closing rpc while
// "onUserConsoleLog" was pending". Either way vitest exited 1 with every test
// green, in about one full run in three.
//
// HOW TO USE IT. Create roots with trackRoot() instead of createRoot(), and
// call unmountRoots() from afterEach before emptying the body. An unmounted
// root receives nothing more: next/dynamic and TanStack Query drop their
// subscriptions on unmount, and effect cleanups clear their timers.
//
// Unmounting stops React work, not work that is already running outside
// React. A lazy import still in flight, a request a handler has started, or a
// timer a library schedules from its own cleanup keeps going. A test that
// starts such work must wait for it inside the test, because the file's
// hooks run in microtasks and cannot outlast it.
import { act } from "react";
import { createRoot, type Root, type RootOptions } from "react-dom/client";

const mounted = new Set<Root>();

/** createRoot, recorded so the next unmountRoots() call unmounts it. */
export function trackRoot(
  container: Element | DocumentFragment,
  options?: RootOptions,
): Root {
  const root = createRoot(container, options);
  mounted.add(root);
  return root;
}

/** How many roots trackRoot() has created since the last unmountRoots(). */
export function trackedRootCount(): number {
  return mounted.size;
}

/**
 * Unmounts, inside one act(), every root trackRoot() created since the last
 * call, so effect cleanups run while the test environment still exists.
 *
 * A root the test already unmounted is fine: React ignores a second
 * unmount(). If one root throws while unmounting, the rest are still
 * unmounted, and then the error is rethrown so the failing test shows it.
 */
export function unmountRoots(): void {
  if (mounted.size === 0) return;
  const roots = [...mounted];
  mounted.clear();
  const errors: unknown[] = [];
  act(() => {
    for (const root of roots) {
      try {
        root.unmount();
      } catch (error) {
        errors.push(error);
      }
    }
  });
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `${errors.length} React roots threw while unmounting`,
    );
  }
}
