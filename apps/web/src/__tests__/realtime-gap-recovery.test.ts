// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Gap recovery for the realtime stream.
//
// SSE has no redelivery. Everything published while a client's connection was
// down is simply lost, and the UI stays quietly wrong until some query's
// staleTime happens to expire — no error, no retry, no log. The server has had
// `GET /api/v1/events/replay` the whole time and no client called it.
//
// These tests drive the real `connectRealtimeBus` through a fake EventSource so
// the reconnect path is exercised end to end, not just the pure cursor rules
// (which live in @postwave/query-contract's own suite).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EMPTY_REPLAY_CURSOR,
  advanceReplayCursor,
  replayRequestPath,
} from "@postwave/query-contract";

import { connectRealtimeBus } from "@/lib/realtime/event-bus-client";
import {
  openStreamGateForTests,
  resetStreamGateForTests,
} from "@/lib/realtime/stream-gate";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: MessageEvent<string>) => void) | null = null;
  readonly listeners = new Map<string, (ev: MessageEvent<string>) => void>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, fn: (ev: MessageEvent<string>) => void): void {
    this.listeners.set(name, fn);
  }
  close(): void {
    this.closed = true;
  }
  /** Deliver a named server event, as EventSource would. */
  emit(topic: string, data: Record<string, unknown>): void {
    const handler = this.listeners.get(topic);
    handler?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

let fetchMock: ReturnType<typeof vi.fn>;

// The gate that defers a stream's first open until the page has loaded
// and gone idle (lib/realtime/stream-gate.ts) is opened up front here:
// these tests are about what a stream does once connected. WHEN it opens
// is proved in realtime-stream-gate.test.ts.
beforeEach(() => {
  resetStreamGateForTests();
  openStreamGateForTests();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function replayBody(events: unknown[], over: Record<string, unknown> = {}) {
  return {
    ok: true,
    // `next_cursor: null` is what an idle page really returns. It used to be
    // hardcoded to 0 here, which is the value the server emits AND the value
    // that poisons the cursor — so the fixture agreed with the bug and every
    // assertion below was made against a walk that never moved.
    json: async () => ({
      events,
      next_cursor: null,
      next_since_at: "",
      has_more: false,
      ...over,
    }),
  };
}

describe("gap recovery on reconnect", () => {
  it("does NOT replay on the first connection", async () => {
    // A first open has no gap by definition. Replaying from nothing would
    // deliver the entire retained log and invalidate every cache for free.
    const disconnect = connectRealtimeBus(() => {});
    FakeEventSource.instances[0]!.onopen?.({});
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    disconnect();
  });

  it("replays from the last event seen after a dropped connection", async () => {
    const seen: string[] = [];
    const disconnect = connectRealtimeBus((evt) => seen.push(evt.topic));
    const first = FakeEventSource.instances[0]!;
    first.onopen?.({});

    // A live event establishes the cursor.
    first.emit("campaign.sent", {
      topic: "campaign.sent",
      ts: "2026-08-04T09:00:00Z",
    });
    expect(seen).toEqual(["campaign.sent"]);

    // Drop and reconnect.
    fetchMock.mockResolvedValueOnce(
      replayBody([
        { topic: "subscriber.bounced", ts: "2026-08-04T09:01:00Z" },
        { topic: "campaign.created", ts: "2026-08-04T09:02:00Z" },
      ]),
    );
    first.onerror?.({});
    await vi.advanceTimersByTimeAsync(1_500);
    const second = FakeEventSource.instances[1]!;
    second.onopen?.({});
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("/api/v1/events/replay");
    // Resumed by TIME: the live payload carries `ts`, never a sequence id —
    // widened by the skew grace, because `at` is stamped by whichever replica
    // published the event and a lagging one writes rows behind this cursor.
    expect(url).toContain("since_at=2026-08-04T08%3A59%3A55.000Z");
    // The missed events were delivered through the SAME handler as live ones.
    expect(seen).toEqual([
      "campaign.sent",
      "subscriber.bounced",
      "campaign.created",
    ]);
    disconnect();
  });

  it("keeps the stream alive when replay fails", async () => {
    // Recovery is best-effort. An exception on the reconnect path would take
    // the live subscription down too, turning a recoverable gap into no
    // realtime at all.
    const seen: string[] = [];
    const disconnect = connectRealtimeBus((evt) => seen.push(evt.topic));
    const first = FakeEventSource.instances[0]!;
    first.onopen?.({});
    first.emit("campaign.sent", {
      topic: "campaign.sent",
      ts: "2026-08-04T09:00:00Z",
    });

    fetchMock.mockRejectedValueOnce(new Error("offline"));
    first.onerror?.({});
    await vi.advanceTimersByTimeAsync(1_500);
    const second = FakeEventSource.instances[1]!;
    second.onopen?.({});
    await flush();

    // Live delivery still works after the failed recovery.
    second.emit("approval.requested", {
      topic: "approval.requested",
      ts: "2026-08-04T09:10:00Z",
    });
    expect(seen).toEqual(["campaign.sent", "approval.requested"]);
    disconnect();
  });

  it("follows has_more but stops at the page ceiling", async () => {
    // A client back after hours must not spin through the whole retained log:
    // the newest window restores freshness and older events are past the
    // staleTime that would have refetched them anyway.
    const disconnect = connectRealtimeBus(() => {});
    const first = FakeEventSource.instances[0]!;
    first.onopen?.({});
    first.emit("campaign.sent", {
      topic: "campaign.sent",
      ts: "2026-08-04T09:00:00Z",
    });

    let n = 0;
    fetchMock.mockImplementation(async () => {
      n += 1;
      return replayBody([{ topic: "campaign.sent", ts: `2026-08-04T10:0${n}:00Z` }], {
        has_more: true,
        next_cursor: 900 + n,
        next_since_at: `2026-08-04T10:0${n}:00Z`,
      });
    });

    first.onerror?.({});
    await vi.advanceTimersByTimeAsync(1_500);
    FakeEventSource.instances[1]!.onopen?.({});
    await flush();

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(5);
    // Each page must ask for a DIFFERENT window. The earlier version of this
    // test asserted only the call count, so it passed while the client issued
    // the same request five times.
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(new Set(urls).size).toBe(urls.length);
    disconnect();
  });

  it("does not loop forever when a page advances no cursor", async () => {
    // A page that scanned nothing returns no cursor. Re-requesting the same
    // window would spin; the ceiling bounds it, but has_more:false must end it
    // immediately.
    const disconnect = connectRealtimeBus(() => {});
    const first = FakeEventSource.instances[0]!;
    first.onopen?.({});
    first.emit("campaign.sent", {
      topic: "campaign.sent",
      ts: "2026-08-04T09:00:00Z",
    });

    fetchMock.mockResolvedValue(replayBody([], { has_more: false }));
    first.onerror?.({});
    await vi.advanceTimersByTimeAsync(1_500);
    FakeEventSource.instances[1]!.onopen?.({});
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    disconnect();
  });
});

// --- adversarial review, 2026-08-04 ------------------------------------------

describe("recovery defects found by adversarial review", () => {
  it("resumes by TIME again once live events arrive after a walk", () => {
    // The sequence cursor is preferred because it is exact, and live payloads
    // never carry one — so a cursor picked up from any replay page could never
    // move again. The stream force-closes every 5 minutes, so the client would
    // reconnect and re-replay the window it had just watched live, forever.
    const cursor = advanceReplayCursor(
      advanceReplayCursor(EMPTY_REPLAY_CURSOR, {
        ts: "2026-08-04T09:00:00Z",
        sequence_id: 500,
      }),
      { ts: "2026-08-04T09:30:00Z" },
    );
    expect(replayRequestPath(cursor, [])).toContain("since_at=");
  });

  it("stops dispatching replayed events after disconnect", async () => {
    // `disconnect()` runs on tenant/role change and on logout. An in-flight
    // walk that ignores it keeps invalidating against the PREVIOUS identity's
    // query keys — the same cross-identity bleed the notification feed had.
    const seen: string[] = [];
    const disconnect = connectRealtimeBus((evt) => seen.push(evt.topic));
    const first = FakeEventSource.instances[0]!;
    first.onopen?.({});
    first.emit("campaign.sent", {
      topic: "campaign.sent",
      ts: "2026-08-04T09:00:00Z",
    });

    let release: (v: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }),
    );
    first.onerror?.({});
    await vi.advanceTimersByTimeAsync(1_500);
    FakeEventSource.instances[1]!.onopen?.({});
    await flush();

    // Tenant switch lands while the page is still in flight.
    disconnect();
    release(replayBody([{ topic: "subscriber.bounced", ts: "2026-08-04T09:01:00Z" }]));
    await flush();

    expect(seen).toEqual(["campaign.sent"]);
  });

  it("stops dispatching when disconnect lands between headers and body", async () => {
    // The narrower window the first fix left open: `stopped` was checked after
    // the fetch resolved but not after `res.json()`. Headers can arrive before
    // `disconnect()` and the body after it, and a page is up to 200 events —
    // every one invalidating against the previous identity's keys. The earlier
    // test released the FETCH promise, so it could not see this.
    const seen: string[] = [];
    const disconnect = connectRealtimeBus((evt) => seen.push(evt.topic));
    const first = FakeEventSource.instances[0]!;
    first.onopen?.({});
    first.emit("campaign.sent", {
      topic: "campaign.sent",
      ts: "2026-08-04T09:00:00Z",
    });

    let releaseBody: (v: unknown) => void = () => {};
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => new Promise((resolve) => { releaseBody = resolve; }),
    });
    first.onerror?.({});
    await vi.advanceTimersByTimeAsync(1_500);
    FakeEventSource.instances[1]!.onopen?.({});
    await flush();

    disconnect();
    releaseBody({
      events: [{ topic: "subscriber.bounced", ts: "2026-08-04T09:01:00Z" }],
      next_cursor: null,
      next_since_at: "",
      has_more: false,
    });
    await flush();

    expect(seen).toEqual(["campaign.sent"]);
  });

  it("aborts the in-flight recovery request on disconnect", async () => {
    // Storing an AbortController without ever calling abort() makes it
    // write-only state: the request runs to completion regardless.
    const disconnect = connectRealtimeBus(() => {});
    const first = FakeEventSource.instances[0]!;
    first.onopen?.({});
    first.emit("campaign.sent", {
      topic: "campaign.sent",
      ts: "2026-08-04T09:00:00Z",
    });

    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    first.onerror?.({});
    await vi.advanceTimersByTimeAsync(1_500);
    FakeEventSource.instances[1]!.onopen?.({});
    await flush();

    const signal = (fetchMock.mock.calls[0]![1] as { signal: AbortSignal }).signal;
    expect(signal.aborted).toBe(false);
    disconnect();
    expect(signal.aborted).toBe(true);
  });

  it("does not replay for callers that opt out", async () => {
    // Presence rides this same client, and presence rows ARE persisted. A
    // replayed snapshot lands after the fresh one the re-subscribe triggered,
    // so a historical viewer list wins and sticks until the next membership
    // change. Ephemeral state has no gap worth recovering.
    const disconnect = connectRealtimeBus(() => {}, undefined, {
      topics: ["presence.update"],
      recover: false,
    });
    const first = FakeEventSource.instances[0]!;
    first.onopen?.({});
    first.emit("presence.update", {
      topic: "presence.update",
      ts: "2026-08-04T09:00:00Z",
    });
    first.onerror?.({});
    await vi.advanceTimersByTimeAsync(1_500);
    FakeEventSource.instances[1]!.onopen?.({});
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    disconnect();
  });
});
