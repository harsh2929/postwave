import { afterEach, describe, expect, it } from "vitest";

import {
  EMDASH,
  bytes,
  compactNum,
  date,
  duration,
  exact,
  money,
  monthYear,
  num,
  percent,
  plural,
  relativeTime,
  setFormatLocale,
  signedPercent,
  toDate,
  truncateMiddle,
} from "./format";

describe("format — absent vs zero", () => {
  it("renders an em-dash for genuinely absent values", () => {
    for (const absent of [null, undefined, "", "   ", NaN, Infinity, {}, []]) {
      expect(num(absent)).toBe(EMDASH);
      expect(compactNum(absent)).toBe(EMDASH);
      expect(percent(absent)).toBe(EMDASH);
      expect(money(absent)).toBe(EMDASH);
    }
  });

  it("treats zero as a real measurement, never as absent", () => {
    expect(num(0)).toBe("0");
    expect(compactNum(0)).toBe("0");
    expect(percent(0)).toBe("0.0%");
    expect(plural(0, "bounce")).toBe("0 bounces");
  });

  it("never emits NaN or Invalid Date", () => {
    const rendered = [
      num("abc"),
      compactNum("abc"),
      percent("abc"),
      date("not-a-date"),
      duration("abc"),
      bytes(-5),
    ];
    for (const value of rendered) {
      expect(value).not.toMatch(/NaN|Invalid/);
    }
  });
});

describe("format — numbers", () => {
  it("groups thousands", () => {
    expect(num(1234567)).toBe("1,234,567");
  });

  it("compacts only above a thousand", () => {
    expect(compactNum(999)).toBe("999");
    expect(compactNum(1234)).toBe("1.2K");
    expect(compactNum(2_400_000)).toBe("2.4M");
  });

  it("accepts numeric strings from loosely typed APIs", () => {
    expect(num("1500")).toBe("1,500");
  });

  it("distinguishes ratio from already-percent inputs", () => {
    // 0.5 as a ratio is 50%; 0.5 already-percent is half a percent. Guessing
    // from magnitude would mislabel one of them.
    expect(percent(0.5)).toBe("50.0%");
    expect(percent(0.5, { alreadyPercent: true })).toBe("0.5%");
  });

  it("signs deltas with a true minus sign", () => {
    expect(signedPercent(0.124)).toBe("+12.4%");
    expect(signedPercent(-0.03)).toBe("−3.0%");
    expect(signedPercent(0)).toBe("0.0%");
  });

  it("omits cents for whole amounts unless asked", () => {
    expect(money(42)).toBe("$42");
    expect(money(42, "USD", { cents: true })).toBe("$42.00");
    expect(money(42.5)).toBe("$42.50");
  });
});

describe("format — pluralization", () => {
  it("uses the singular only at exactly one", () => {
    expect(plural(1, "subscriber")).toBe("1 subscriber");
    expect(plural(2, "subscriber")).toBe("2 subscribers");
    expect(plural(0, "subscriber")).toBe("0 subscribers");
  });

  it("supports irregular plurals", () => {
    expect(plural(3, "entry", "entries")).toBe("3 entries");
  });

  it("groups large counts", () => {
    expect(plural(1500, "open")).toBe("1,500 opens");
  });
});

describe("format — dates", () => {
  it("parses ISO strings, epoch millis, and Date objects", () => {
    const iso = "2026-03-14T16:05:00.000Z";
    expect(toDate(iso)?.toISOString()).toBe(iso);
    expect(toDate(Date.parse(iso))?.toISOString()).toBe(iso);
    expect(toDate(new Date(iso))?.toISOString()).toBe(iso);
  });

  it("rejects the empty strings the API returns for unset timestamps", () => {
    expect(toDate("")).toBeNull();
    expect(toDate("   ")).toBeNull();
    expect(date("")).toBe(EMDASH);
  });

  it("renders a month heading with no day in it", () => {
    // Local time deliberately: a month grid is anchored to the device's own
    // calendar, so mid-month avoids a timezone shunting the label a month.
    const anchor = new Date(2026, 2, 14).getTime();
    expect(monthYear(anchor)).toBe("March 2026");
    // The same absent-value contract as every other date helper.
    expect(monthYear("")).toBe(EMDASH);
    expect(monthYear(null)).toBe(EMDASH);
  });
});

