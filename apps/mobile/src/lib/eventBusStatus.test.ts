import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  eventBusFreshness,
  getEventBusHealth,
  noteEventBusEvent,
  noteEventBusPause,
  noteEventBusReplay,
  noteEventBusStall,
  resetEventBusHealth,
  setEventBusStatus,
  subscribeEventBusHealth,
} from "./eventBusStatus";

beforeEach(() => {
  resetEventBusHealth();
});

describe("event-bus health store", () => {
  it("starts idle with no observations", () => {
    expect(getEventBusHealth()).toMatchObject({
      status: "idle",
      changedAt: null,
      lastEventAt: null,
      stalls: 0,
      pauses: 0,
      replayCursor: null,
    });
  });

  it("notifies subscribers on a status transition and not on a repeat", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeEventBusHealth(listener);
    setEventBusStatus("open", 1_000);
    expect(listener).toHaveBeenCalledTimes(1);
    setEventBusStatus("open", 2_000);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getEventBusHealth().changedAt).toBe(1_000);
    setEventBusStatus("reconnecting", 3_000);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    setEventBusStatus("open", 4_000);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("counts stalls and pauses independently", () => {
    noteEventBusStall();
    noteEventBusStall();
    noteEventBusPause();
    expect(getEventBusHealth()).toMatchObject({ stalls: 2, pauses: 1 });
  });

  it("records the replay cursor and the recovered count", () => {
    noteEventBusReplay({
      cursor: 812,
      events: 4,
      reason: "caught-up",
      now: 5_000,
    });
    expect(getEventBusHealth()).toMatchObject({
      replayCursor: 812,
      lastReplayAt: 5_000,
      lastReplayEvents: 4,
      lastReplayReason: "caught-up",
    });
  });

  it("returns a new object identity so useSyncExternalStore re-renders", () => {
    const before = getEventBusHealth();
    noteEventBusEvent(9_000);
    expect(getEventBusHealth()).not.toBe(before);
    expect(getEventBusHealth().lastEventAt).toBe(9_000);
  });
});

describe("eventBusFreshness", () => {
  it("is live on a recently-open stream", () => {
    setEventBusStatus("open", 1_000);
    noteEventBusEvent(1_500);
    const freshness = eventBusFreshness(getEventBusHealth(), 2_000);
    expect(freshness.tone).toBe("live");
    expect(freshness.label).toBe("Live");
  });

  it("degrades an open-but-silent stream instead of claiming live", () => {
    setEventBusStatus("open", 1_000);
    const freshness = eventBusFreshness(getEventBusHealth(), 1_000 + 120_000);
    expect(freshness.tone).toBe("degraded");
    expect(freshness.label).toBe("Checking…");
  });

  it("keeps a stream live while events keep arriving", () => {
    setEventBusStatus("open", 0);
    noteEventBusEvent(200_000);
    expect(eventBusFreshness(getEventBusHealth(), 210_000).tone).toBe("live");
  });

  it("reports reconnecting and connecting as degraded", () => {
    setEventBusStatus("reconnecting", 1_000);
    expect(eventBusFreshness(getEventBusHealth(), 2_000).label).toBe(
      "Reconnecting…",
    );
    setEventBusStatus("connecting", 3_000);
    expect(eventBusFreshness(getEventBusHealth(), 4_000).tone).toBe("degraded");
  });

  it("distinguishes an unsupported runtime from a paused stream", () => {
    setEventBusStatus("unsupported", 1_000);
    expect(eventBusFreshness(getEventBusHealth(), 2_000)).toMatchObject({
      tone: "off",
      label: "Not live",
    });
    setEventBusStatus("closed", 3_000);
    expect(eventBusFreshness(getEventBusHealth(), 4_000).label).toBe("Paused");
  });

  it("always carries a spoken label alongside the colour tone", () => {
    for (const status of [
      "open",
      "connecting",
      "reconnecting",
      "unsupported",
      "closed",
      "idle",
    ] as const) {
      setEventBusStatus(status, 1_000);
      const freshness = eventBusFreshness(getEventBusHealth(), 1_100);
      expect(freshness.accessibilityLabel.length).toBeGreaterThan(
        freshness.label.length,
      );
    }
  });
});
