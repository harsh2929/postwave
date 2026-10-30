// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Reproduced on staging: /api/* was unreachable for six seconds, then came
// back. The one failed health probe had already set the status to "offline",
// which the TanStack bridge turns into setOnline(false), pausing every query.
// navigator.onLine never changed, so no DOM `online` event fired, and the only
// way back was the 30-second heartbeat: "Loading tags…" stayed on screen for
// 24 seconds after the network had recovered, with nothing sent in between.
//
// The network here is the transport every request and probe share
// (lib/http-fetch), switched off and on; everything above it is real.
import { QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({
  up: true,
  healthProbes: 0,
}));

vi.mock("@/lib/http-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/http-fetch")>();
  return {
    ...actual,
    httpFetch: vi.fn(async (url: string) => {
      if (url.endsWith("/api/health")) network.healthProbes += 1;
      if (!network.up) {
        return {
          err: new TypeError("Failed to fetch"),
          exhausted: true,
          attempts: 1,
          timedOut: false,
        };
      }
      const body = url.endsWith("/api/health")
        ? { status: "ok" }
        : { data: [{ id: "tag_1", name: "VIP" }] };
      return {
        res: new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        exhausted: false,
        attempts: 1,
        timedOut: false,
      };
    }),
  };
});

type OnlineManagerModule = typeof import("@/lib/online-manager");

let manager: OnlineManagerModule;
let stopManager: (() => void) | null = null;

async function freshManager(): Promise<OnlineManagerModule> {
  vi.resetModules();
  manager = await import("@/lib/online-manager");
  return manager;
}

// Lets pending promise callbacks run without moving the clock.
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-09-15T12:00:00Z") });
  network.up = true;
  network.healthProbes = 0;
});

afterEach(() => {
  stopManager?.();
  stopManager = null;
  vi.useRealTimers();
});

describe("online manager recovery", () => {
  it("treats one failed probe as a blip, not as offline", async () => {
    const { startOnlineManager, getOnlineStatus } = await freshManager();
    network.up = false;
    stopManager = startOnlineManager();
    await settle();

    expect(network.healthProbes).toBe(1);
    expect(getOnlineStatus()).toBe("connecting");
  });

  it("comes back online within two seconds when a probe fails once and the next succeeds", async () => {
    const { startOnlineManager, getOnlineStatus } = await freshManager();
    network.up = false;
    stopManager = startOnlineManager();
    await settle();
    network.up = true;

    await vi.advanceTimersByTimeAsync(2_000);

    expect(getOnlineStatus()).toBe("online");
  });

  it("declares offline after two failures and re-probes on a short backoff until the network returns", async () => {
    const { startOnlineManager, getOnlineStatus } = await freshManager();
    network.up = false;
    stopManager = startOnlineManager();
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getOnlineStatus()).toBe("offline");

    // Still down: the manager keeps asking, well inside the old 30s heartbeat.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(network.healthProbes).toBeGreaterThanOrEqual(4);
    expect(getOnlineStatus()).toBe("offline");

    network.up = true;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(getOnlineStatus()).toBe("online");
  });

  it("probes once for a burst of failed requests instead of guessing offline", async () => {
    const { noteRequestFailure, getOnlineStatus, setOnlineStatusForTest } =
      await freshManager();
    setOnlineStatusForTest("online");
    network.up = false;

    noteRequestFailure();
    noteRequestFailure();
    noteRequestFailure();
    await settle();

    expect(network.healthProbes).toBe(1);
    expect(getOnlineStatus()).toBe("connecting");
  });

  it("returns to online the moment a real request succeeds", async () => {
    const { startOnlineManager, noteRequestSuccess, getOnlineStatus } =
      await freshManager();
    network.up = false;
    stopManager = startOnlineManager();
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getOnlineStatus()).toBe("offline");

    noteRequestSuccess();

    expect(getOnlineStatus()).toBe("online");
  });
});

describe("paused queries after an outage", () => {
  it("resume and load within two seconds of the network coming back", async () => {
    const { startOnlineManager } = await freshManager();
    const { installTanstackOnlineBridge } = await import(
      "@/lib/tanstack-online-bridge"
    );
    const { makeQueryClient } = await import("@/lib/query-client");
    const { api } = await import("@/lib/api");

    network.up = false;
    stopManager = startOnlineManager();
    installTanstackOnlineBridge();
    const client = makeQueryClient();
    // What QueryClientProvider does on mount: subscribe the client to the
    // online manager, which is what resumes paused queries.
    client.mount();
    const observer = new QueryObserver(client, {
      queryKey: ["tags", "outage-recovery"],
      queryFn: () => api.get<{ data: unknown[] }>("/api/v1/tags"),
    });
    const seen: string[] = [];
    const unsubscribe = observer.subscribe((result) => {
      seen.push(result.fetchStatus);
    });

    // A six-second outage: every request and probe fails.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(observer.getCurrentResult().data).toBeUndefined();
    expect(seen).toContain("paused");

    network.up = true;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(observer.getCurrentResult().status).toBe("success");
    expect(observer.getCurrentResult().data).toEqual({
      data: [{ id: "tag_1", name: "VIP" }],
    });
    unsubscribe();
    client.unmount();
    client.clear();
  });
});
