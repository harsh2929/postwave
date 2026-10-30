/**
 * The two rules worth failing a build over:
 *   - the server's CSV is re-emitted, so a `+`/`=`-leading email cannot paste
 *     an executable formula into a support agent's spreadsheet;
 *   - a capped export SAYS it was capped.
 */
import { describe, expect, it } from "vitest";

import { csvField, csvLine, parseCsvRows } from "./csvShare";
import {
  suppressionCsv,
  suppressionExportNotice,
  suppressionExportPath,
  SUPPRESSION_EXPORT_MAX_ROWS,
} from "./suppressionExport";

const HEADER = "email,reason,created_at";

function serverCsv(rows: readonly (readonly string[])[]): string {
  return [HEADER, ...rows.map((row) => row.join(","))].join("\n") + "\n";
}

describe("parseCsvRows", () => {
  it("keeps a quoted comma inside its field", () => {
    expect(parseCsvRows('a,"b,c",d')).toEqual([["a", "b,c", "d"]]);
  });

  it("unescapes doubled quotes", () => {
    expect(parseCsvRows('"he said ""hi""",x')).toEqual([['he said "hi"', "x"]]);
  });

  it("keeps a newline inside a quoted field and splits on the real one", () => {
    expect(parseCsvRows('"line\nbreak",x\ny,z')).toEqual([
      ["line\nbreak", "x"],
      ["y", "z"],
    ]);
  });

  it("handles CRLF row endings and drops the trailing blank line", () => {
    expect(parseCsvRows("a,b\r\nc,d\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("returns nothing for empty text", () => {
    expect(parseCsvRows("")).toEqual([]);
  });

  it("round-trips through csvLine", () => {
    const fields = ['Yahoo!, Inc.', 'He said "hi"', "line\nbreak"];
    expect(parseCsvRows(csvLine(fields))).toEqual([fields]);
  });
});

describe("suppressionExportPath", () => {
  it("bounds the requested row count", () => {
    expect(suppressionExportPath(50)).toBe(
      "/api/v1/suppressions/export?limit=50",
    );
    expect(suppressionExportPath(9_999_999)).toBe(
      `/api/v1/suppressions/export?limit=${SUPPRESSION_EXPORT_MAX_ROWS}`,
    );
    expect(suppressionExportPath(0)).toBe("/api/v1/suppressions/export?limit=1");
    expect(suppressionExportPath(-4)).toBe("/api/v1/suppressions/export?limit=1");
  });
});

describe("suppressionCsv", () => {
  it("drops the server's header and keeps every data row", () => {
    const result = suppressionCsv(
      serverCsv([
        ["a@example.com", "hard_bounce", "2026-07-01T00:00:00Z"],
        ["b@example.com", "complaint", "2026-07-02T00:00:00Z"],
      ]),
    );
    expect(result.included).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.body.split("\n")).toEqual([
      "email,reason,created_at",
      "a@example.com,hard_bounce,2026-07-01T00:00:00Z",
      "b@example.com,complaint,2026-07-02T00:00:00Z",
    ]);
  });

  it("neutralises a formula the server would have forwarded verbatim", () => {
    // The API's own csvJoinSuppressions writes this through unquoted.
    const raw = serverCsv([
      ["=HYPERLINK(\"http://evil\")@x.com", "manual", "2026-07-01T00:00:00Z"],
      ["+tagged@example.com", "manual", "2026-07-01T00:00:00Z"],
    ]);
    expect(raw).toContain("=HYPERLINK");
    const body = suppressionCsv(raw).body;
    expect(body).toContain(`"'=HYPERLINK(""http://evil"")@x.com"`);
    expect(body).toContain("'+tagged@example.com");
    expect(body).not.toMatch(/^=HYPERLINK/m);
    expect(body).not.toMatch(/^\+tagged/m);
  });

  it("preserves a quoted comma through the re-emit", () => {
    const raw = `${HEADER}\n"a,b@example.com",reason,when\n`;
    expect(suppressionCsv(raw).body).toContain('"a,b@example.com"');
  });

  it("treats an exactly-full response as truncated, never as the whole list", () => {
    // The request asked for 3 and got 3 — the server may hold thousands more,
    // and this export has no way to know. Saying "(3)" would be a lie.
    const rows = Array.from({ length: 3 }, (_, i) => [
      `p${i}@example.com`,
      "manual",
      "2026-07-01T00:00:00Z",
    ]);
    const result = suppressionCsv(serverCsv(rows), { cap: 3 });
    expect(result.included).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.title).toContain("newest 3");
  });

  it("caps the share payload and says so in the title", () => {
    const rows = Array.from({ length: 12 }, (_, i) => [
      `p${i}@example.com`,
      "manual",
      "2026-07-01T00:00:00Z",
    ]);
    const result = suppressionCsv(serverCsv(rows), { cap: 5 });
    expect(result.included).toBe(5);
    expect(result.truncated).toBe(true);
    expect(result.title).toContain("newest 5");
  });

  it("reports truncation when the tenant has more than the export asked for", () => {
    const result = suppressionCsv(
      serverCsv([["a@example.com", "manual", "2026-07-01T00:00:00Z"]]),
      { total: 4000 },
    );
    expect(result.truncated).toBe(true);
    expect(result.title).toBe("Suppressed addresses — newest 1 of 4000");
  });

  it("refuses to invent a denominator when the total is unknown", () => {
    const result = suppressionCsv(
      serverCsv([["a@example.com", "manual", "2026-07-01T00:00:00Z"]]),
      { total: 0 },
    );
    expect(result.title).toBe("Suppressed addresses (1)");
  });

  it("survives an empty body and a header-only body", () => {
    expect(suppressionCsv("").included).toBe(0);
    expect(suppressionCsv(`${HEADER}\n`).included).toBe(0);
    expect(suppressionCsv(`${HEADER}\n`).body).toBe(HEADER);
  });
});

describe("suppressionExportNotice", () => {
  const base = { body: "", title: "", included: 3, truncated: false };

  it("names the difference when a filter is on screen", () => {
    expect(suppressionExportNotice(base, { filtered: true })).toContain(
      "not the filter on screen",
    );
    expect(suppressionExportNotice(base, { filtered: false })).not.toContain(
      "filter",
    );
  });

  it("says the set was capped", () => {
    expect(
      suppressionExportNotice({ ...base, truncated: true }, { filtered: false }),
    ).toContain("the rest need the web export");
  });

  it("does not claim a share when nothing came back", () => {
    expect(
      suppressionExportNotice({ ...base, included: 0 }, { filtered: false }),
    ).toBe("There was nothing to export.");
  });
});

describe("csvField stays the single escaper", () => {
  it("is the same rule dmarcExport uses", async () => {
    const dmarc = await import("./dmarcExport");
    expect(dmarc.csvField).toBe(csvField);
  });
});
