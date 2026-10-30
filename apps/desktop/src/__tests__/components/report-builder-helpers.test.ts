// Tests for report-builder-helpers — the pure logic behind the KLV-12
// metric report builder. These pin the load-bearing behavior the React
// surface relies on: column derivation (order + tolerance for empty rows),
// RFC-4180-ish CSV escaping (comma / quote / newline / empty / missing keys),
// the server-mirrored caps, picker grouping, and the selectable-dimension
// union. Pure module → runs in the node suite without a JSX transform.

import { describe, expect, it } from "vitest";

import type { ReportMetricDefinition } from "../../lib/api-client";
import {
  MAX_DIMENSIONS,
  MAX_METRICS,
  REPORT_EXECUTABLE_DIMENSIONS,
  canAddDimension,
  canAddMetric,
  cellToString,
  deriveColumns,
  isSupported,
  isReportDimensionExecutable,
  isTerminalRunStatus,
  metricsByArea,
  rowsToCsv,
  runResultRows,
  selectableDimensions,
} from "../../components/analytics/report-builder-helpers";

function def(p: Partial<ReportMetricDefinition>): ReportMetricDefinition {
  return {
    key: "k",
    label: "Label",
    product_area: "general",
    source: "src",
    aggregation: "sum",
    value_type: "number",
    runtime_status: "supported",
    ...p,
  };
}

describe("caps", () => {
  it("exposes the server-enforced cap constants", () => {
    expect(MAX_METRICS).toBe(10);
    expect(MAX_DIMENSIONS).toBe(5);
  });

  it("canAddMetric allows up to but not beyond 10", () => {
    expect(canAddMetric(0)).toBe(true);
    expect(canAddMetric(9)).toBe(true);
    expect(canAddMetric(10)).toBe(false);
    expect(canAddMetric(11)).toBe(false);
  });

  it("canAddDimension allows up to but not beyond 5", () => {
    expect(canAddDimension(0)).toBe(true);
    expect(canAddDimension(4)).toBe(true);
    expect(canAddDimension(5)).toBe(false);
  });
});

describe("deriveColumns", () => {
  it("orders dimensions first, then metric alias-or-key", () => {
    const cols = deriveColumns(
      {
        dimensions: ["day", "country"],
        metrics: [{ key: "opens" }, { key: "clicks", alias: "click_total" }],
      },
      [],
    );
    expect(cols).toEqual(["day", "country", "opens", "click_total"]);
  });

  it("tolerates an empty/null request and empty rows", () => {
    expect(deriveColumns(null, null)).toEqual([]);
    expect(deriveColumns(undefined, [])).toEqual([]);
    expect(deriveColumns({ metrics: [] }, [])).toEqual([]);
  });

  it("de-duplicates while preserving first-seen order", () => {
    const cols = deriveColumns(
      {
        dimensions: ["day", "day"],
        metrics: [{ key: "day" }, { key: "opens" }],
      },
      [],
    );
    expect(cols).toEqual(["day", "opens"]);
  });

  it("appends extra row keys the request didn't anticipate, last", () => {
    const cols = deriveColumns(
      { dimensions: ["day"], metrics: [{ key: "opens" }] },
      [{ day: "2026-01-01", opens: 3, server_extra: 9 }],
    );
    expect(cols).toEqual(["day", "opens", "server_extra"]);
  });

  it("uses alias over key when an alias is present and non-blank", () => {
    const cols = deriveColumns(
      {
        metrics: [
          { key: "opens", alias: "  " },
          { key: "clicks", alias: "c" },
        ],
      },
      [],
    );
    // blank alias falls back to the key
    expect(cols).toEqual(["opens", "c"]);
  });
});

describe("rowsToCsv", () => {
  it("emits a header row plus one row per data row, CRLF-separated", () => {
    const csv = rowsToCsv(
      ["day", "opens"],
      [
        { day: "2026-01-01", opens: 5 },
        { day: "2026-01-02", opens: 7 },
      ],
    );
    // CRLF-terminated (trailing CRLF included) per the Excel-friendly
    // RFC-4180 convention rowsToCsv emits.
    expect(csv).toBe("day,opens\r\n2026-01-01,5\r\n2026-01-02,7\r\n");
  });

  it("quotes fields containing a comma", () => {
    const csv = rowsToCsv(["name"], [{ name: "Smith, Jane" }]);
    expect(csv).toBe('name\r\n"Smith, Jane"\r\n');
  });

  it("escapes embedded double-quotes by doubling them", () => {
    const csv = rowsToCsv(["q"], [{ q: 'she said "hi"' }]);
    expect(csv).toBe('q\r\n"she said ""hi"""\r\n');
  });

  it("quotes fields containing newlines (CR or LF)", () => {
    const csv = rowsToCsv(["note"], [{ note: "line1\nline2" }]);
    expect(csv).toBe('note\r\n"line1\nline2"\r\n');
  });

  it("renders missing keys and null/undefined as empty fields", () => {
    const csv = rowsToCsv(["a", "b", "c"], [{ a: "x", b: null, c: undefined }]);
    expect(csv).toBe("a,b,c\r\nx,,\r\n");
  });

  it("quotes a column header that itself contains a comma", () => {
    const csv = rowsToCsv(["a,b"], []);
    expect(csv).toBe('"a,b"\r\n');
  });

  it("tolerates empty/null columns and rows", () => {
    expect(rowsToCsv([], [])).toBe("");
    expect(rowsToCsv(null, null)).toBe("");
    expect(rowsToCsv(["a"], null)).toBe("a\r\n");
  });

  it("serializes objects/arrays as JSON in a cell", () => {
    const csv = rowsToCsv(["obj"], [{ obj: { x: 1 } }]);
    // The JSON {"x":1} contains double-quotes, so the field is quoted and the
    // inner quotes are doubled per RFC-4180.
    expect(csv).toBe('obj\r\n"{""x"":1}"\r\n');
  });

  it("neutralizes formula-shaped cells and headers, including hidden prefixes", () => {
    expect(
      rowsToCsv(
        ["=header", "value"],
        [
          { "=header": "=1+1", value: "\t@cmd" },
          { "=header": "\r-42", value: "+SUM(1,2)" },
        ],
      ),
    ).toBe(
      '\'=header,value\r\n\'=1+1,"\'\t@cmd"\r\n"\'\r-42","\'+SUM(1,2)"\r\n',
    );
  });

  it("keeps genuine negative numeric metrics numeric", () => {
    expect(rowsToCsv(["net"], [{ net: -2500 }])).toBe("net\r\n-2500\r\n");
  });
});

