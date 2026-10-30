/**
 * The redemption export re-emits the SERVER's CSV rather than forwarding it,
 * because `encoding/csv` quotes per RFC4180 but does not neutralise a leading
 * `=`/`+`/`-`/`@` — and the subscriber email in each row is customer-supplied.
 * These tests pin that, plus the truncation honesty rule.
 */
import { describe, expect, it } from "vitest";

import {
  DISCOUNT_EXPORT_MAX_ROWS,
  discountExportNotice,
  discountRedemptionsCsv,
  discountRedemptionsCsvPath,
} from "@/lib/discountExport";

const HEADER = "subscriber_email,subscriber_id,redeemed_at";

function body(rows: readonly string[]): string {
  return [HEADER, ...rows].join("\n");
}

describe("discountRedemptionsCsvPath", () => {
  it("encodes a code that would otherwise change the path", () => {
    expect(discountRedemptionsCsvPath("BF/26")).toBe(
      "/api/v1/discounts/BF%2F26/redemptions.csv",
    );
  });
});

describe("formula injection", () => {
  it("neutralises a leading + on a legitimate email local part", () => {
    const out = discountRedemptionsCsv(
      body(["+alex@example.com,sub_1,2026-07-01T00:00:00Z"]),
      { code: "BF26", total: 1 },
    );
    const line = out.body.split("\n")[1] ?? "";
    expect(line.startsWith("'+alex@example.com")).toBe(true);
  });

  it("neutralises =, - and @ leads too", () => {
    const out = discountRedemptionsCsv(
      body([
        '"=HYPERLINK(""http://x"",""click"")",sub_1,2026-07-01T00:00:00Z',
        "-2+3,sub_2,2026-07-01T00:00:00Z",
        "@SUM(A1),sub_3,2026-07-01T00:00:00Z",
      ]),
      { code: "BF26", total: 3 },
    );
    const lines = out.body.split("\n").slice(1);
    expect(lines.every((l) => l.startsWith("'") || l.startsWith("\"'"))).toBe(
      true,
    );
  });

  it("survives a quoted field containing a comma without shifting columns", () => {
    const out = discountRedemptionsCsv(
      body(['"a,b@example.com",sub_1,2026-07-01T00:00:00Z']),
      { code: "BF26", total: 1 },
    );
    expect(out.body.split("\n")[1]).toBe(
      '"a,b@example.com",sub_1,2026-07-01T00:00:00Z',
    );
  });
});

describe("truncation is stated, never implied", () => {
  it("keeps the header even when the payload is empty", () => {
    const out = discountRedemptionsCsv("", { code: "BF26" });
    expect(out.body).toBe(HEADER);
    expect(out.included).toBe(0);
    expect(discountExportNotice(out)).toBe(
      "This code has no redemptions to export.",
    );
  });

  it("drops the server's header row instead of exporting it as data", () => {
    const out = discountRedemptionsCsv(
      body(["a@example.com,sub_1,2026-07-01T00:00:00Z"]),
      { code: "BF26", total: 1 },
    );
    expect(out.included).toBe(1);
    expect(out.truncated).toBe(false);
    expect(discountExportNotice(out)).toBe("Shared 1 redemption.");
  });

  it("counts a response that exactly fills the cap as truncated", () => {
    // The dangerous case: from here a full page is indistinguishable from a
    // slice, so claiming completeness would be a guess.
    const rows = Array.from(
      { length: 3 },
      (_, i) => `u${i}@example.com,sub_${i},2026-07-01T00:00:00Z`,
    );
    const out = discountRedemptionsCsv(body(rows), { code: "BF26", cap: 3 });
    expect(out.included).toBe(3);
    expect(out.truncated).toBe(true);
    expect(out.title).toBe("BF26 redemptions — newest 3");
    expect(discountExportNotice(out)).toContain("the rest need the web export");
  });

  it("names the denominator only when the row's lifetime total is known", () => {
    const rows = Array.from(
      { length: 2 },
      (_, i) => `u${i}@example.com,sub_${i},2026-07-01T00:00:00Z`,
    );
    const known = discountRedemptionsCsv(body(rows), {
      code: "BF26",
      total: 400,
      cap: 2,
    });
    expect(known.title).toBe("BF26 redemptions — newest 2 of 400");
    const unknown = discountRedemptionsCsv(body(rows), {
      code: "BF26",
      total: 0,
      cap: 2,
    });
    expect(unknown.title).toBe("BF26 redemptions — newest 2");
  });

  it("caps at the module default", () => {
    const rows = Array.from(
      { length: DISCOUNT_EXPORT_MAX_ROWS + 20 },
      (_, i) => `u${i}@example.com,sub_${i},2026-07-01T00:00:00Z`,
    );
    const out = discountRedemptionsCsv(body(rows), { code: "BF26" });
    expect(out.included).toBe(DISCOUNT_EXPORT_MAX_ROWS);
    expect(out.truncated).toBe(true);
  });

  it("falls back to a generic label for a blank code", () => {
    const out = discountRedemptionsCsv(
      body(["a@example.com,sub_1,2026-07-01T00:00:00Z"]),
      { code: "   ", total: 1 },
    );
    expect(out.title).toBe("discount redemptions (1)");
  });
});
