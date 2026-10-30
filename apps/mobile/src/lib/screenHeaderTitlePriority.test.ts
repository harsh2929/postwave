/**
 * The screen's TITLE must outrank its status pill for horizontal space.
 *
 * ScreenHeader's right-hand slot used to be `flexShrink: 0`, so it never
 * yielded and the title — the only thing telling the reader which screen they
 * are on — absorbed all the pressure and truncated. On the dashboard that
 * rendered "Dashboa…" beside a full-width "RECONNECTING" pill, and the very
 * same title fitted once the pill happened to say the shorter "ON TIMER".
 * Observed in-app on 2026-08-19.
 *
 * Asserted against the SOURCE rather than a render, deliberately: jest has no
 * layout engine, so a mounted assertion passes just as happily with
 * `flexShrink: 0` and would prove nothing about the bug.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(__dirname, "..", "components", "ScreenHeader.tsx"),
  "utf8",
);

/** The right-hand slot is the block carrying the logical start margin. */
function rightSlotStyle(): string {
  const i = SRC.indexOf("marginStart: 12");
  expect(i, "the right slot's marginStart anchor moved").toBeGreaterThan(-1);
  return SRC.slice(i, i + 1600);
}

describe("ScreenHeader space priority", () => {
  it("lets the status slot shrink", () => {
    expect(
      /flexShrink:\s*1\b/u.test(rightSlotStyle()),
      "the status slot is unshrinkable again, so a long pill will truncate the screen's own title",
    ).toBe(true);
  });

  it("caps how much of the row the status slot may take", () => {
    expect(
      /maxWidth:/u.test(rightSlotStyle()),
      "without a cap a long status label can still eat the row",
    ).toBe(true);
  });

  it("keeps the title itself flexible (it is the thing that must fit)", () => {
    expect(/flex:\s*1/u.test(SRC)).toBe(true);
  });
});
