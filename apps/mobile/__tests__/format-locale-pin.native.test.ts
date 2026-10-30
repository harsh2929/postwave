/**
 * CANARY for the locale pin in __tests__/setup.native.ts (TESTS-3).
 *
 * The route suites render real lib/format output ("1,340 subscribers",
 * "42.0%"), and lib/format passes `undefined` to Intl until something calls
 * setFormatLocale. Left alone, every suite follows the ICU default of the
 * machine running it: under a de_DE shell five assertions across the sending
 * settings, dashboard and analytics suites went red.
 *
 * An env pin cannot fix that here the way it does for vitest. This runner is
 * `--runInBand`, so the tests share the process jest itself started in, and
 * ICU fixed its default then. The pin is therefore an explicit
 * setFormatLocale("en-US") in the setup file, and this file checks the locale
 * the formatter actually hands Intl. That fails on an en-US host too, not only
 * on a German one, the moment the setup call goes missing.
 */
import { describe, expect, it } from "@jest/globals";

import { num } from "@/lib/format";

/** Run `body` and report the locale argument of every NumberFormat it built. */
function numberFormatLocales(body: () => void): unknown[] {
  const intl = Intl as unknown as Record<string, unknown>;
  const original = intl.NumberFormat as new (
    ...args: unknown[]
  ) => Intl.NumberFormat;
  const seen: unknown[] = [];
  intl.NumberFormat = function recorded(...args: unknown[]) {
    seen.push(args[0]);
    return new original(...args);
  };
  try {
    body();
  } finally {
    intl.NumberFormat = original;
  }
  return seen;
}

describe("route-suite format locale", () => {
  it("formats in en-US and says so to Intl, whatever the host locale is", () => {
    // The module is fresh for this file and the setup call cleared its
    // caches, so this first num() builds exactly one formatter.
    const locales = numberFormatLocales(() => {
      expect(num(1234567)).toBe("1,234,567");
    });
    expect(locales).toEqual(["en-US"]);
  });
});
