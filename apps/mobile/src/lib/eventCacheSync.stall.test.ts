/**
 * The diagnostics screen's "stalls / pauses" row is only truthful if the one
 * production connection actually reports stalls. `noteEventBusPause` was wired
 * from the focus gate; `noteEventBusStall` had no caller anywhere in the app,
 * so the left-hand number was structurally pinned to 0 — including on the
 * exact NATIVE#9 failure (an OS-torn socket that never errors) the counter was
 * added to expose.
 *
 * This asserts the wiring at the seam that was missing, and then asserts the
 * observable consequence: a stall reported by the transport shows up in the
 * health store the diagnostics report reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const connectEventBus = vi.fn(
  (..._args: unknown[]) =>
    (() => {}) as unknown as () => void,
);

/** The options object the transport was handed on the Nth connect. */
function connectOptions(call = 0): {
  onStall?: () => void;
  onBeforeTail?: () => Promise<void>;
} {
  const args = connectEventBus.mock.calls[call];
  if (!args) throw new Error("connectEventBus was never called");
  return (args[3] ?? {}) as {
    onStall?: () => void;
    onBeforeTail?: () => Promise<void>;
  };
}

vi.mock("@/api/eventBus", () => ({
  connectEventBus: (...args: unknown[]) =>
    (connectEventBus as unknown as (...a: unknown[]) => () => void)(...args),
}));

vi.mock("@/api/eventReplay", () => ({
  runEventReplay: () =>
    Promise.resolve({
      cursor: 0,
      dispatched: 0,
      reason: "test",
      discovery: true,
    }),
}));

import { startEventCacheSync } from "./eventCacheSync";
import { getEventBusHealth, resetEventBusHealth } from "./eventBusStatus";

const alwaysFocused = {
  isFocused: () => true,
  subscribe: () => () => {},
};

const client = {
  invalidateQueries: vi.fn(),
  refetchQueries: vi.fn(),
};

describe("startEventCacheSync stall reporting", () => {
  beforeEach(() => {
    connectEventBus.mockClear();
    resetEventBusHealth();
  });

  afterEach(() => {
    resetEventBusHealth();
  });

  it("hands the transport a stall observer", () => {
    const stop = startEventCacheSync(client, ["campaign.sent"], alwaysFocused);

    expect(connectEventBus).toHaveBeenCalledTimes(1);
    expect(typeof connectOptions().onStall).toBe("function");

    stop();
  });

  it("counts a reported stall in the health the diagnostics row reads", () => {
    const stop = startEventCacheSync(client, ["campaign.sent"], alwaysFocused);
    const onStall = connectOptions().onStall;
    if (!onStall) throw new Error("no stall observer was passed");

    expect(getEventBusHealth().stalls).toBe(0);
    onStall();
    onStall();
    expect(getEventBusHealth().stalls).toBe(2);

    stop();
  });
});
