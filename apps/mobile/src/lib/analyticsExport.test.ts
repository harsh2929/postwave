import { describe, expect, it } from "vitest";

import {
  ANALYTICS_EXPORT_MAX_ROWS,
  analyticsExportNotice,
  buildAnalyticsCsv,
} from "./analyticsExport";

const BASE = {
  rangeLabel: "Last 30 days",
  takenAt: "2026-07-25T12:00:00.000Z",
};

describe("analytics CSV export", () => {
  it("records the window and take-time so the numbers stay re-checkable", () => {
    const out = buildAnalyticsCsv({
      ...BASE,
      series: [
        {
          section: "Audience growth",
          columns: ["date", "subscribers"],
          rows: [["2026-07-01", 100]],
        },
      ],
    });
    expect(out.body).toContain("# Moosewave analytics · Last 30 days");
    expect(out.body).toContain("# Exported 2026-07-25T12:00:00.000Z");
    expect(out.included).toBe(1);
    expect(out.title).toBe("Moosewave analytics — Last 30 days");
  });

  // The rule this module exists for.
  it("writes an unreported measurement as an empty cell, never as zero", () => {
    const out = buildAnalyticsCsv({
      ...BASE,
      series: [
        {
          section: "Deliverability",
          columns: ["metric", "value"],
          rows: [
            ["open_rate", null],
            ["click_rate", 0],
          ],
        },
      ],
    });
    const lines = out.body.split("\n");
    expect(lines).toContain("Deliverability,open_rate,");
    // A genuine zero still writes as 0 — the two are different facts.
    expect(lines).toContain("Deliverability,click_rate,0");
  });

  it("names the sections that could not contribute", () => {
    const out = buildAnalyticsCsv({
      ...BASE,
      series: [
        { section: "Audience growth", columns: ["date"], rows: [["2026-07-01"]] },
        // Loaded, but genuinely empty — still called out, because a reader who
        // does not know a section is absent reads its absence as a zero.
        { section: "Revenue", columns: ["campaign", "revenue"], rows: [] },
      ],
      unavailable: ["Customer value"],
    });
    expect(out.body).toContain("# Not included: Customer value, Revenue");
    expect(out.unavailable).toEqual(["Customer value", "Revenue"]);
    expect(analyticsExportNotice(out)).toBe(
      "Shared 1 row. Not included: Customer value, Revenue.",
    );
  });

  it("neutralises a formula-leading cell before a spreadsheet executes it", () => {
    const out = buildAnalyticsCsv({
      ...BASE,
      series: [
        {
          section: "Top performers",
          columns: ["template", "opens"],
          // A template name is operator-supplied free text.
          rows: [["=HYPERLINK(\"http://evil\",\"click\")", 4]],
        },
      ],
    });
    expect(out.body).toContain("'=HYPERLINK");
    // And the embedded comma has not shifted the columns.
    expect(out.body).toContain('"\'=HYPERLINK(""http://evil"",""click"")"');
  });

  it("caps the payload and says so, rather than shipping a mangled blob", () => {
    const rows = Array.from({ length: ANALYTICS_EXPORT_MAX_ROWS + 25 }, (_, i) => [
      `2026-07-${(i % 28) + 1}`,
      i,
    ]);
    const out = buildAnalyticsCsv({
      ...BASE,
      series: [{ section: "Audience growth", columns: ["date", "count"], rows }],
    });
    expect(out.included).toBe(ANALYTICS_EXPORT_MAX_ROWS);
    expect(out.truncated).toBe(true);
    expect(analyticsExportNotice(out)).toContain("the rest need the web export");
  });

  it("pads a narrow section so a wider one cannot shift its columns", () => {
    const out = buildAnalyticsCsv({
      ...BASE,
      series: [
        {
          section: "Bands",
          columns: ["band", "profiles", "share"],
          rows: [["champions", 10, "60%"]],
        },
        { section: "Growth", columns: ["date"], rows: [["2026-07-01"]] },
      ],
    });
    const lines = out.body.split("\n");
    expect(lines).toContain("Growth,2026-07-01,,");
    expect(lines).toContain("section,field_1,field_2,field_3");
  });

  it("produces a header-free document, and an honest notice, with no data", () => {
    const out = buildAnalyticsCsv({
      ...BASE,
      series: [{ section: "Revenue", columns: ["campaign"], rows: [] }],
    });
    expect(out.included).toBe(0);
    expect(out.body).not.toContain("section,field_1");
    expect(analyticsExportNotice(out)).toBe(
      "Nothing to export — Revenue could not be read.",
    );
  });
});
