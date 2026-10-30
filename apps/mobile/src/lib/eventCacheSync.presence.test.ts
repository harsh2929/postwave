/**
 * Mobile was the one client that only PUBLISHED presence: the connection
 * startEventCacheSync opens at launch increments the server's per-tenant
 * counter, every other client renders it, and the phone subscribed to no
 * presence topic and had no reader.
 *
 * These pin the four decisions that make consuming it safe on a phone:
 *   1. presence rides the EXISTING connection (no second socket),
 *   2. presence frames never reach the query invalidator,
 *   3. a REPLAYED presence frame is refused (it is a historical viewer list
 *      that would land on top of the fresh post-reconnect snapshot),
 *   4. a paused/torn-down stream clears presence rather than leaving a viewer
 *      list we can no longer receive updates for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INVALIDATION_DEBOUNCE_MS } from "@/api/event-cache-invalidation";

const connectEventBus = vi.fn(
  (..._args: unknown[]) => (() => {}) as unknown as () => void,
);

let replayEmit: ((event: { topic: string; payload?: unknown }) => void) | null =
  null;

vi.mock("@/api/eventBus", () => ({
  connectEventBus: (...args: unknown[]) =>
    (connectEventBus as unknown as (...a: unknown[]) => () => void)(...args),
}));

vi.mock("@/api/eventReplay", () => ({
  runEventReplay: (input: {
    onEvent: (event: { topic: string; payload?: unknown }) => void;
  }) => {
    replayEmit = input.onEvent;
    return Promise.resolve({
      cursor: 0,
      dispatched: 0,
      reason: "test",
      discovery: true,
    });
  },
}));

import { startEventCacheSync } from "./eventCacheSync";
import { PRESENCE_TOPIC } from "./presence";
import { getWorkspacePresence, resetWorkspacePresence } from "./presenceStore";

const client = {
  invalidateQueries: vi.fn(),
  refetchQueries: vi.fn(),
};

let pauseListener: ((focused: boolean) => void) | null = null;
const focus = {
  isFocused: () => true,
  subscribe: (listener: (focused: boolean) => void) => {
    pauseListener = listener;
    return () => {
      pauseListener = null;
    };
  },
};

type Frame = { topic: string; payload?: unknown };

function connectArgs(): {
  topics: string[];
  onEvent: (evt: Frame) => void;
  options: { onBeforeTail?: () => Promise<void> };
} {
  const args = connectEventBus.mock.calls[0];
  if (!args) throw new Error("connectEventBus was never called");
  return {
    topics: args[0] as string[],
    onEvent: args[1] as (evt: Frame) => void,
    options: (args[3] ?? {}) as { onBeforeTail?: () => Promise<void> },
  };
}

const PRESENCE_FRAME: Frame = {
  topic: PRESENCE_TOPIC,
  payload: { count: 2, users_v2: [{ id: "u1", label: "alice" }] },
};

describe("startEventCacheSync presence", () => {
  beforeEach(() => {
    connectEventBus.mockClear();
    client.invalidateQueries.mockClear();
    client.refetchQueries.mockClear();
    replayEmit = null;
    pauseListener = null;
    resetWorkspacePresence();
  });

  afterEach(() => {
    resetWorkspacePresence();
  });

  it("subscribes to presence on the connection that is already open", () => {
    const stop = startEventCacheSync(client, ["campaign.*"], focus);

    expect(connectEventBus).toHaveBeenCalledTimes(1);
    expect(connectArgs().topics).toEqual(["campaign.*", PRESENCE_TOPIC]);

    stop();
  });

  it("routes a live presence frame to the store, not the invalidator", () => {
    const stop = startEventCacheSync(client, ["campaign.*"], focus);
    connectArgs().onEvent(PRESENCE_FRAME);

    expect(getWorkspacePresence().count).toBe(2);
    expect(getWorkspacePresence().viewers[0]?.label).toBe("alice");
    expect(client.invalidateQueries).not.toHaveBeenCalled();

    stop();
  });

  it("refuses a REPLAYED presence frame", async () => {
    const stop = startEventCacheSync(client, ["campaign.*"], focus);

    // The re-subscribe produced a fresh snapshot...
    connectArgs().onEvent(PRESENCE_FRAME);
    expect(getWorkspacePresence().count).toBe(2);

    // ...and then the gap walk offers a historical one. It arrives second, so
    // without the guard the stale list would win.
    await connectArgs().options.onBeforeTail?.();
    expect(replayEmit).not.toBeNull();
    replayEmit?.({
      topic: PRESENCE_TOPIC,
      payload: { count: 9, users_v2: [{ id: "old", label: "ghost" }] },
    });

    expect(getWorkspacePresence().count).toBe(2);
    expect(getWorkspacePresence().viewers[0]?.label).toBe("alice");

    stop();
  });

  it("still replays non-presence events to the invalidator", async () => {
    // This case is the counterweight to the one above, and it is the reason
    // the presence guard is a TOPIC test rather than a blanket `return`.
    // Asserting on the presence store alone proves nothing here: the store is
    // empty whether the frame was dispatched or silently discarded, so the
    // only assertion that can fail is the invalidator's OBSERVABLE call.
    //
    // The invalidator coalesces on a real trailing debounce, so the window
    // has to be advanced before anything is observable — hence fake timers.
    vi.useFakeTimers();
    try {
      const stop = startEventCacheSync(client, ["campaign.*"], focus);
      await connectArgs().options.onBeforeTail?.();
      expect(replayEmit).not.toBeNull();
      replayEmit?.({ topic: "campaign.sent", payload: {} });

      // Coalesced, not dropped: nothing has fired yet.
      expect(client.invalidateQueries).not.toHaveBeenCalled();
      vi.advanceTimersByTime(INVALIDATION_DEBOUNCE_MS);

      // `campaign.sent` maps (via the shared query-contract authority) to the
      // campaigns/campaign/dashboard resources; asserting the roots rather
      // than a bare call count keeps this a statement about THIS frame.
      const roots = client.invalidateQueries.mock.calls.map(
        (call) => (call[0] as { queryKey: readonly unknown[] }).queryKey[0],
      );
      expect(roots).toContain("campaigns");
      expect(roots).toContain("dashboard");
      // ...and the presence store is untouched by a campaign frame.
      expect(getWorkspacePresence().count).toBe(0);

      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a replayed presence frame WITHOUT dropping the frame beside it", async () => {
    // The pair above can both pass while the filter is `if (event) return;`
    // only if they are read separately. This one is the single-frame-sequence
    // statement: in ONE replay walk a presence frame is refused and a
    // campaign frame is dispatched.
    vi.useFakeTimers();
    try {
      const stop = startEventCacheSync(client, ["campaign.*"], focus);
      connectArgs().onEvent(PRESENCE_FRAME);
      await connectArgs().options.onBeforeTail?.();

      replayEmit?.({
        topic: PRESENCE_TOPIC,
        payload: { count: 9, users_v2: [{ id: "old", label: "ghost" }] },
      });
      replayEmit?.({ topic: "campaign.sent", payload: {} });
      vi.advanceTimersByTime(INVALIDATION_DEBOUNCE_MS);

      // The live snapshot survived the historical one...
      expect(getWorkspacePresence().count).toBe(2);
      expect(getWorkspacePresence().viewers[0]?.label).toBe("alice");
      // ...and the non-presence frame in the same walk still landed.
      const roots = client.invalidateQueries.mock.calls.map(
        (call) => (call[0] as { queryKey: readonly unknown[] }).queryKey[0],
      );
      expect(roots).toContain("campaigns");

      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears presence when the app backgrounds the stream", () => {
    const stop = startEventCacheSync(client, ["campaign.*"], focus);
    connectArgs().onEvent(PRESENCE_FRAME);
    expect(getWorkspacePresence().count).toBe(2);

    expect(pauseListener).not.toBeNull();
    pauseListener?.(false);
    expect(getWorkspacePresence().count).toBe(0);

    stop();
  });

  it("clears presence on teardown", () => {
    const stop = startEventCacheSync(client, ["campaign.*"], focus);
    connectArgs().onEvent(PRESENCE_FRAME);
    stop();
    expect(getWorkspacePresence().count).toBe(0);
  });
});
