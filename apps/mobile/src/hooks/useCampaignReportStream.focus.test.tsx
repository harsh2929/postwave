/**
 * The live-send tail's socket is held only while the app is in front of the
 * user — the same NATIVE#10 rule lib/eventCacheSync applies to the event bus.
 *
 * The corroboration for this being a defect rather than a preference is in the
 * caller: hooks/useCampaigns documents in a comment that its `/report` poll is
 * foreground-only, because focusManager is bridged to AppState in
 * lib/connectivity and `refetchIntervalInBackground` is left false — and then
 * layers this stream beside it. An ungated socket next to a gated poll means
 * backgrounding the app stops the cheap request and keeps the expensive
 * connection, plus its stall-watchdog reconnect and stream-token mint cycle.
 *
 * `streaming` must also go false on pause: it drives a "live" affordance, and
 * a socket the OS has torn down is not one.
 */
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { FocusGate } from "@/lib/eventStreamLifecycle";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  opens: 0,
  stops: 0,
  emitStatus: null as ((s: string) => void) | null,
}));

vi.mock("@/api/campaignEventsStream", () => ({
  connectCampaignEvents: (
    _id: string,
    handlers: { onStatus?: (s: string) => void },
  ) => {
    state.opens += 1;
    state.emitStatus = handlers.onStatus ?? null;
    return () => {
      state.stops += 1;
      state.emitStatus = null;
    };
  },
}));

vi.mock("@/hooks/useOnlineQueryGate", () => ({
  useOnlineQueryGate: () => ({
    enabled: true,
    baseUrl: "https://api.test.example",
    tenantId: "tenant_1",
    userId: "user_1",
    effectiveRole: "admin",
    canReadOfflineSnapshots: true,
  }),
}));

const { useCampaignReportStream } = await import("./useCampaignReportStream");

function fakeFocus(initial: boolean): FocusGate & { set(f: boolean): void } {
  let focused = initial;
  const listeners = new Set<(f: boolean) => void>();
  return {
    isFocused: () => focused,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: boolean) {
      focused = next;
      for (const l of [...listeners]) l(next);
    },
  };
}

function render(focus: FocusGate) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const seen: boolean[] = [];
  function Probe() {
    const { streaming } = useCampaignReportStream("cmp_1", {
      live: true,
      focus,
    });
    seen.push(streaming);
    return null;
  }
  let tree: TestRenderer.ReactTestRenderer | null = null;
  act(() => {
    tree = TestRenderer.create(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  return { tree: tree as unknown as TestRenderer.ReactTestRenderer, seen };
}

describe("useCampaignReportStream lifecycle", () => {
  beforeEach(() => {
    state.opens = 0;
    state.stops = 0;
    state.emitStatus = null;
  });

  it("opens the stream while the app is foregrounded", () => {
    const focus = fakeFocus(true);
    const { tree } = render(focus);
    expect(state.opens).toBe(1);
    act(() => tree.unmount());
    expect(state.stops).toBe(1);
  });

  it("does not open a socket at all when the app starts backgrounded", () => {
    const focus = fakeFocus(false);
    const { tree } = render(focus);
    expect(state.opens).toBe(0);
    act(() => tree.unmount());
  });

  it("releases the socket on background and re-opens on return", () => {
    const focus = fakeFocus(true);
    const { tree } = render(focus);
    act(() => focus.set(false));
    expect(state.stops).toBe(1);
    expect(state.opens).toBe(1);
    act(() => focus.set(true));
    expect(state.opens).toBe(2);
    act(() => tree.unmount());
  });

  it("stops claiming to be streaming once the socket is released", () => {
    const focus = fakeFocus(true);
    const { tree, seen } = render(focus);
    act(() => state.emitStatus?.("open"));
    expect(seen.at(-1)).toBe(true);
    act(() => focus.set(false));
    expect(seen.at(-1)).toBe(false);
    act(() => tree.unmount());
  });
});
