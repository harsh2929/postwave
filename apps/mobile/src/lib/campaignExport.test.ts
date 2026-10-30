import { describe, expect, it } from "vitest";

import {
  campaignExportCaveat,
  campaignExportText,
  campaignsToCsv,
  csvCell,
} from "./campaignExport";

describe("csvCell", () => {
  it("quotes and doubles embedded quotes", () => {
    expect(csvCell('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
  });

  /**
   * A campaign named `=HYPERLINK(...)` runs on open in Excel and Numbers.
   * The Go exporter guards the same four characters.
   */
  it("neutralises a formula-injection prefix", () => {
    expect(csvCell("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-5")).toBe("'-5");
    expect(csvCell("@x")).toBe("'@x");
  });

  it("renders absent values as empty, never as the string undefined", () => {
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(null)).toBe("");
  });
});

describe("campaignsToCsv", () => {
  it("emits a header even for an empty set", () => {
    expect(campaignsToCsv([])).toBe(
      "id,name,subject,status,scheduled_at,sent_at,created_at,open_rate_pct,click_rate_pct\r\n",
    );
  });

  /**
   * ABSENCE IS NOT ZERO. A campaign the server sent no rate for must leave
   * the cell EMPTY, or a spreadsheet AVERAGE() counts it as a 0% open rate.
   */
  it("leaves an unmeasured rate blank rather than writing 0", () => {
    const csv = campaignsToCsv([{ id: "1", name: "A", status: "draft" }]);
    expect(csv.trimEnd().split("\r\n")[1]).toBe("1,A,,draft,,,,,");
  });

  it("scales the 0..1 list fractions into percent columns", () => {
    const csv = campaignsToCsv([
      { id: "1", name: "A", open_rate: 0.423, click_rate: 0.005 },
    ]);
    const row = csv.trimEnd().split("\r\n")[1] ?? "";
    expect(row.endsWith("42.3,0.5")).toBe(true);
  });
});

describe("campaignExportCaveat", () => {
  it("says plainly when the export is only the loaded window", () => {
    const line = campaignExportCaveat({
      exported: 100,
      moreAvailable: true,
      selection: false,
    });
    expect(line).toContain("100");
    expect(line).toContain("not the whole workspace");
  });

  it("drops the caveat once every page is loaded", () => {
    const line = campaignExportCaveat({
      exported: 7,
      moreAvailable: false,
      selection: false,
    });
    expect(line).not.toContain("not the whole workspace");
  });

  it("names the filter and the search that produced the rows", () => {
    const line = campaignExportCaveat({
      exported: 3,
      moreAvailable: false,
      selection: false,
      filterLabel: "Draft",
      query: "spring",
    });
    expect(line).toContain("draft");
    expect(line).toContain('matching "spring"');
  });

  it("describes a hand-picked selection as such", () => {
    expect(
      campaignExportCaveat({
        exported: 2,
        moreAvailable: true,
        selection: true,
      }),
    ).toBe("2 selected campaigns.");
  });
});

describe("campaignExportText", () => {
  it("puts the caveat above the CSV so a paste carries its own scope", () => {
    const text = campaignExportText([{ id: "1" }], {
      exported: 1,
      moreAvailable: false,
      selection: true,
    });
    expect(text.startsWith("# 1 selected campaign.")).toBe(true);
    expect(text).toContain("id,name,subject");
  });
});
