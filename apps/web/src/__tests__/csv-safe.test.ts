// SPDX-License-Identifier: AGPL-3.0-only
//
// Cross-surface parity test. The Go API neutralises spreadsheet formula
// injection on every server-generated export
// (apps/api/internal/track/extras.go `spreadsheetSafeCSVCell`), and the
// marketing site publishes that as a guarantee:
//
//   "CSV cells starting with =, +, -, or @ are prefixed with a quote to
//    neutralise spreadsheet formula injection on open."
//
// Client-side exports (affiliate conversions/payouts, analytics overview,
// campaign custom reports, migration verification) are assembled in the browser
// and never touch that Go path, so they used to ship the raw cell. The cases
// below mirror apps/api/internal/track/csv_export_test.go one-for-one so the
// two implementations cannot drift.
import { describe, expect, it } from "vitest";

import { csvCell as affiliateCsvCell } from "@/lib/affiliate-csv";
import { csvCell as analyticsCsvCell } from "@/lib/analytics-format";
import { safeCsvCell, spreadsheetSafeCell } from "@/lib/csv-safe";

describe("spreadsheetSafeCell (parity with Go spreadsheetSafeCSVCell)", () => {
  const cases: Array<[name: string, input: string, want: string]> = [
    ["equals", "=1+1", "'=1+1"],
    ["plus", "+SUM(A1:A2)", "'+SUM(A1:A2)"],
    ["minus", "-2+3", "'-2+3"],
    ["at", "@SUM(A1:A2)", "'@SUM(A1:A2)"],
    ["tab", "\t=cmd", "'\t=cmd"],
    ["carriage_return", "\r=cmd", "'\r=cmd"],
    ["line_feed", "\n=cmd", "'\n=cmd"],
    ["nul", "\u0000=cmd", "'\u0000=cmd"],
    ["format_mark", "\uFEFF=cmd", "'\uFEFF=cmd"],
    ["formula_after_spaces", "  =cmd", "'  =cmd"],
    ["safe_after_spaces", "  checkout.completed", "  checkout.completed"],
    ["ordinary", "checkout.completed", "checkout.completed"],
    [
      "quoted_comma_newline",
      'quoted, "value"\nnext',
      'quoted, "value"\nnext',
    ],
    ["empty", "", ""],
  ];

  for (const [name, input, want] of cases) {
    it(name, () => {
      expect(spreadsheetSafeCell(input)).toBe(want);
    });
  }
});

describe("safeCsvCell", () => {
  it("applies the formula guard INSIDE the quoted field", () => {
    // Guarding after quoting would emit '"=a,b" with the apostrophe outside the
    // quotes, which corrupts the record.
    expect(safeCsvCell("=a,b")).toBe(`"'=a,b"`);
  });

  it("keeps RFC-4180 escaping intact", () => {
    expect(safeCsvCell("plain")).toBe("plain");
    expect(safeCsvCell(12)).toBe("12");
    expect(safeCsvCell(null)).toBe("");
    expect(safeCsvCell(undefined)).toBe("");
    expect(safeCsvCell("a,b")).toBe('"a,b"');
    expect(safeCsvCell('has "quote"')).toBe('"has ""quote"""');
    expect(safeCsvCell("line\nbreak")).toBe('"line\nbreak"');
  });

  it("does not treat a negative number as a formula lead", () => {
    // A numeric -5 is a legitimate value, but it still starts with '-', so the
    // guard applies uniformly rather than special-casing numbers. Documented
    // here so the behaviour is deliberate rather than surprising.
    expect(safeCsvCell(-5)).toBe("'-5");
  });
});

describe("both client CSV builders uphold the published guarantee", () => {
  it("affiliate export neutralises a partner-supplied formula", () => {
    expect(affiliateCsvCell('=HYPERLINK("http://evil","claim")')).toBe(
      `"'=HYPERLINK(""http://evil"",""claim"")"`,
    );
  });

  it("analytics export neutralises a formula", () => {
    expect(analyticsCsvCell("@SUM(A1:A2)")).toBe("'@SUM(A1:A2)");
  });
});
