// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// WHEN the dashboard opens its realtime streams.
//
// A cold load of the dashboard on a high-latency link was frozen for 18–22
// seconds. Measured on staging: three long-lived streams opened about three
// seconds in — GET /api/v1/events for cache invalidation, the presence
// subscription on the same endpoint, and GET /api/v1/dashboard/live. Chrome
// gives an EventSource high priority, and on a connection it rates as slow
// (~300 ms RTT to us-west-2 scores as "3G") it holds lower-priority requests
// behind the high-priority ones. Sixteen lazy JS chunks and five prefetches
// queued at 2.66 s were not sent until 17.67 s. One of those chunks is the
// step-up listener the shell waits for before it lifts the "Preparing your
// workspace…" overlay and clears `inert`, so every click was swallowed until
// ~18 s. Blocking the streams made the same load interactive in 5.2 s.
//
// These tests drive the REAL consumers the dashboard mounts — the real
// RealtimeInvalidator, the real usePresence, the real useDashboardLive — over a
// fake EventSource, and control the browser signals the gate waits for.

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RealtimeInvalidator } from "@/components/realtime-invalidator";
import { useDashboardLive } from "@/components/dashboard/dashboard-live";
import { usePresence } from "@/lib/realtime/use-presence";
import { connectRealtimeBus } from "@/lib/realtime/event-bus-client";
import { resetStreamGateForTests } from "@/lib/realtime/stream-gate";

// ─── Fakes for the two browser signals the gate waits for ──────────────────

class FakeEventSource {
  static opened: FakeEventSource[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: MessageEvent<string>) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.opened.push(this);
  }
  addEventListener(): void {}
  close(): void {
    this.closed = true;
  }
}

/** Every stream URL opened so far, in order. */
function openedUrls(): string[] {
  return FakeEventSource.opened.map((es) => es.url);
}

/** Queued idle callbacks, so a test decides when the browser goes idle. */
let idleQueue: Array<() => void> = [];

function runOneIdleSlice(): void {
  const queued = idleQueue;
  idleQueue = [];
  for (const run of queued) run();
}

let readyStateDescriptor: PropertyDescriptor | undefined;

function setReadyState(value: DocumentReadyState): void {
  Object.defineProperty(document, "readyState", {
    configurable: true,
    get: () => value,
  });
}

// ─── Rendering the real consumers ──────────────────────────────────────────

const roots: Root[] = [];

function render(node: ReactNode): void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(node));
}

/** The presence stream, through the hook the header's indicator calls. */
function PresenceProbe(): null {
  usePresence();
  return null;
}

/** The live-stats stream, through the hook the home header's bar calls. */
function DashboardLiveProbe(): null {
  useDashboardLive({ enabled: true, statsKey: ["dashboard", "stats"] });
  return null;
}

