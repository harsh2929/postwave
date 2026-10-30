import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, render } from "@testing-library/react-native";
import React from "react";
import { Text } from "react-native";

// The screen test mocks the connection hooks away, so nothing there can see
// whether a successful pause/disconnect refreshes the stores list. Without the
// invalidation a paused store keeps rendering as active until the next cold
// load -- dropping it passed every existing test. This file overrides the
// global react-query mock with the real library and spies on the client.
// NOTE: `jest.requireActual("@tanstack/react-query")` would ALSO go through the
// moduleNameMapper and hand back the mock (whose mutateAsync never runs
// onSuccess) -- the first version of this test proved exactly nothing that
// way. A relative path to the package bypasses the mapper.
jest.mock("@tanstack/react-query", () => jest.requireActual("../node_modules/@tanstack/react-query"));
jest.mock("@/api/commerceConnection", () => ({
  pauseCommerceStore: jest.fn(async () => null),
  disconnectCommerceStore: jest.fn(async () => ({ ok: true })),
}));

const rq = jest.requireActual("../node_modules/@tanstack/react-query") as typeof import("@tanstack/react-query");
type Mutator = { mutateAsync: (id: string) => Promise<unknown> };
const hooks = require("../src/hooks/useCommerceConnection") as {
  usePauseCommerceStore: () => Mutator;
  useDisconnectCommerceStore: () => Mutator;
};

// Every timer TanStack is holding right now, with its delay. TanStack arms its
// garbage-collection timers through `timeoutManager`, and swapping the provider
// after its first timer draws a warning, so the recorder goes in here, before
// anything renders. It only watches: every timer still runs on the real clock.
const heldTimers = new Map<ReturnType<typeof setTimeout>, number>();
rq.timeoutManager.setTimeoutProvider({
  setTimeout: (callback, delay) => {
    const handle = setTimeout(() => {
      heldTimers.delete(handle);
      callback();
    }, delay);
    heldTimers.set(handle, delay);
    return handle;
  },
  clearTimeout: (handle) => {
    if (handle !== undefined) heldTimers.delete(handle);
    clearTimeout(handle);
  },
  setInterval: (callback, delay) => setInterval(callback, delay),
  clearInterval: (handle) => clearInterval(handle),
});

const clients: InstanceType<typeof rq.QueryClient>[] = [];

// No garbage-collection timers. On the default five-minute gcTime, the probe's
// unmount arms a real 300,000 ms timer for the finished mutation, and it kept
// the jest process alive five minutes after this suite reported (CRIT-1), the
// same reason asset-alt-text-cache sets it. `client.clear()` cannot cancel a
// mutation's timer, so this line is the fix; query-client-gc.native.test.ts
// fails any suite that builds a real client without it.
function makeClient() {
  const client = new rq.QueryClient({
    defaultOptions: {
      queries: { retry: 0, gcTime: Infinity },
      mutations: { retry: 0, gcTime: Infinity },
    },
  });
  clients.push(client);
  return client;
}

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

function Probe({ use, onReady }: { use: () => Mutator; onReady: (m: Mutator["mutateAsync"]) => void }) {
  const { mutateAsync } = use();
  React.useEffect(() => { onReady(mutateAsync); }, [mutateAsync, onReady]);
  return React.createElement(Text, null, "probe");
}

async function fireThrough(use: () => Mutator, client = makeClient()) {
  const spy = jest.spyOn(client, "invalidateQueries");
  let mutate: Mutator["mutateAsync"] | null = null;
  // render() resolves once the probe's effect has flushed, so the callback is
  // there to read.
  const view = await render(React.createElement(rq.QueryClientProvider, { client }, React.createElement(Probe, { use, onReady: (m) => { mutate = m; } })));
  expect(mutate).not.toBeNull();
  await act(async () => { await mutate!("int-1"); });
  return { spy, unmount: view.unmount };
}

describe("store connection writes refresh the stores list", () => {
  it("pause invalidates ['commerce','stores'] on success", async () => {
    const { spy } = await fireThrough(hooks.usePauseCommerceStore);
    expect(spy).toHaveBeenCalledWith({ queryKey: ["commerce", "stores"] });
  });
  it("disconnect invalidates ['commerce','stores'] on success", async () => {
    const { spy } = await fireThrough(hooks.useDisconnectCommerceStore);
    expect(spy).toHaveBeenCalledWith({ queryKey: ["commerce", "stores"] });
  });
});

describe("the suite's client leaves no timer to hold jest open", () => {
  it("holds no TanStack timer once the probe has unmounted", async () => {
    const { unmount } = await fireThrough(hooks.usePauseCommerceStore);
    await unmount();
    expect([...heldTimers.values()]).toEqual([]);
  });

  it("control: the recorder sees the timer a finite mutation gcTime arms on unmount", async () => {
    // Without this, a recorder wired to some other TanStack instance would see
    // nothing and pass the test above for free.
    const client = makeClient();
    client.setDefaultOptions({
      queries: { retry: 0, gcTime: Infinity },
      mutations: { retry: 0, gcTime: 60_000 },
    });
    const { unmount } = await fireThrough(hooks.usePauseCommerceStore, client);
    await unmount();
    expect([...heldTimers.values()]).toEqual([60_000]);
    // Cancel it, so the control leaves nothing behind either.
    for (const mutation of client.getMutationCache().getAll()) mutation.destroy();
    expect(heldTimers.size).toBe(0);
  });
});
