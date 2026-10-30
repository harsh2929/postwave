/**
 * Regression: the stall counter the Diagnostics screen prints could never
 * leave zero.
 *
 * `createStallWatchdog` has always fired on a silent socket, and
 * `noteEventBusStall` has always existed in lib/eventBusStatus.ts — but the
 * two were never connected. `ConnectEventBusOptions` declared only
 * `onBeforeTail`/`stallTimeoutMs`/`random`, so there was no seam for a caller
 * to observe the watchdog at all, and the diagnostics row that reads
 * "stalls / pauses" reported a hard-coded 0 for the exact failure (NATIVE#9)
 * it was built to expose.
 *
 * These tests assert the seam, not the counter: that a silent socket invokes
 * the caller's `onStall` exactly once per stall, and that a throwing observer
 * cannot stop the reconnect it is reporting on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchSpy = vi.fn();

vi.mock("@/lib/connectivity", () => ({
  isProbablyOnline: () => true,
}));

vi.mock("@/store/auth", () => ({
  useAuthStore: {
    getState: () => ({
      mode: "session",
      tenantId: null,
      session: { workspaceSlug: null },
      apiKey: null,
      // A real base URL is required: the transport resolves the MFA-intercept
      // origin with `new URL(url)`, which throws on a bare path.
      baseUrl: "https://api.test.example",
    }),
  },
}));

/** A body whose reader never resolves until the request is aborted. */
function silentBody(signal: AbortSignal) {
  return {
    getReader() {
      return {
        read: () =>
          new Promise<{ done: boolean; value?: Uint8Array }>(
            (resolve, reject) => {
              signal.addEventListener("abort", () =>
                reject(new Error("aborted")),
              );
            },
          ),
        cancel: () => Promise.resolve(),
      };
    },
  };
}

vi.mock("expo/fetch", () => ({
  fetch: (url: unknown, init: { signal: AbortSignal }) => {
    fetchSpy(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      // The route (internal/events/handler.go) declares the stream type, and
      // `connectSse` will not read a body without it — a 200 that is not an
      // event stream is a failed attempt (`sseNonStreamResponse.test.ts`), and
      // a failed attempt never arms the stall watchdog under test here.
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "text/event-stream" : null,
      },
      body: silentBody(init.signal),
    });
  },
}));

vi.mock("./auth", () => ({
  interceptMfaRequiredResponse: (res: unknown) => Promise.resolve(res),
}));

describe("connectEventBus onStall", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Pin the clock: the watchdog treats a non-positive `lastFrameAt` as
    // "unknown" and never fires, so a clock starting at 0 would make these
    // tests pass for the wrong reason.
    vi.setSystemTime(new Date("2026-08-27T00:00:00Z"));
    fetchSpy.mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // The stream-token mint is a plain global fetch; a 401 makes
    // buildEventBusConnection fall through to the un-tokened URL.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({ ok: false, status: 401, statusText: "Unauthorized" }),
      ),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("reports a watchdog-forced reconnect to the caller", async () => {
    const { connectEventBus } = await import("./eventBus");
    const onStall = vi.fn();

    const disconnect = connectEventBus(
      ["campaign.sent"],
      () => {},
      () => {},
      { stallTimeoutMs: 5_000, onStall, random: () => 1 },
    );

    // Let the open() await chain settle so the reader loop is armed.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(onStall).not.toHaveBeenCalled();

    // Silence past the watchdog window: the socket said nothing, not even a
    // keepalive comment. The watchdog evaluates on an interval capped at the
    // timeout, so the first tick that can observe the stall is the second one.
    await vi.advanceTimersByTimeAsync(11_000);
    expect(onStall).toHaveBeenCalledTimes(1);

    disconnect();
  });

  it("does not fire while the socket is alive", async () => {
    const { connectEventBus } = await import("./eventBus");
    const onStall = vi.fn();

    const disconnect = connectEventBus(
      ["campaign.sent"],
      () => {},
      () => {},
      { stallTimeoutMs: 60_000, onStall, random: () => 1 },
    );

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onStall).not.toHaveBeenCalled();

    disconnect();
  });

  it("still reconnects when the observer throws", async () => {
    const { connectEventBus } = await import("./eventBus");
    const onStall = vi.fn(() => {
      throw new Error("diagnostics blew up");
    });

    const disconnect = connectEventBus(
      ["campaign.sent"],
      () => {},
      () => {},
      { stallTimeoutMs: 5_000, onStall, random: () => 1 },
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(11_000);
    expect(onStall).toHaveBeenCalledTimes(1);

    // The abort must still have happened, so the backoff timer runs and a
    // second connection attempt is made.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    disconnect();
  });
});
