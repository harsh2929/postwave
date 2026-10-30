/**
 * The lab → bandit handoff rules: which scored variants arm the test.
 *
 * The failure this pins is quiet: a bandit armed with the UNRANKED rows would
 * still create a plausible test — just not the one the panel's reading
 * promised — and a one-arm "test" would silently be a plain send.
 */
import { describe, expect, it } from "vitest";

import type { SubjectScoreRow } from "./subjectLab";
import { banditVariantsFrom, BANDIT_VARIANT_TARGET } from "./subjectLabBandit";

function row(text: string, rate: number | null): SubjectScoreRow {
  return {
    key: `${text}-${String(rate)}`,
    text,
    predictedOpen: rate,
    predictedLabel: "",
    bandLabel: "—",
    matchedN: rate === null ? 0 : 100,
    lowConfidence: false,
    verdict: rate === null ? "unknown" : "strong",
    deltaLabel: null,
    caveat: null,
  } as SubjectScoreRow;
}

describe("banditVariantsFrom", () => {
  it("takes the top three by the panel's own ranking", () => {
    const rows = [
      row("weak", 0.05),
      row("best", 0.4),
      row("good", 0.3),
      row("ok", 0.2),
    ];
    expect(banditVariantsFrom(rows)).toEqual(["best", "good", "ok"]);
    expect(BANDIT_VARIANT_TARGET).toBe(3);
  });

  it("dedupes identical texts and skips blanks", () => {
    const rows = [row("same", 0.4), row("same", 0.3), row(" ", 0.5), row("b", 0.2)];
    expect(banditVariantsFrom(rows)).toEqual(["same", "b"]);
  });

  it("refuses a one-arm bandit", () => {
    expect(banditVariantsFrom([row("only", 0.4)])).toBeNull();
    expect(banditVariantsFrom([])).toBeNull();
  });
});
