import { describe, expect, it } from "vitest";

import {
  filterMoreRows,
  moreFilterHeading,
  scoreMoreRow,
  type MoreFilterable,
} from "./moreFilter";

const rows: MoreFilterable[] = [
  { key: "dmarc", label: "DMARC", hint: "Authentication reports" },
  { key: "audit-sinks", label: "Audit sinks", hint: "Stream the audit log" },
  { key: "audit", label: "Audit log", hint: "Who changed what" },
  { key: "billing", label: "Plan & usage", hint: "Quota and invoices" },
  { key: "settings", label: "Settings" },
];

describe("scoreMoreRow", () => {
  it("scores every row 0 for an empty query so nothing is filtered out", () => {
    for (const row of rows) expect(scoreMoreRow(row, "   ")).toBe(0);
  });

  it("ranks a label prefix ahead of a hint match", () => {
    const label = scoreMoreRow(
      { key: "audit", label: "Audit log", hint: "x" },
      "audit",
    );
    const hint = scoreMoreRow(
      { key: "zzz", label: "Zzz", hint: "audit log" },
      "audit",
    );
    expect(label).toBeLessThan(hint);
  });

  it("matches the route key with separators spaced out", () => {
    expect(
      scoreMoreRow({ key: "audit-sinks", label: "Sinks" }, "audit sinks"),
    ).toBeLessThan(Number.POSITIVE_INFINITY);
  });

  it("returns Infinity when nothing matches", () => {
    expect(scoreMoreRow(rows[0] as MoreFilterable, "zzzzzz")).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});

describe("filterMoreRows", () => {
  it("returns every row, in order, for an empty query", () => {
    expect(filterMoreRows(rows, "").map((r) => r.key)).toEqual(
      rows.map((r) => r.key),
    );
  });

  it("drops non-matches", () => {
    const keys = filterMoreRows(rows, "dmarc").map((r) => r.key);
    expect(keys).toEqual(["dmarc"]);
  });

  it("puts the better match first even when it appears later in the input", () => {
    // "Audit log" is a label prefix hit; "Audit sinks" is too but sorts by
    // score then original order, so both survive and the tighter one leads.
    const keys = filterMoreRows(rows, "audit l").map((r) => r.key);
    expect(keys[0]).toBe("audit");
  });

  it("finds a destination by its hint when the label does not contain the word", () => {
    const keys = filterMoreRows(rows, "invoices").map((r) => r.key);
    expect(keys).toEqual(["billing"]);
  });

  it("returns an empty array rather than the full list when nothing matches", () => {
    expect(filterMoreRows(rows, "qqqq")).toEqual([]);
  });

  it("does not mutate its input", () => {
    const snapshot = rows.map((r) => r.key);
    filterMoreRows(rows, "audit");
    expect(rows.map((r) => r.key)).toEqual(snapshot);
  });
});

describe("moreFilterHeading", () => {
  it("says 0 matches rather than hiding the count", () => {
    expect(moreFilterHeading(0)).toBe("0 matches");
  });
  it("singularises", () => {
    expect(moreFilterHeading(1)).toBe("1 match");
  });
  it("pluralises", () => {
    expect(moreFilterHeading(7)).toBe("7 matches");
  });
});
