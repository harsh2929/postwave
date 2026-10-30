/**
 * Go's zero time must never reach a date formatter.
 *
 * `time.Time{}` marshals as "0001-01-01T00:00:00Z" and means "never". Passed
 * to toLocaleDateString it renders "01/01/0001", which reads as corrupt data.
 * `Date.parse` accepts it, so nothing throws — the bug is silent and only
 * visible to somebody looking at the screen.
 */
import { describe, expect, it } from "vitest";

import { formatWireTimestamp, isNeverTimestamp } from "@/lib/go-zero-time";

describe("isNeverTimestamp", () => {
  it("treats Go's zero time as never", () => {
    expect(isNeverTimestamp("0001-01-01T00:00:00Z")).toBe(true);
    // Same instant, different offset spelling.
    expect(isNeverTimestamp("0001-01-01T00:00:00+00:00")).toBe(true);
  });

  it("treats absent and empty values as never", () => {
    expect(isNeverTimestamp(undefined)).toBe(true);
    expect(isNeverTimestamp(null)).toBe(true);
    expect(isNeverTimestamp("")).toBe(true);
    expect(isNeverTimestamp("   ")).toBe(true);
  });

  it("does NOT swallow a real timestamp", () => {
    expect(isNeverTimestamp("2026-08-21T19:00:00Z")).toBe(false);
    // A genuine year-1 date is not something this product can produce, but the
    // guard must still be anchored on the whole prefix rather than the year.
    expect(isNeverTimestamp("1901-01-01T00:00:00Z")).toBe(false);
  });
});

describe("formatWireTimestamp", () => {
  it("returns the caller's fallback for never", () => {
    expect(formatWireTimestamp("0001-01-01T00:00:00Z", "Never saved")).toBe(
      "Never saved",
    );
  });

  it("formats a real timestamp", () => {
    const out = formatWireTimestamp(
      "2026-08-21T19:00:00Z",
      "Never",
      (d) => d.toISOString().slice(0, 10),
    );
    expect(out).toBe("2026-08-21");
  });

  it("falls back rather than printing Invalid Date", () => {
    expect(formatWireTimestamp("not-a-date", "Unknown")).toBe("Unknown");
  });
});
