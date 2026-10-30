// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The root registry the component tests share (./_roots.ts). A test that
// forgets a root fails nothing by itself; the cost shows up later, as React
// work after the file has ended. So the helper's properties are pinned here
// rather than inferred from the rest of the suite passing.

import {
  act,
  createElement,
  useEffect,
  useSyncExternalStore,
} from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { trackRoot, trackedRootCount, unmountRoots } from "./_roots";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  unmountRoots();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function actWarnings(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls
    .map((args) => String(args[0]))
    .filter((message) => message.includes("not wrapped in act"));
}

function container(): HTMLDivElement {
  const element = document.createElement("div");
  document.body.append(element);
  return element;
}

// A store with the shape next/dynamic's loadable subscription has: a value, a
// listener set, and a subscribe that returns its own unsubscribe.
function createStore() {
  let value = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next: number) {
      value = next;
      for (const listener of listeners) listener();
    },
    listeners: () => listeners.size,
  };
}

function StoreReader({
  store,
  renders,
}: {
  store: ReturnType<typeof createStore>;
  renders: number[];
}) {
  const value = useSyncExternalStore(store.subscribe, store.get);
  renders.push(value);
  return createElement("p", null, `value ${value}`);
}

function CleansUp({ onCleanup }: { onCleanup: () => void }) {
  useEffect(() => onCleanup, [onCleanup]);
  return createElement("p", null, "mounted");
}

describe("unmountRoots", () => {
  it("unmounts every tracked root inside act(), running each effect cleanup", () => {
    const consoleError = vi.spyOn(console, "error");
    const cleanups: string[] = [];
    const hosts = ["a", "b", "c"].map((name) => {
      const host = container();
      const root = trackRoot(host);
      act(() => {
        root.render(
          createElement(CleansUp, { onCleanup: () => cleanups.push(name) }),
        );
      });
      return host;
    });
    expect(trackedRootCount()).toBe(3);
    expect(hosts.map((host) => host.textContent)).toEqual([
      "mounted",
      "mounted",
      "mounted",
    ]);

    unmountRoots();

    expect(cleanups.sort()).toEqual(["a", "b", "c"]);
    expect(hosts.map((host) => host.textContent)).toEqual(["", "", ""]);
    expect(trackedRootCount()).toBe(0);
    expect(actWarnings(consoleError)).toEqual([]);
  });

  it("stops a subscription from committing into a root whose container was only detached", async () => {
    const consoleError = vi.spyOn(console, "error");

    // Control: the old afterEach, which emptied the body and nothing else.
    // The detached root is still subscribed, so a late update (a
    // next/dynamic chunk landing) commits into it outside act().
    const leakedStore = createStore();
    const leakedRenders: number[] = [];
    const leaked = trackRoot(container());
    act(() => {
      leaked.render(
        createElement(StoreReader, { store: leakedStore, renders: leakedRenders }),
      );
    });
    document.body.innerHTML = "";
    leakedStore.set(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(leakedStore.listeners()).toBe(1);
    expect(leakedRenders.at(-1)).toBe(1);
    expect(actWarnings(consoleError)).toHaveLength(1);

    unmountRoots();
    consoleError.mockClear();

    // With the root unmounted, the same late update reaches nothing.
    const store = createStore();
    const renders: number[] = [];
    const root = trackRoot(container());
    act(() => {
      root.render(createElement(StoreReader, { store, renders }));
    });
    const rendersBefore = renders.length;

    unmountRoots();
    store.set(1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.listeners()).toBe(0);
    expect(renders).toHaveLength(rendersBefore);
    expect(actWarnings(consoleError)).toEqual([]);
  });

  it("accepts a root the test already unmounted", () => {
    const consoleError = vi.spyOn(console, "error");
    const root = trackRoot(container());
    act(() => {
      root.render(createElement("p", null, "mounted"));
    });
    act(() => {
      root.unmount();
    });

    expect(() => unmountRoots()).not.toThrow();
    expect(trackedRootCount()).toBe(0);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("still unmounts the other roots when one throws, then rethrows that error", () => {
    const cleanups: string[] = [];
    const failing = trackRoot(container());
    const healthy = trackRoot(container());
    act(() => {
      failing.render(
        createElement(CleansUp, { onCleanup: () => cleanups.push("failing") }),
      );
      healthy.render(
        createElement(CleansUp, { onCleanup: () => cleanups.push("healthy") }),
      );
    });
    const realUnmount = failing.unmount.bind(failing);
    const boom = new Error("unmount failed");
    failing.unmount = () => {
      throw boom;
    };

    let thrown: unknown;
    try {
      unmountRoots();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(boom);
    expect(cleanups).toEqual(["healthy"]);
    expect(trackedRootCount()).toBe(0);
    act(() => realUnmount());
    expect(cleanups).toEqual(["healthy", "failing"]);
  });

  it("reports every root that threw, not only the first", () => {
    const roots = [trackRoot(container()), trackRoot(container())];
    const realUnmounts = roots.map((root) => root.unmount.bind(root));
    roots.forEach((root, index) => {
      root.unmount = () => {
        throw new Error(`root ${index} failed`);
      };
    });

    let thrown: unknown;
    try {
      unmountRoots();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).message).toBe(
      "2 React roots threw while unmounting",
    );
    expect(
      (thrown as AggregateError).errors.map((error) => (error as Error).message),
    ).toEqual(["root 0 failed", "root 1 failed"]);
    act(() => realUnmounts.forEach((unmount) => unmount()));
  });
});
