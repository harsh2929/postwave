import { describe, expect, it } from "vitest";

import {
  dashboardLiveness,
  POLL_FRESH_WINDOW_MS,
} from "@/lib/dashboardLiveness";

const NOW = 1_800_000_000_000;

function at(input: Partial<Parameters<typeof dashboardLiveness>[0]> = {}) {
  return dashboardLiveness({
    lastUpdatedAt: NOW - 5_000,
    now: NOW,
    stream: "live",
    age: "just now",
    ...input,
  });
}

describe("dashboardLiveness", () => {
  it("has not loaded when there is no successful read", () => {
    const state = at({ lastUpdatedAt: 0 });
    expect(state).toMatchObject({ label: "Loading", mechanism: "none" });
    expect(state.spoken).toContain("has not loaded");
  });

  it("claims Live only when the push stream is live", () => {
    expect(at({ stream: "live" })).toMatchObject({
      label: "Live",
      tone: "live",
      mechanism: "push",
    });
  });

  it("never says Live for a poll — the whole point of the finding", () => {
    // Fresh poll, dead stream: the old badge said "Live" here.
    const state = at({ stream: "off", lastUpdatedAt: NOW - 1_000 });
    expect(state.label).not.toBe("Live");
    expect(state).toMatchObject({ label: "On timer", mechanism: "poll" });
    expect(state.spoken).toContain("refreshes on a timer");
  });

  it("reports a reconnecting stream as reconnecting, not as idle", () => {
    expect(at({ stream: "degraded" })).toMatchObject({
      label: "Reconnecting",
      tone: "degraded",
      mechanism: "poll",
    });
  });

  it("says the timed refresh is behind when the poll has also missed", () => {
    const state = at({
      stream: "degraded",
      lastUpdatedAt: NOW - POLL_FRESH_WINDOW_MS - 1,
      age: "2m ago",
    });
    expect(state.spoken).toContain("behind");
    expect(state.spoken).toContain("2m ago");
  });

  it("falls to Idle once both mechanisms are stale", () => {
    expect(
      at({ stream: "off", lastUpdatedAt: NOW - POLL_FRESH_WINDOW_MS - 1 }),
    ).toMatchObject({ label: "Idle", tone: "idle", mechanism: "none" });
  });

  it("a failed refresh outranks a live stream", () => {
    const state = at({ stream: "live", errored: true, age: "30s ago" });
    expect(state).toMatchObject({ label: "Stale", mechanism: "none" });
    expect(state.spoken).toContain("could not refresh");
    expect(state.spoken).toContain("30s ago");
  });

  it("always carries the age in the spoken form once loaded", () => {
    for (const stream of ["live", "degraded", "off"] as const) {
      expect(at({ stream, age: "7m ago" }).spoken).toContain("7m ago");
    }
  });

  /**
   * Reproduced on device: with the API unreachable the dashboard showed the
   * pill "LOADING" and the age "not loaded" for over two and a half minutes
   * WHILE also showing "Something went wrong loading the dashboard. Please try
   * again." Two claims, one screen, opposite meanings — and the one that looks
   * like progress is the one that stops the user retrying. The cause was
   * ordering: the never-loaded branch returned before `errored` was consulted.
   */
  describe("a first load that FAILED is not a first load in progress", () => {
    it("never says Loading when the failed read is the only read", () => {
      const state = at({ lastUpdatedAt: 0, errored: true, age: "not loaded" });
      expect(state.label).not.toBe("Loading");
      expect(state.spoken).not.toContain("has not loaded yet");
    });

    it("says the load failed, and says so without dating figures it lacks", () => {
      const state = at({ lastUpdatedAt: 0, errored: true, age: "not loaded" });
      expect(state).toMatchObject({
        label: "Load failed",
        tone: "idle",
        mechanism: "none",
      });
      expect(state.spoken).toContain("could not load");
      // It is NOT the `stale` sentence: that one reads "these figures were
      // read {age}", and here there are no figures and no instant to date.
      expect(state.spoken).not.toContain("not loaded");
      expect(state.spoken).not.toContain("could not refresh");
    });

    it("an open stream does not rescue a first load that failed", () => {
      for (const stream of ["live", "degraded", "off"] as const) {
        expect(at({ lastUpdatedAt: 0, errored: true, stream }).label).toBe(
          "Load failed",
        );
      }
    });

    it("still says Loading while the first load is genuinely in flight", () => {
      const state = at({ lastUpdatedAt: 0, errored: false, stream: "off" });
      expect(state).toMatchObject({ label: "Loading", mechanism: "none" });
      expect(state.spoken).toContain("has not loaded");
    });
  });
});
