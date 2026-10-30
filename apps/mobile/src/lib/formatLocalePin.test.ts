/**
 * CANARY for the host-locale pin in vitest.config.ts (TESTS-3).
 *
 * lib/format leaves its locale `undefined` until localization.ts hands it the
 * device's, so under test every formatter follows the ICU default of whatever
 * machine runs the suite. On a German laptop 25 of the format tests went red
 * (`1.234.567`, `50,0 %`), on en_IN two did, and with `LC_ALL=` (empty) ICU
 * resolved `und` and six did. CI only stayed green because ubuntu's C.UTF-8
 * happens to map to en-US.
 *
 * vitest.config.ts now sets LC_ALL/LANG in the main process before the forks
 * pool spawns its workers. ICU fixes its default when a process starts, so the
 * pin cannot be applied from inside a worker, and it silently stops working if
 * someone moves the suite to pool "threads". This file is what fails loudly
 * when that happens, instead of a scatter of unrelated format assertions.
 */
import { afterEach, describe, expect, it } from "vitest";

import { num, setFormatLocale } from "./format";

afterEach(() => {
  setFormatLocale(undefined);
});

describe("vitest worker locale pin", () => {
  it("starts every worker under en-US, whatever the host shell exports", () => {
    expect(new Intl.NumberFormat().resolvedOptions().locale).toBe("en-US");
  });

  it("formats under the engine default the way the rest of the suite expects", () => {
    // `undefined` is the app's pre-localization state: "use the default".
    setFormatLocale(undefined);
    expect(num(1340)).toBe("1,340");
  });
});