describe("format — relative time", () => {
  const now = Date.parse("2026-03-14T12:00:00.000Z");
  const at = (ms: number) => new Date(now + ms).toISOString();

  it("collapses the last minute to 'just now'", () => {
    expect(relativeTime(at(-10_000), { now })).toBe("just now");
    expect(relativeTime(at(10_000), { now })).toBe("just now");
  });

  it("handles the past", () => {
    expect(relativeTime(at(-5 * 60_000), { now })).toMatch(/5/);
    expect(relativeTime(at(-5 * 60_000), { now })).toMatch(/ago|minutes/);
  });

  it("handles the FUTURE — a scheduled send is not negative age", () => {
    const rendered = relativeTime(at(3 * 3_600_000), { now });
    expect(rendered).toMatch(/3/);
    expect(rendered).not.toMatch(/-3|−3/);
    expect(rendered).toMatch(/in|hours/);
  });

  it("falls back to an absolute date past four weeks", () => {
    // "63d ago" makes the reader do arithmetic; a date does not.
    expect(relativeTime(at(-63 * 86_400_000), { now })).toMatch(/2026|Jan/);
  });
});

describe("format — a German phone (setFormatLocale)", () => {
  /**
   * Every other case in this file reads the ENGLISH answer, which the vitest
   * host pin makes deterministic. That same pin means a formatter which
   * ignored `locale` and passed `undefined` to Intl would still print English
   * and pass all of them. localization.ts hands the device tag in through
   * setFormatLocale, so this block reads a non-English answer back out of
   * each Intl family: numbers, percentages and relative time.
   */
  const now = Date.parse("2026-03-14T12:00:00.000Z");

  afterEach(() => {
    setFormatLocale(undefined);
  });

  it("groups thousands with a dot", () => {
    setFormatLocale("de-DE");
    expect(num(1234567)).toBe("1.234.567");
  });

  it("uses a decimal comma and a no-break space before the percent sign", () => {
    setFormatLocale("de-DE");
    expect(percent(0.5)).toBe("50,0\u00a0%");
  });

  it("speaks relative time in German", () => {
    setFormatLocale("de-DE");
    expect(relativeTime(now - 5 * 60_000, { now })).toBe("vor 5 Minuten");
  });
});

describe("format — durations and sizes", () => {
  it("scales duration units", () => {
    expect(duration(340)).toBe("340ms");
    expect(duration(4_000)).toBe("4s");
    expect(duration(80_000)).toBe("1m 20s");
    expect(duration(7_500_000)).toBe("2h 5m");
  });

  it("drops a zero remainder", () => {
    expect(duration(120_000)).toBe("2m");
    expect(duration(7_200_000)).toBe("2h");
  });

  it("scales byte units", () => {
    expect(bytes(512)).toBe("512 B");
    expect(bytes(2048)).toBe("2 KB");
    expect(bytes(2.4 * 1024 * 1024)).toBe("2.4 MB");
  });
});

describe("format — identifiers and a11y", () => {
  it("keeps both ends of a truncated identifier", () => {
    const id = "wh_9f2c1188aa77b41a";
    const short = truncateMiddle(id, 12);
    expect(short.startsWith("wh_9f")).toBe(true);
    expect(short.endsWith("b41a")).toBe(true);
    expect(short).toContain("…");
  });

  it("leaves short values untouched", () => {
    expect(truncateMiddle("abc", 12)).toBe("abc");
  });

  it("gives compact tiles an exact spoken value", () => {
    // The tile shows "1.2K"; VoiceOver must still hear the real number.
    expect(compactNum(1234)).toBe("1.2K");
    expect(exact(1234, "opens")).toBe("1,234 opens");
    expect(exact(1, "opens")).toBe("1 open");
    expect(exact(null, "opens")).toBe("No opens");
  });
});

describe("truncateMiddle is wire-safe", () => {
  /**
   * It is a FORMATTER at the end of a chain that starts at the network, and
   * callers pass payload fields straight in (`truncateMiddle(job.id, 22)`).
   *
   * On 2026-08-19 the migrations screen RED-SCREENED with "Cannot read
   * property 'slice' of undefined": /api/v1/migrations answered 200 text/html
   * (an SPA fallback for an absent upstream), so every job field was undefined
   * and `.length`/`.slice` ran on nothing. An identifier that cannot be shown
   * is worth an empty string; it is never worth the screen.
   */
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 12345],
    ["an object", { id: "x" }],
    ["an array", ["x"]],
  ])("returns a string for %s instead of throwing", (_label, input) => {
    expect(() => truncateMiddle(input as unknown as string, 22)).not.toThrow();
    expect(typeof truncateMiddle(input as unknown as string, 22)).toBe("string");
  });

  it("still truncates a real identifier in the middle", () => {
    const out = truncateMiddle("wh_9f2c1234567890abcdefb41a", 14);
    expect(out).toContain("…");
    expect(out.startsWith("wh_")).toBe(true);
    expect(out.endsWith("b41a")).toBe(true);
  });

  it("leaves a short value untouched", () => {
    expect(truncateMiddle("short", 18)).toBe("short");
  });
});
