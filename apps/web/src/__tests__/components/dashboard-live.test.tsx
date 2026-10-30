// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// analytics-29: the live home dashboard (desktop useDashboardData.ts:1029 +
// StaleIndicator / LiveSubsChip / ActiveSendStrip).
//
// The server (internal/analytics/dashboard_live.go) sends every snapshot as a
// NAMED `event: stats` frame and a failed refresh as a named `event: error`
// frame. EventSource routes named frames ONLY to listeners registered for that
// name — never to `onmessage` — so this fake dispatches exactly the way a
// browser does. Asserts the consequences: the stream opened is
// GET /api/v1/dashboard/live with credentials; a `stats` frame REPLACES the
// cached dashboard/stats snapshot (and the chip bound to that cache re-renders
// with the new total); the server's own failure sentence is shown; a malformed
// frame changes nothing; unmount closes the stream.
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/use-online", () => ({ useOnline: () => "online" }));

import type { DashboardStats } from "@/lib/analytics-api";
import { subscribeDashboardLive } from "@/lib/live-streams-api";
import {
  openStreamGateForTests,
  resetStreamGateForTests,
} from "@/lib/realtime/stream-gate";
import {
  ActiveSendStrip,
  DashboardLiveBar,
} from "@/components/dashboard/dashboard-live";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    super();
    FakeEventSource.instances.push(this);
  }

  open(): void {
    this.onopen?.(new Event("open"));
  }

  /** Browser semantics: a named frame reaches only listeners for that name. */
  emit(name: string | null, data: string): void {
    const event = new MessageEvent(name ?? "message", { data });
    if (name === null) this.onmessage?.(event);
    if (name === "error") this.onerror?.(event);
    this.dispatchEvent(event);
  }

  close(): void {
    this.closed = true;
  }
}

const STATS_KEY = ["dashboard", "tenant-1", "admin", "stats", "user-1"];

function stats(total: number, added = 12): DashboardStats {
  return {
    subscribers_total: total,
    subscribers_added_30d: added,
    subscribers_unsubbed_30d: 0,
    campaigns_sent_30d: 1,
    opens_total_30d: 10,
    clicks_total_30d: 2,
    bounces_total_30d: 0,
  };
}

const roots: Root[] = [];
let client: QueryClient;

// The gate that defers a stream's first open until the page has loaded
// and gone idle (lib/realtime/stream-gate.ts) is opened up front here:
// these tests are about what a stream does once connected. WHEN it opens
// is proved in realtime-stream-gate.test.ts.
beforeEach(() => {
  resetStreamGateForTests();
  openStreamGateForTests();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function render(ui: ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(createElement(QueryClientProvider, { client }, ui)),
  );
  return host;
}

/** Mirrors the home page mount: the bar reads the same stats query. */
function Harness({ campaigns }: { campaigns?: unknown[] }) {
  const query = useQuery({
    queryKey: STATS_KEY,
    queryFn: async () => stats(1_000),
  });
  return createElement(DashboardLiveBar, {
    enabled: true,
    statsKey: STATS_KEY,
    stats: query.data ?? null,
    statsUpdatedAt: query.dataUpdatedAt,
    campaigns: (campaigns ?? []) as never,
  });
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Render, then wait until the seeded stats query has painted the chip. */
async function renderHarness(campaigns?: unknown[]): Promise<HTMLElement> {
  const el = render(createElement(Harness, { campaigns }));
  for (let i = 0; i < 40; i += 1) {
    if (el.querySelector('[data-testid="live-subs-chip"]')) return el;
    await flush();
  }
  throw new Error("stats query never rendered");
}

describe("subscribeDashboardLive", () => {
  it("binds the server's named `stats` frames and its `error` sentence", () => {
    const onEvent = vi.fn((_data: unknown) => undefined);
    const onServerError = vi.fn((_data: unknown) => undefined);
    const stop = subscribeDashboardLive({ onEvent, onServerError });
    const source = FakeEventSource.instances[0];
    expect(source?.url).toBe("/api/v1/dashboard/live");
    expect(source?.init).toEqual({ withCredentials: true });

    source?.emit("stats", JSON.stringify(stats(7)));
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]?.[0]).toEqual(stats(7));

    // A transport failure is a plain Event with no sentence to show.
    source?.dispatchEvent(new Event("error"));
    expect(onServerError).not.toHaveBeenCalled();
    source?.emit(
      "error",
      JSON.stringify({ code: "analytics_stream_unavailable", message: "Nope." }),
    );
    expect(onServerError).toHaveBeenCalledWith({
      code: "analytics_stream_unavailable",
      message: "Nope.",
    });

    stop();
    expect(source?.closed).toBe(true);
  });
});

