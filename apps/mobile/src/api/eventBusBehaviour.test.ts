/**
 * CHARACTERIZATION TESTS for connectEventBus.
 *
 * The reconnect loop, the status ladder, the "streaming unsupported" exit and
 * the gap-replay ordering are the behaviours every screen's freshness depends
 * on, and only two of them had tests (the offline latch in
 * eventBusReconnect.test.ts and the stall seam in eventBusStall.test.ts).
 *
 * They are pinned here so the connector underneath can be shared with other
 * SSE routes without the bus quietly changing shape. Every assertion below
 * describes behaviour that already existed when the file was written; a failure
 * is a regression, not a new requirement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FetchCall = {
  url: string;
  init: { signal: AbortSignal; headers: Record<string, string> };
};

const fetchCalls: FetchCall[] = [];
let nextResponse: (call: FetchCall) => unknown = () => ({
  ok: true,
  status: 200,
  statusText: "OK",
  body: null,
});

vi.mock("@/lib/connectivity", () => ({ isProbablyOnline: () => true }));

vi.mock("@/store/auth", () => ({
  useAuthStore: {
    getState: () => ({
      mode: "session",
      tenantId: null,
      session: { workspaceSlug: "acme" },
      apiKey: null,
      baseUrl: "https://api.test.example",
    }),
  },
}));

vi.mock("expo/fetch", () => ({
  fetch: (url: string, init: FetchCall["init"]) => {
    const call = { url, init };
    fetchCalls.push(call);
    return Promise.resolve(asStreamResponse(nextResponse(call)));
  },
}));

/**
 * `connectSse` refuses to read a 200 whose `Content-Type` is not
 * `text/event-stream` — a JSON answer from a proxy is a failed attempt, not a
 * stream (`sseNonStreamResponse.test.ts`). Every SSE route in apps/api sets the
 * header (here, internal/events/handler.go), but the fixtures below describe
 * status + body only, so it is supplied once here instead of being repeated on
 * each. A fixture that sets its own `headers` is left as written.
 */
function asStreamResponse(res: unknown): unknown {
  const value = res as { headers?: unknown };
  if (value.headers) return res;
  return {
    ...value,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? "text/event-stream" : null,
    },
  };
}

vi.mock("./auth", () => ({
  interceptMfaRequiredResponse: (res: unknown) => Promise.resolve(res),
}));

/** A body that emits `chunks` then ends. */
function bodyOf(chunks: string[]) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    getReader: () => ({
      read: () =>
        Promise.resolve(
          i < chunks.length
            ? { done: false, value: encoder.encode(chunks[i++]) }
            : { done: true, value: undefined },
        ),
      cancel: () => Promise.resolve(),
    }),
  };
}

function frame(topic: string): string {
  return `event: ${topic}\ndata: ${JSON.stringify({
    topic,
    tenant_id: "t1",
    at: "2026-08-27T00:00:00Z",
    payload: { a: 1 },
  })}\n\n`;
}

describe("connectEventBus behaviour", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T00:00:00Z"));
    fetchCalls.length = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { get: () => "application/json" },
          text: () => Promise.resolve(JSON.stringify({ token: "pws_tok" })),
          json: () => Promise.resolve({ token: "pws_tok" }),
        }),
      ),
    );
    nextResponse = () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("requests the topic CSV, the tenant slug header and a minted stream token", async () => {
    const { connectEventBus } = await import("./eventBus");
    const stop = connectEventBus(
      ["campaign.sent"],
      () => {},
      () => {},
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls[0]!;
    expect(call.url).toContain("/api/v1/events?topics=campaign.sent");
    expect(call.url).toContain("stream_token=pws_tok");
    expect(call.init.headers.Accept).toBe("text/event-stream");
    expect(call.init.headers["X-Tenant-Slug"]).toBe("acme");
    stop();
  });

  it("reports connecting then open, and closed on disconnect", async () => {
    const { connectEventBus } = await import("./eventBus");
    const statuses: string[] = [];
    nextResponse = () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: bodyOf([frame("campaign.sent")]),
    });

    const stop = connectEventBus(
      ["campaign.sent"],
      () => {},
      (s) => statuses.push(s),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.slice(0, 2)).toEqual(["connecting", "open"]);

    stop();
    expect(statuses[statuses.length - 1]).toBe("closed");
  });

  it("dispatches parsed frames to onEvent", async () => {
    const { connectEventBus } = await import("./eventBus");
    const seen: string[] = [];
    nextResponse = () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: bodyOf([frame("campaign.sent"), frame("subscriber.added")]),
    });

    const stop = connectEventBus(["campaign.*"], (evt) => seen.push(evt.topic));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["campaign.sent", "subscriber.added"]);
    stop();
  });

  it("reports `unsupported` and stops when the runtime gives no body", async () => {
    const { connectEventBus } = await import("./eventBus");
    const statuses: string[] = [];
    const stop = connectEventBus(
      ["campaign.sent"],
      () => {},
      (s) => statuses.push(s),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses).toContain("unsupported");

    // No retry is scheduled: a runtime without streaming will not grow one.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchCalls).toHaveLength(1);
    stop();
  });

  it("retries with backoff after a non-OK open", async () => {
    const { connectEventBus } = await import("./eventBus");
    nextResponse = () => ({
      ok: false,
      status: 503,
      statusText: "Unavailable",
    });
    const stop = connectEventBus(
      ["campaign.sent"],
      () => {},
      () => {},
      {
        random: () => 1,
      },
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCalls).toHaveLength(1);
    // First backoff is 1s with the deterministic jitter source.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchCalls).toHaveLength(2);
    // Second is 2s: still exponential, not a hot loop.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchCalls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchCalls).toHaveLength(3);
    stop();
  });

  it("stops reconnecting once disconnected", async () => {
    const { connectEventBus } = await import("./eventBus");
    nextResponse = () => ({
      ok: false,
      status: 503,
      statusText: "Unavailable",
    });
    const stop = connectEventBus(
      ["campaign.sent"],
      () => {},
      () => {},
      {
        random: () => 1,
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchCalls).toHaveLength(1);
  });

  it("runs gap replay BEFORE the first live frame is dispatched", async () => {
    const { connectEventBus } = await import("./eventBus");
    const order: string[] = [];
    nextResponse = () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: bodyOf([frame("campaign.sent")]),
    });

    const stop = connectEventBus(
      ["campaign.*"],
      () => order.push("live"),
      undefined,
      {
        onBeforeTail: async () => {
          order.push("replay");
        },
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["replay", "live"]);
    stop();
  });

  it("survives a gap replay that rejects", async () => {
    const { connectEventBus } = await import("./eventBus");
    const seen: string[] = [];
    nextResponse = () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: bodyOf([frame("campaign.sent")]),
    });

    const stop = connectEventBus(
      ["campaign.*"],
      (e) => seen.push(e.topic),
      undefined,
      {
        onBeforeTail: () => Promise.reject(new Error("replay down")),
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["campaign.sent"]);
    stop();
  });
});