describe("metricsByArea", () => {
  it("groups by product_area, sorts areas and labels", () => {
    const groups = metricsByArea([
      def({ key: "z_open", label: "Opens", product_area: "engagement" }),
      def({ key: "rev", label: "Revenue", product_area: "commerce" }),
      def({ key: "a_click", label: "Clicks", product_area: "engagement" }),
    ]);
    expect(groups.map((g) => g.area)).toEqual(["commerce", "engagement"]);
    // engagement metrics sorted by label: Clicks before Opens
    expect(groups[1].metrics.map((m) => m.key)).toEqual(["a_click", "z_open"]);
  });

  it("buckets blank product_area into 'general' and tolerates bad input", () => {
    const groups = metricsByArea([def({ key: "k1", product_area: "" })]);
    expect(groups[0].area).toBe("general");
    expect(metricsByArea(null)).toEqual([]);
    expect(metricsByArea(undefined)).toEqual([]);
  });
});

describe("selectableDimensions", () => {
  it("returns only executor-backed dimensions shared by every selected metric", () => {
    const dims = selectableDimensions([
      def({ key: "a", dimensions: ["day", "country"] }),
      def({ key: "b", dimensions: ["day", "device"] }),
    ]);
    expect(dims).toEqual(["day"]);
  });

  it("does not advertise declared dimensions the executor silently ignores", () => {
    expect(
      selectableDimensions([
        def({ key: "a", dimensions: ["country", "device"] }),
      ]),
    ).toEqual([]);
    expect(REPORT_EXECUTABLE_DIMENSIONS).toEqual(["day"]);
    expect(isReportDimensionExecutable("day")).toBe(true);
    expect(isReportDimensionExecutable("country")).toBe(false);
  });

  it("is empty for no selection or metrics without dimensions", () => {
    expect(selectableDimensions([])).toEqual([]);
    expect(selectableDimensions(null)).toEqual([]);
    expect(selectableDimensions([def({ key: "a" })])).toEqual([]);
  });
});

describe("isSupported", () => {
  it("is true only for runtime_status 'supported' (case-insensitive)", () => {
    expect(isSupported({ runtime_status: "supported" })).toBe(true);
    expect(isSupported({ runtime_status: "Supported" })).toBe(true);
    expect(isSupported({ runtime_status: "partial" })).toBe(false);
    expect(isSupported({ runtime_status: "planned" })).toBe(false);
    expect(isSupported({})).toBe(false);
  });
});

describe("isTerminalRunStatus", () => {
  it("is true for completed/failed/canceled, false otherwise", () => {
    expect(isTerminalRunStatus("completed")).toBe(true);
    expect(isTerminalRunStatus("failed")).toBe(true);
    expect(isTerminalRunStatus("canceled")).toBe(true);
    expect(isTerminalRunStatus("cancelled")).toBe(true);
    expect(isTerminalRunStatus("running")).toBe(false);
    expect(isTerminalRunStatus("pending")).toBe(false);
    expect(isTerminalRunStatus(null)).toBe(false);
    expect(isTerminalRunStatus(undefined)).toBe(false);
  });
});

describe("runResultRows", () => {
  it("extracts a rows array defensively", () => {
    expect(runResultRows({ rows: [{ day: "x" }, { day: "y" }] })).toEqual([
      { day: "x" },
      { day: "y" },
    ]);
    expect(runResultRows({ rows: "nope" })).toEqual([]);
    expect(runResultRows(null)).toEqual([]);
    expect(runResultRows({})).toEqual([]);
  });

  it("filters out non-object row entries", () => {
    expect(runResultRows({ rows: [{ ok: 1 }, null, 5, "x"] })).toEqual([
      { ok: 1 },
    ]);
  });
});

describe("cellToString", () => {
  it("renders primitives directly and null/undefined as an em dash", () => {
    expect(cellToString("hi")).toBe("hi");
    expect(cellToString(42)).toBe("42");
    expect(cellToString(true)).toBe("true");
    expect(cellToString(null)).toBe("—");
    expect(cellToString(undefined)).toBe("—");
    expect(cellToString({ a: 1 })).toBe('{"a":1}');
  });
});
