/**
 * Regression: the event bus must survive being started while offline.
 *
 * `open()` guards against overlapping connection attempts with an `opening`
 * latch. The latch is released in a `finally` block — but the offline check
 * returns BEFORE the `try` that owns that `finally`, so an attempt made while
 * offline set `opening = true` and never cleared it. Every later attempt then
 * hit `if (stopped || opening) return` and died on the first line.
 *
 * That is permanent for the life of the connection: the retry timer keeps
 * firing, each call returns immediately, and realtime never comes back until
 * the process restarts. Launching in a lift, on a plane, or on a flaky train
 * connection is enough to trigger it.
 *
 * The `if (stopped)` branch three lines below the offline check clears the
 * latch explicitly, which shows the pre-`try` returns were known about — the
 * offline path was simply the one that got missed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const online = { value: true };
const fetchSpy = vi.fn();

vi.mock("@/lib/connectivity", () => ({
  isProbablyOnline: () => online.value,
}));

vi.mock("@/store/auth", () => ({
  useAuthStore: {
    getState: () => ({
      mode: "session",
      tenantId: null,
      session: { workspaceSlug: null },
      apiKey: null,
      // No baseUrl: buildEventBusConnection returns the bare path without
      // minting a stream token, so the test never needs a token endpoint.
      baseUrl: null,
    }),
  },
}));

vi.mock("expo/fetch", () => ({
  fetch: (...args: unknown[]) => {
    fetchSpy(...args);
    // A body-less 200 makes open() take its "streaming unsupported" exit,
    // which is a clean terminal state for the purposes of this test. The
    // content type has to be the stream's: `connectSse` checks it first and
    // treats anything else as a failed attempt that keeps retrying, which
    // would no longer be terminal (`sseNonStreamResponse.test.ts`).
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "text/event-stream" : null,
      },
      body: null,
    });
  },
}));

vi.mock("./auth", () => ({
  interceptMfaRequiredResponse: (res: unknown) => Promise.resolve(res),
}));

describe("event bus reconnects after starting offline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy.mockClear();
    online.value = true;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it("still connects once connectivity returns", async () => {
    const { connectEventBus } = await import("./eventBus");

    online.value = false;
    const disconnect = connectEventBus(
      ["campaign.sent"],
      () => {},
      () => {},
      {
        // Deterministic jitter so the retry delay is exactly backoffMs.
        random: () => 1,
      },
    );

    // The first attempt is made while offline and must not fetch.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Connectivity returns before the retry timer fires.
    online.value = true;
    await vi.advanceTimersByTimeAsync(60_000);

    // With the latch leaked, every retry returns on `if (opening) return`
    // and this stays at zero forever.
    expect(fetchSpy).toHaveBeenCalled();
    disconnect();
  });

  it("keeps retrying across several offline attempts", async () => {
    const { connectEventBus } = await import("./eventBus");

    online.value = false;
    const disconnect = connectEventBus(
      ["campaign.sent"],
      () => {},
      () => {},
      {
        random: () => 1,
      },
    );

    // Several retry cycles all while offline — the latch must not accumulate.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchSpy).not.toHaveBeenCalled();

    online.value = true;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchSpy).toHaveBeenCalled();
    disconnect();
  });
});
