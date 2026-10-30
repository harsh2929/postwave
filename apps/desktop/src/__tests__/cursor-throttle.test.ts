// Tests the 100ms throttle invariant the CursorOverlay enforces on
// every cursor.move publish. The actual throttle lives inside a
// useEffect closure so we can't import it directly; instead we model
// the same `lastSent + delta < THROTTLE_MS → drop` logic and test
// that it (a) drops samples within the window and (b) re-arms after
// the window elapses. If the cursor publish gets faster, the
// server-side limiter (20 req/sec) will start 429ing.

import { describe, expect, it } from "vitest";

const THROTTLE_MS = 100;

class Throttle {
  private last = 0;
  shouldEmit(now: number): boolean {
    if (now - this.last < THROTTLE_MS) return false;
    this.last = now;
    return true;
  }
}

describe("cursor publish throttle (100ms)", () => {
  it("emits the very first sample", () => {
    const t = new Throttle();
    expect(t.shouldEmit(1000)).toBe(true);
  });

  it("drops a sample within the throttle window", () => {
    const t = new Throttle();
    t.shouldEmit(1000);
    expect(t.shouldEmit(1050)).toBe(false);
    expect(t.shouldEmit(1099)).toBe(false);
  });

  it("emits exactly at the boundary", () => {
    const t = new Throttle();
    t.shouldEmit(1000);
    expect(t.shouldEmit(1100)).toBe(true);
  });

  it("re-arms after the window elapses", () => {
    const t = new Throttle();
    t.shouldEmit(1000);
    expect(t.shouldEmit(1200)).toBe(true);
    // After re-arming, samples within the new window drop again.
    expect(t.shouldEmit(1250)).toBe(false);
  });

  it("never emits more than 10 samples per second under continuous load", () => {
    const t = new Throttle();
    let emits = 0;
    // Drive 1 sample/ms for one full second.
    for (let now = 0; now < 1000; now++) {
      if (t.shouldEmit(now)) emits++;
    }
    // First sample at t=0, then every 100ms boundary: 0, 100, 200, ..., 900 = 10.
    expect(emits).toBeLessThanOrEqual(10);
    expect(emits).toBeGreaterThanOrEqual(9); // Allow off-by-one at the boundary.
  });
});
