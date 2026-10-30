/**
 * The date formatters must be built ONCE, like the number formatter beside them.
 *
 * `Intl.DateTimeFormat` and `Intl.RelativeTimeFormat` are among the most
 * expensive constructors in the runtime — each one resolves a locale, loads its
 * CLDR data and compiles a pattern — while `.format()` on an existing instance
 * is cheap. `num()` has always been cached for exactly that reason; `date()`,
 * `dateTime()`, `time()`, `calendarDate()` and `relativeTime()` built a fresh
 * instance on every call, and these run PER ROW PER RENDER on every list in the
 * app. A 1 Hz clock ticking over a fifty-row feed was constructing fifty
 * formatters a second to render text that had not changed.
 *
 * The assertions here count CONSTRUCTIONS rather than measuring time: a timing
 * test on a shared machine is a flake, and the construction count is the actual
 * claim.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  calendarDate,
  date,
  dateTime,
  relativeTime,
  setFormatLocale,
  time,
} from "./format";

type IntlCtor = "DateTimeFormat" | "RelativeTimeFormat";

/**
 * Run `body` with the named Intl constructor wrapped in a counter, and report
 * how many instances it built. The wrapper delegates with `new`, so the values
 * every helper returns are produced by the real implementation.
 */
function constructions(name: IntlCtor, body: () => void): number {
  const intl = Intl as unknown as Record<string, unknown>;
  const original = intl[name] as new (...args: unknown[]) => unknown;
  let built = 0;
  intl[name] = function counted(...args: unknown[]) {
    built += 1;
    return new original(...args);
  };
  try {
    body();
  } finally {
    intl[name] = original;
  }
  return built;
}

const AUGUST = "2026-08-22T16:05:00.000Z";

afterEach(() => {
  // The caches are keyed by locale, so a test that switched it would otherwise
  // leave every later assertion measuring a cold cache.
  setFormatLocale(undefined);
});

describe("date formatter caching", () => {
  it("builds one DateTimeFormat for a whole column of dates", () => {
    setFormatLocale(undefined);
    const built = constructions("DateTimeFormat", () => {
      for (let i = 0; i < 50; i += 1) {
        date(new Date(Date.parse(AUGUST) + i * 86_400_000));
      }
    });
    expect(built).toBe(1);
  });

  it("gives each option bag its own instance, and reuses each one", () => {
    setFormatLocale(undefined);
    const built = constructions("DateTimeFormat", () => {
      for (let i = 0; i < 10; i += 1) {
        date(AUGUST);
        dateTime(AUGUST);
        time(AUGUST);
        calendarDate(AUGUST, { weekday: "short" });
        calendarDate(AUGUST, { withYear: true });
      }
    });
    // Five distinct shapes, ten passes: one instance per shape and no more.
    expect(built).toBe(5);
  });

  it("builds one RelativeTimeFormat for a whole feed of timestamps", () => {
    setFormatLocale(undefined);
    const now = Date.parse(AUGUST);
    const built = constructions("RelativeTimeFormat", () => {
      for (let i = 1; i <= 50; i += 1) {
        relativeTime(now - i * 60_000, { now });
      }
    });
    expect(built).toBe(1);
  });

  it("rebuilds after setFormatLocale, so a locale switch is not ignored", () => {
    setFormatLocale(undefined);
    date(AUGUST);
    const built = constructions("DateTimeFormat", () => {
      setFormatLocale("de-DE");
      date(AUGUST);
    });
    // Vacuity floor for the counts above: a cache that could never miss would
    // satisfy every "builds one" assertion while pinning the app to whatever
    // locale happened to be current at startup.
    expect(built).toBe(1);
  });

  it("still formats in the locale it was last given", () => {
    // An explicit baseline, not `undefined`: the engine default is the host's
    // locale, and on a de-DE machine "undefined" and "de-DE" are the same
    // answer, which is what made this case red there (TESTS-3).
    setFormatLocale("en-US");
    const american = date("2026-03-14T00:00:00.000Z");
    setFormatLocale("de-DE");
    const german = date("2026-03-14T00:00:00.000Z");
    // The point of invalidating: same input, different answer.
    expect(german).not.toBe(american);
    expect(german).toBe(date("2026-03-14T00:00:00.000Z"));
  });
});
