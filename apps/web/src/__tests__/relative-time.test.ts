// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from "vitest";

import { absoluteTime, timeAgo } from "@/lib/relative-time";

const NOW = Date.UTC(2026, 6, 21, 12, 0, 0); // 2026-07-21T12:00:00Z

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

describe("timeAgo", () => {
  it("returns empty string for a malformed timestamp", () => {
    expect(timeAgo("not-a-date", NOW)).toBe("");
    expect(timeAgo("", NOW)).toBe("");
  });

  it("formats seconds/minutes/hours/days relative to now", () => {
    expect(timeAgo(ago(5_000), NOW).toLowerCase()).toContain("second");
    expect(timeAgo(ago(5 * 60_000), NOW).toLowerCase()).toContain("minute");
    expect(timeAgo(ago(3 * 3_600_000), NOW).toLowerCase()).toContain("hour");
    expect(timeAgo(ago(2 * 86_400_000), NOW).toLowerCase()).toContain("day");
  });

  it("expresses a future timestamp as forward-looking", () => {
    const future = new Date(NOW + 2 * 86_400_000).toISOString();
    // Intl with numeric:auto renders "in 2 days" (or locale equivalent).
    expect(timeAgo(future, NOW).toLowerCase()).toContain("day");
    expect(timeAgo(future, NOW).toLowerCase()).toContain("in");
  });
});

describe("absoluteTime", () => {
  it("returns empty string for malformed input", () => {
    expect(absoluteTime("nope")).toBe("");
  });

  it("returns a non-empty locale string for a valid timestamp", () => {
    expect(absoluteTime(ago(0))).not.toBe("");
  });
});

// WEB-RENDER-07. Both helpers built a fresh Intl formatter on every call, and
// there are 78 <RelativeTime> call sites, most inside `.map()` row bodies —
// measured at 6.06ms/1000 calls versus 0.66ms/1000 with the formatter reused.
// Formatter construction is the cost, so count constructions, not milliseconds.
//
// `vi.resetModules()` + a dynamic import is load-bearing: the cache lives in
// module scope, so a module already imported by the tests above would have
// built its formatters before the spy was installed.
describe("Intl formatter reuse", () => {
  // `Intl.RelativeTimeFormat` / `Intl.DateTimeFormat` are readonly in the DOM
  // lib, so swapping in a counting constructor goes through a widened alias.
  const mutableIntl = Intl as unknown as {
    RelativeTimeFormat: typeof Intl.RelativeTimeFormat;
    DateTimeFormat: typeof Intl.DateTimeFormat;
  };

  it("builds one RelativeTimeFormat for any number of timeAgo calls", async () => {
    const real = Intl.RelativeTimeFormat;
    const ctor = vi.fn(function (
      ...args: ConstructorParameters<typeof Intl.RelativeTimeFormat>
    ) {
      return new real(...args);
    });
    mutableIntl.RelativeTimeFormat =
      ctor as unknown as typeof Intl.RelativeTimeFormat;
    try {
      vi.resetModules();
      const { timeAgo: fresh } = await import("@/lib/relative-time");
      for (let i = 1; i <= 100; i += 1) fresh(ago(i * 1000), NOW);
      expect(ctor).toHaveBeenCalledTimes(1);
    } finally {
      mutableIntl.RelativeTimeFormat = real;
    }
  });

  it("builds one DateTimeFormat for any number of absoluteTime calls", async () => {
    const real = Intl.DateTimeFormat;
    const ctor = vi.fn(function (
      ...args: ConstructorParameters<typeof Intl.DateTimeFormat>
    ) {
      return new real(...args);
    });
    mutableIntl.DateTimeFormat = ctor as unknown as typeof Intl.DateTimeFormat;
    try {
      vi.resetModules();
      const { absoluteTime: fresh } = await import("@/lib/relative-time");
      for (let i = 1; i <= 100; i += 1) fresh(ago(i * 1000));
      expect(ctor).toHaveBeenCalledTimes(1);
    } finally {
      mutableIntl.DateTimeFormat = real;
    }
  });

  it("renders the same absolute string the platform does", () => {
    // The oracle is the Date builtin the hoisted formatter replaced, not the
    // implementation: caching must not have changed a single character of what
    // a reader sees in the tooltip, in whatever locale the runtime picked.
    for (const ms of [0, 3_600_000, 86_400_000 * 40]) {
      const iso = new Date(NOW - ms).toISOString();
      expect(absoluteTime(iso)).toBe(new Date(iso).toLocaleString());
    }
  });
});