describe("DashboardLiveBar", () => {
  it("replaces the cached stats snapshot with each live frame", async () => {
    const el = await renderHarness();
    const source = FakeEventSource.instances[0];
    expect(source?.url).toBe("/api/v1/dashboard/live");
    expect(source?.init).toEqual({ withCredentials: true });

    const chip = () => el.querySelector('[data-testid="live-subs-chip"]');
    expect(chip()?.textContent).toContain("1,000");

    act(() => source?.open());
    const indicator = el.querySelector(
      '[data-testid="dashboard-live-indicator"]',
    );
    expect(indicator?.getAttribute("data-live-status")).toBe("open");
    expect(indicator?.textContent).toContain("Live updates on");

    const before = client.getQueryState(STATS_KEY)?.dataUpdatedAt ?? 0;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      source?.emit("stats", JSON.stringify(stats(1_234, 40)));
    });
    // TanStack batches observer notifications onto the next tick.
    await flush();
    expect(client.getQueryData(STATS_KEY)).toEqual(stats(1_234, 40));
    expect(client.getQueryState(STATS_KEY)?.dataUpdatedAt).toBeGreaterThan(
      before,
    );
    expect(chip()?.textContent).toContain("1,234");
    expect(chip()?.textContent).toContain("+40");
    expect(chip()?.getAttribute("href")).toBe("/app/subscribers");
  });

  it("ignores a frame that is not a stats snapshot", async () => {
    const el = await renderHarness();
    const source = FakeEventSource.instances[0];
    act(() => {
      source?.emit("stats", "not json");
      source?.emit("stats", JSON.stringify({ subscribers_total: "lots" }));
    });
    await flush();
    expect(client.getQueryData(STATS_KEY)).toEqual(stats(1_000));
    expect(
      el.querySelector('[data-testid="live-subs-chip"]')?.textContent,
    ).toContain("1,000");
  });

  it("renders the server's failure sentence and reports reconnecting", async () => {
    const el = await renderHarness();
    const source = FakeEventSource.instances[0];
    act(() => source?.open());
    act(() =>
      source?.emit(
        "error",
        JSON.stringify({
          code: "analytics_stream_unavailable",
          message: "Live analytics could not be refreshed. Reconnect to retry.",
        }),
      ),
    );
    expect(el.querySelector('[role="alert"]')?.textContent).toBe(
      "Live analytics could not be refreshed. Reconnect to retry.",
    );
    const indicator = el.querySelector(
      '[data-testid="dashboard-live-indicator"]',
    );
    expect(indicator?.getAttribute("data-live-status")).toBe("connecting");
    expect(indicator?.textContent).toContain("Polling every 60s");

    // Recovery: the next real snapshot clears the failure.
    act(() => source?.emit("stats", JSON.stringify(stats(1_001))));
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it("closes the stream on unmount", async () => {
    await renderHarness();
    const source = FakeEventSource.instances[0];
    expect(source?.closed).toBe(false);
    for (const root of roots.splice(0)) act(() => root.unmount());
    expect(source?.closed).toBe(true);
  });
});

describe("ActiveSendStrip", () => {
  it("links the campaign that is sending, with its rates", () => {
    const el = render(
      createElement(ActiveSendStrip, {
        campaigns: [
          { id: "c-draft", name: "Draft", status: "draft" },
          {
            id: "c-live",
            name: "September launch",
            status: "sending",
            open_rate: 0.224,
            click_rate: 0.031,
          },
        ],
      }),
    );
    const link = el.querySelector('[data-testid="active-send-strip"]');
    expect(link?.getAttribute("href")).toBe("/app/campaigns/c-live");
    expect(link?.textContent).toContain("Sending");
    expect(link?.textContent).toContain("September launch");
    expect(link?.textContent).toContain("22.4% open");
    expect(link?.textContent).toContain("3.1% click");
  });

  it("renders nothing when no campaign is sending", () => {
    const el = render(
      createElement(ActiveSendStrip, {
        campaigns: [{ id: "c1", name: "Done", status: "sent" }],
      }),
    );
    expect(el.querySelector('[data-testid="active-send-strip"]')).toBeNull();
  });
});
