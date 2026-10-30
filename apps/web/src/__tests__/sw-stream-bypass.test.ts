// SPDX-License-Identifier: AGPL-3.0-only
//
// The service worker used to proxy every same-origin request, including the
// dashboard's EventSource streams. A stream never ends, so each open
// EventSource held a worker-issued fetch for the life of the tab, and the
// chunk downloads the worker made behind them stalled: /app/tags sat on
// "Loading tags…" for more than 30 seconds with the worker in control and
// loaded in 2–4 seconds with it blocked. Streams — and every request the worker
// would only have passed through — must now reach the network without it.
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import { shouldBypassServiceWorker } from "@/app/sw-cache-policy";

const ORIGIN = "https://app.moosewave.test";

type FetchListener = (event: FakeFetchEvent) => void;

interface FakeFetchEvent {
  request: Request;
  respondWith: Mock<(response: Response | Promise<Response>) => void>;
  stopImmediatePropagation: () => void;
  stopped: boolean;
}

const serwistHandled: string[] = [];

vi.mock("@serwist/next/worker", () => ({ defaultCache: [] }));
vi.mock("serwist", () => {
  class Strategy {}
  class Serwist {
    addEventListeners(): void {
      // Stands in for Serwist's router: it answers every request it is given.
      (
        globalThis.self as unknown as {
          addEventListener: (type: string, fn: FetchListener) => void;
        }
      ).addEventListener("fetch", (event: FakeFetchEvent) => {
        serwistHandled.push(event.request.url);
        event.respondWith(Promise.resolve(new Response("from the worker")));
      });
    }
  }
  return {
    Serwist,
    CacheFirst: Strategy,
    ExpirationPlugin: Strategy,
    NetworkFirst: Strategy,
    NetworkOnly: Strategy,
    StaleWhileRevalidate: Strategy,
  };
});

function eventStream(path: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    headers: { Accept: "text/event-stream" },
  });
}

function navigation(path: string): Request {
  const request = new Request(`${ORIGIN}${path}`);
  Object.defineProperty(request, "mode", { value: "navigate" });
  Object.defineProperty(request, "destination", { value: "document" });
  return request;
}

beforeEach(() => {
  vi.stubGlobal("location", { origin: ORIGIN });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shouldBypassServiceWorker", () => {
  it.each([
    "/api/v1/events?topics=presence.update",
    "/api/v1/dashboard/live",
    "/api/v1/campaigns/cmp_1/events",
    // An event stream is left alone wherever it lives.
    "/_next/static/chunks/stream.js",
  ])("leaves the event stream %s to the browser", (path) => {
    const request = eventStream(path);
    expect(shouldBypassServiceWorker(request, new URL(request.url))).toBe(true);
  });

  it("leaves requests the worker could only pass through to the browser", () => {
    const passThrough = [
      new Request(`${ORIGIN}/api/v1/tags`),
      new Request(`${ORIGIN}/api/v1/tags`, { method: "POST", body: "{}" }),
      new Request(`${ORIGIN}/app/tags`, { headers: { RSC: "1" } }),
      new Request("https://fonts.gstatic.example/font.woff2"),
    ];
    for (const request of passThrough) {
      expect(
        shouldBypassServiceWorker(request, new URL(request.url)),
        `${request.method} ${request.url}`,
      ).toBe(true);
    }
  });

  it("keeps what the worker can cache and bypasses immutable Next chunks", () => {
    const cacheable = [
      new Request(`${ORIGIN}/icons/icon-192.png`),
      new Request(`${ORIGIN}/api/public/archive/acme`),
    ];
    for (const request of cacheable) {
      expect(
        shouldBypassServiceWorker(request, new URL(request.url)),
        request.url,
      ).toBe(false);
    }
    const chunk = new Request(`${ORIGIN}/_next/static/chunks/94553-abc.js`);
    expect(shouldBypassServiceWorker(chunk, new URL(chunk.url))).toBe(true);
  });

  it("keeps page loads, so a failed one can fall back to the offline page", () => {
    for (const path of ["/app/tags", "/pricing", "/login"]) {
      const request = navigation(path);
      expect(
        shouldBypassServiceWorker(request, new URL(request.url)),
        path,
      ).toBe(false);
    }
  });
});

describe("the compiled worker's fetch listeners", () => {
  // Dispatches a fetch event the way the browser does: listeners in the
  // order they were added, until one stops immediate propagation.
  async function dispatchThroughWorker(
    request: Request,
  ): Promise<FakeFetchEvent> {
    const listeners: FetchListener[] = [];
    vi.stubGlobal("self", {
      __SW_MANIFEST: [],
      location: { origin: ORIGIN },
      addEventListener(type: string, listener: FetchListener) {
        if (type === "fetch") listeners.push(listener);
      },
    });
    vi.resetModules();
    await import("@/app/sw");
    const event: FakeFetchEvent = {
      request,
      respondWith: vi.fn(),
      stopped: false,
      stopImmediatePropagation() {
        this.stopped = true;
      },
    };
    for (const listener of listeners) {
      listener(event);
      if (event.stopped) break;
    }
    return event;
  }

  beforeEach(() => {
    serwistHandled.length = 0;
  });

  it("hands an EventSource request back to the browser before Serwist sees it", async () => {
    const event = await dispatchThroughWorker(
      eventStream("/api/v1/events?topics=presence.update"),
    );

    expect(event.respondWith).not.toHaveBeenCalled();
    expect(serwistHandled).toEqual([]);
  });

  it("hands a Next chunk to the browser before Serwist sees it", async () => {
    const event = await dispatchThroughWorker(
      new Request(`${ORIGIN}/_next/static/chunks/94553-abc.js`),
    );

    expect(event.respondWith).not.toHaveBeenCalled();
    expect(event.stopped).toBe(true);
    expect(serwistHandled).toEqual([]);
  });
});