/** All three streams a cold dashboard load opens, in one tree. */
function ColdDashboard(): ReactNode {
  return createElement(
    QueryClientProvider,
    { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
    createElement(RealtimeInvalidator, { tenantId: "tenant-1", role: "owner" }),
    createElement(PresenceProbe),
    createElement(DashboardLiveProbe),
  );
}

beforeEach(() => {
  resetStreamGateForTests();
  FakeEventSource.opened = [];
  idleQueue = [];
  readyStateDescriptor = Object.getOwnPropertyDescriptor(
    document,
    "readyState",
  );
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
  // A captured requestIdleCallback: the gate must genuinely wait for an idle
  // slice, and a test that let a timer supply one could not tell the two apart.
  window.requestIdleCallback = ((run: IdleRequestCallback) => {
    idleQueue.push(() => run({ didTimeout: false, timeRemaining: () => 0 }));
    return idleQueue.length;
  }) as typeof window.requestIdleCallback;
  // happy-dom reports "complete" from the start; the cold load under test has
  // not finished loading yet.
  setReadyState("loading");
});

afterEach(() => {
  act(() => {
    for (const root of roots) root.unmount();
  });
  roots.length = 0;
  document.body.innerHTML = "";
  resetStreamGateForTests();
  if (readyStateDescriptor) {
    Object.defineProperty(document, "readyState", readyStateDescriptor);
  } else {
    delete (document as unknown as { readyState?: unknown }).readyState;
  }
  delete (window as unknown as { requestIdleCallback?: unknown })
    .requestIdleCallback;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the dashboard's realtime streams and the cold load", () => {
  it("opens none of its three streams while the page is still loading", () => {
    render(ColdDashboard());

    // This is the regression. Before the gate, all three EventSources were
    // constructed here — inside the load, ahead of the chunks the shell needs.
    expect(openedUrls()).toEqual([]);
  });

  it("still opens none the instant the page finishes loading", () => {
    render(ColdDashboard());

    setReadyState("complete");
    act(() => {
      window.dispatchEvent(new Event("load"));
    });

    // `load` alone is not the signal: the render work the freshly-arrived
    // chunks trigger runs after it. The gate waits for the main thread to go
    // idle once more.
    expect(openedUrls()).toEqual([]);
  });

  it("opens all three once the page has loaded and gone idle", () => {
    render(ColdDashboard());
    setReadyState("complete");
    act(() => {
      window.dispatchEvent(new Event("load"));
    });

    act(() => runOneIdleSlice());

    const urls = openedUrls();
    expect(urls).toHaveLength(3);
    expect(urls.filter((u) => u.startsWith("/api/v1/events"))).toHaveLength(2);
    expect(
      urls.some((u) => u.includes("topics=presence.update")),
    ).toBe(true);
    expect(urls).toContain("/api/v1/dashboard/live");
  });

  it("closes a stream that unmounts before the page ever goes idle", () => {
    const stop = connectRealtimeBus(() => {});
    stop();

    setReadyState("complete");
    act(() => {
      window.dispatchEvent(new Event("load"));
      runOneIdleSlice();
    });

    // A page navigated away from during its own load must not leave a
    // connection behind for the gate to open afterwards.
    expect(openedUrls()).toEqual([]);
  });

  it("opens on the next idle slice for a stream mounted after the load", () => {
    // A client-side navigation to another dashboard route: the document is
    // already complete, so there is no `load` left to wait for.
    setReadyState("complete");
    render(ColdDashboard());

    expect(openedUrls()).toEqual([]);
    act(() => runOneIdleSlice());
    expect(openedUrls()).toHaveLength(3);
  });

  it("defers realtime rather than withholding it when load never fires", () => {
    vi.useFakeTimers();
    render(ColdDashboard());

    // A subresource that hangs rather than fails keeps `load` from firing at
    // all. Realtime is late, never lost.
    expect(openedUrls()).toEqual([]);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(openedUrls()).toHaveLength(3);
  });

  it("connects on a browser with no requestIdleCallback", () => {
    delete (window as unknown as { requestIdleCallback?: unknown })
      .requestIdleCallback;
    vi.useFakeTimers();
    render(ColdDashboard());
    setReadyState("complete");
    act(() => {
      window.dispatchEvent(new Event("load"));
    });

    expect(openedUrls()).toEqual([]);
    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    expect(openedUrls()).toHaveLength(3);
  });

  it("reconnects on its own backoff, with no second load or idle signal", () => {
    vi.useFakeTimers();
    connectRealtimeBus(() => {});
    setReadyState("complete");
    act(() => {
      window.dispatchEvent(new Event("load"));
      runOneIdleSlice();
    });
    expect(FakeEventSource.opened).toHaveLength(1);

    // The gate must not survive into the reconnect path: a dropped stream has
    // to come back on its own 1s→30s backoff.
    FakeEventSource.opened[0]!.onerror?.({});
    expect(FakeEventSource.opened).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(FakeEventSource.opened).toHaveLength(2);
  });
});
