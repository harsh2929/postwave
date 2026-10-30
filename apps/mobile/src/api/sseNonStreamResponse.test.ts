/**
 * Regression: a 200 that is not an event stream must not become a reconnect
 * storm.
 *
 * MEASURED ON A SIMULATOR, IDLE, IN A 60-SECOND WINDOW: 215 requests — 72
 * `POST /api/v1/streams/token`, 72 `GET /api/v1/events`, 71 `GET
 * /api/v1/events/replay`. Nothing was wrong with the phone: the endpoint
 * answered 200 with a JSON body, and `connectSse` had no reason to notice.
 * `Accept: text/event-stream` was sent but the response's `Content-Type` was
 * never read, so the JSON document was fed to the SSE reader, arrived as one
 * chunk (`sawData = true`), and ended. `shouldResetBackoff` returned true on
 * its first line, pinning the ladder at `EVENT_BUS_INITIAL_BACKOFF_MS`, and the
 * whole cycle — token mint, open, gap replay — ran again ~1s later. Forever.
 * `MIN_HEALTHY_OPEN_MS` exists for exactly this and never got a vote.
 *
 * These tests drive `connectSse` directly rather than through `connectEventBus`
 * so the transport rule is pinned where it lives, and they count REQUESTS over
 * a wall-clock window because that is the unit the defect was measured in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SseFrame, SseStatus } from "./sseConnect";

interface FakeBody {
  getReader: () => {
    read: () => Promise<{ done: boolean; value: Uint8Array | undefined }>;
    cancel: () => Promise<void>;
  };
  /** A real `ReadableStream` can be dropped whole; the fix uses that. */
  cancel: () => Promise<void>;
}

const fetchCalls: string[] = [];
let bodyCancels = 0;
let nextResponse: () => unknown = () => ({
  ok: true,
  status: 200,
  statusText: "OK",
  headers: { get: () => null },
  body: null,
});

vi.mock("@/lib/connectivity", () => ({
  isProbablyOnline: () => true,
}));

vi.mock("./auth", () => ({
  interceptMfaRequiredResponse: (res: unknown) => Promise.resolve(res),
}));

vi.mock("expo/fetch", () => ({
  fetch: (url: string) => {
    fetchCalls.push(url);
    return Promise.resolve(nextResponse());
  },
}));

/** A body that emits `chunks` then ends, like a server closing the socket. */
function bodyOf(chunks: string[]): FakeBody {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    getReader: () => ({
      read: () =>
        Promise.resolve(
          i < chunks.length
            ? { done: false, value: encoder.encode(chunks[i++] ?? "") }
            : { done: true, value: undefined },
        ),
      cancel: () => Promise.resolve(),
    }),
    cancel: () => {
      bodyCancels += 1;
      return Promise.resolve();
    },
  };
}

function respond(contentType: string | null, body: FakeBody | null): unknown {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? contentType : null,
    },
    body,
  };
}

const URL_UNDER_TEST = "https://api.example.test/api/v1/events";

function harness() {
  const frames: SseFrame[] = [];
  const statuses: SseStatus[] = [];
  let replays = 0;
  return {
    frames,
    statuses,
    get replays(): number {
      return replays;
    },
    options: {
      // Called on EVERY attempt in the real client — this is the stream-token
      // mint whose 72 calls/minute were half the measured storm.
      buildRequest: () => Promise.resolve({ url: URL_UNDER_TEST }),
      onFrame: (frame: SseFrame) => frames.push(frame),
      onStatus: (status: SseStatus) => statuses.push(status),
      onBeforeTail: () => {
        replays += 1;
        return Promise.resolve();
      },
      // Deterministic equal-jitter roll: `jitteredBackoff` returns exactly the
      // base delay, so the retry schedule below is arithmetic, not a guess.
      random: () => 1,
      label: "test-stream",
    },
  };
}

describe("connectSse against a response that is not an event stream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T00:00:00Z"));
    fetchCalls.length = 0;
    bodyCancels = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("backs off instead of reconnecting every second at a JSON 200", async () => {
    const { connectSse } = await import("./sseConnect");
    nextResponse = () =>
      respond(
        "application/json; charset=utf-8",
        bodyOf(['{"error":"upstream is not the stream route"}']),
      );

    const h = harness();
    const disconnect = connectSse(h.options);
    await vi.advanceTimersByTimeAsync(60_000);
    disconnect();

    // The backoff ladder with a pinned jitter roll: attempts at t = 0, 1s, 3s,
    // 7s, 15s, 31s — the next one is due at 61s, outside the window. Six.
    //
    // With the defect, every attempt reset the ladder to 1s and this window
    // held 61 of them (the app measured 72 with a real network's timing).
    expect(fetchCalls).toHaveLength(6);
    // Not a stream, so: no frames from the JSON document, never reported
    // "open", and no gap replay — the third request in the measured storm.
    expect(h.frames).toEqual([]);
    expect(h.statuses).not.toContain("open");
    expect(h.replays).toBe(0);
    // The socket we declined to read is released rather than left dangling.
    expect(bodyCancels).toBe(6);
  });

  it("refuses a stream body that arrives with no content-type at all", async () => {
    const { connectSse } = await import("./sseConnect");
    nextResponse = () =>
      respond(null, bodyOf(['data: {"topic":"campaign.sent"}\n\n']));

    const h = harness();
    const disconnect = connectSse(h.options);
    await vi.advanceTimersByTimeAsync(60_000);
    disconnect();

    expect(fetchCalls).toHaveLength(6);
    expect(h.frames).toEqual([]);
  });
});

describe("connectSse against a genuine event stream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T00:00:00Z"));
    fetchCalls.length = 0;
    bodyCancels = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("still delivers frames and replays the gap when the type carries parameters", async () => {
    const { connectSse } = await import("./sseConnect");
    nextResponse = () =>
      respond(
        "text/event-stream; charset=utf-8",
        bodyOf(['event: campaign.sent\ndata: {"topic":"campaign.sent"}\n\n']),
      );

    const h = harness();
    const disconnect = connectSse(h.options);
    await vi.advanceTimersByTimeAsync(0);
    disconnect();

    expect(h.frames).toEqual([
      { event: "campaign.sent", data: '{"topic":"campaign.sent"}' },
    ]);
    expect(h.statuses).toContain("open");
    expect(h.replays).toBe(1);
    // A body we DID read is drained by the reader, not cancelled wholesale.
    expect(bodyCancels).toBe(0);
  });

  it("keeps letting a keepalive comment reset the backoff", async () => {
    const { connectSse } = await import("./sseConnect");
    // A comment-only chunk carries no frame but proves the server is alive.
    // This is the behaviour the fix must NOT take away: a short-lived stream
    // that said `:keepalive` earns a prompt retry at the initial backoff.
    nextResponse = () =>
      respond("text/event-stream", bodyOf([":keepalive\n\n"]));

    const h = harness();
    const disconnect = connectSse(h.options);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCalls).toHaveLength(1);

    // Reset ⇒ the retry is one initial backoff away, and so is the one after
    // it. Without the reset the second gap would be 2s and this would be 2.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchCalls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchCalls).toHaveLength(3);

    expect(h.frames).toEqual([]);
    disconnect();
  });
});
