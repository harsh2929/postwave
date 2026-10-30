// Send-fatigue pure logic (full-surface wiring): fraction → percent
// formatting and the data-derived one-line read. The read must only
// claim a fatigue signature when the gradient is actually there, and
// must say nothing at all with fewer than two buckets.

import { describe, expect, it } from "vitest";

import {
  fatigueRead,
  fmtFraction,
  maxOpenRate,
} from "../../components/analytics/fatigue";
import type { FatigueDecile } from "../../lib/api-client";

function decile(
  sends_bucket: string,
  open_rate: number,
  unsub_rate: number,
  subscribers = 100,
): FatigueDecile {
  return { sends_bucket, subscribers, open_rate, unsub_rate };
}

describe("fmtFraction", () => {
  it("converts 0..1 fractions to display percentages", () => {
    // Wire deviation #8: rates arrive as fractions, not percentages.
    expect(fmtFraction(0.42)).toBe("42.0%");
    expect(fmtFraction(0)).toBe("0.0%");
    expect(fmtFraction(0.0012, 2)).toBe("0.12%");
  });
});

describe("fatigueRead", () => {
  it("returns null with fewer than two buckets — no gradient to read", () => {
    expect(fatigueRead([])).toBeNull();
    expect(fatigueRead([decile("1-2", 0.4, 0.001)])).toBeNull();
  });

  it("calls out the fatigue signature when opens fall ≥10% relatively", () => {
    const read = fatigueRead([
      decile("1-2", 0.4, 0.001),
      decile("3-5", 0.35, 0.002),
      decile("6+", 0.3, 0.004),
    ]);
    expect(read).toContain("Fatigue signature");
    expect(read).toContain("40.0%");
    expect(read).toContain("30.0%");
    expect(read).toContain("1-2 → 6+ sends");
    // Unsubs rose too — the clause must be included.
    expect(read).toContain("unsubscribes rise");
  });

  it("omits the unsub clause when unsubs do not rise", () => {
    const read = fatigueRead([
      decile("1-2", 0.4, 0.004),
      decile("6+", 0.3, 0.002),
    ]);
    expect(read).toContain("Fatigue signature");
    expect(read).not.toContain("unsubscribes rise");
  });

  it("flags rising unsubs even when open rates hold", () => {
    const read = fatigueRead([
      decile("1-2", 0.4, 0.001),
      decile("6+", 0.39, 0.005),
    ]);
    expect(read).toContain("unsubscribes rise");
    expect(read).not.toContain("Fatigue signature");
  });

  it("reports 'no fatigue signature' honestly when engagement holds", () => {
    const read = fatigueRead([
      decile("1-2", 0.4, 0.001),
      decile("6+", 0.41, 0.001),
    ]);
    expect(read).toContain("No fatigue signature");
  });

  it("treats sub-10% relative open dips as noise, not a diagnosis", () => {
    const read = fatigueRead([
      decile("1-2", 0.4, 0.001),
      decile("6+", 0.38, 0.001), // 5% relative dip
    ]);
    expect(read).toContain("No fatigue signature");
  });

  it("does not divide by zero when the first bucket never opened", () => {
    const read = fatigueRead([
      decile("1-2", 0, 0.001),
      decile("6+", 0, 0.001),
    ]);
    expect(read).toContain("No fatigue signature");
  });
});

describe("maxOpenRate", () => {
  it("returns the peak open rate for inline-bar scaling", () => {
    expect(
      maxOpenRate([decile("a", 0.2, 0), decile("b", 0.5, 0), decile("c", 0.3, 0)]),
    ).toBe(0.5);
    expect(maxOpenRate([])).toBe(0);
  });
});
