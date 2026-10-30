import { describe, expect, it } from "vitest";

import {
  parseSmsExportTruth,
  smsExportReasonError,
  smsExportReceiptLine,
} from "./smsExport";

function headers(map: Record<string, string>) {
  return {
    get: (name: string) => map[name] ?? null,
  };
}

const GOOD = {
  "X-Postwave-Export-Limit": "10000",
  "X-Postwave-Export-As-Of": "2026-08-21T10:00:00Z",
  "X-Postwave-Export-Row-Count": "42",
  "X-Postwave-Truncated": "false",
};

describe("smsExportReasonError", () => {
  it("requires a recorded 1..160 safe-character reason", () => {
    expect(smsExportReasonError("quarterly compliance review")).toBeNull();
    expect(smsExportReasonError("   ")).toContain("required");
    expect(smsExportReasonError("a".repeat(161))).toContain("160");
  });
});

describe("parseSmsExportTruth", () => {
  it("parses the four server-bounds headers", () => {
    expect(parseSmsExportTruth(headers(GOOD))).toEqual({
      limit: 10_000,
      asOf: "2026-08-21T10:00:00Z",
      rowCount: 42,
      truncated: false,
    });
  });

  it("returns null for missing or inconsistent headers", () => {
    expect(
      parseSmsExportTruth(
        headers({ ...GOOD, "X-Postwave-Export-As-Of": "" }),
      ),
    ).toBeNull();
    expect(
      parseSmsExportTruth(
        headers({ ...GOOD, "X-Postwave-Export-Row-Count": "10001" }),
      ),
    ).toBeNull();
    expect(
      parseSmsExportTruth(headers({ ...GOOD, "X-Postwave-Truncated": "yes" })),
    ).toBeNull();
  });
});

describe("smsExportReceiptLine", () => {
  it("carries the truncation warning verbatim when the cap cut it short", () => {
    expect(
      smsExportReceiptLine({
        limit: 10_000,
        asOf: "2026-08-21T10:00:00Z",
        rowCount: 10_000,
        truncated: true,
      }),
    ).toContain("TRUNCATED at the 10000-row server cap");
    expect(
      smsExportReceiptLine({
        limit: 10_000,
        asOf: "2026-08-21T10:00:00Z",
        rowCount: 42,
        truncated: false,
      }),
    ).not.toContain("TRUNCATED");
  });
});
