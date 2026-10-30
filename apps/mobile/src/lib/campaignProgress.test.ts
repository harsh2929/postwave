import { describe, expect, it } from "vitest";

import {
  isLiveSendStatus,
  LIVE_SEND_POLL_MS,
  sendProgress,
} from "./campaignProgress";

describe("isLiveSendStatus", () => {
  it("recognises the engine's in-flight states", () => {
    for (const s of ["sending", "running", "Queued", " processing "]) {
      expect(isLiveSendStatus(s)).toBe(true);
    }
  });

  it("is false for every terminal or pre-send state", () => {
    for (const s of ["draft", "scheduled", "sent", "finished", "paused", "cancelled", "failed", "", null, undefined]) {
      expect(isLiveSendStatus(s)).toBe(false);
    }
  });

  it("polls on a bounded cadence rather than continuously", () => {
    expect(LIVE_SEND_POLL_MS).toBeGreaterThanOrEqual(5_000);
  });
});

describe("sendProgress", () => {
  it("states both numerator and denominator once both are known", () => {
    const p = sendProgress({
      status: "sending",
      sent: 4201,
      delivered: 4100,
      audience: 12_483,
    });
    expect(p.live).toBe(true);
    expect(p.headline).toBe("4,201 of 12,483 sent");
    expect(p.fraction).toBeCloseTo(0.3365, 3);
    expect(p.complete).toBe(false);
  });

  it("never invents a percentage from a missing denominator", () => {
    const p = sendProgress({ status: "sending", sent: 900, audience: null });
    expect(p.fraction).toBeNull();
    expect(p.headline).toContain("900 messages sent");
    expect(p.spoken).toContain("isn't available");
  });

  it("treats a zero audience as unknown, not as division by zero", () => {
    const p = sendProgress({ status: "sending", sent: 5, audience: 0 });
    expect(p.fraction).toBeNull();
    expect(Number.isNaN(Number(p.fraction))).toBe(false);
  });

  it("says so plainly before the first delivery event", () => {
    const p = sendProgress({ status: "sending", audience: 100 });
    expect(p.fraction).toBeNull();
    expect(p.headline).toContain("no delivery events");
  });

  it("clamps a numerator that overshoots the audience", () => {
    // Retries and re-queues can push `sent` past the frozen audience count;
    // a 140%-wide bar is a bug the user sees.
    const p = sendProgress({ status: "sending", sent: 140, audience: 100 });
    expect(p.fraction).toBe(1);
    expect(p.complete).toBe(true);
  });

  it("reports live=false for a finished campaign while still reading counts", () => {
    const p = sendProgress({ status: "sent", sent: 100, audience: 100 });
    expect(p.live).toBe(false);
    expect(p.headline).toBe("100 of 100 sent");
  });

  it("speaks the counts, not a bare percentage", () => {
    const p = sendProgress({
      status: "sending",
      sent: 50,
      delivered: 48,
      audience: 100,
    });
    expect(p.spoken).toContain("50 of 100 sent");
    expect(p.spoken).toContain("48 delivered");
  });
});
