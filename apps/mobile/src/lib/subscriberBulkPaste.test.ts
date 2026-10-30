/**
 * subscriberBulkPaste — the paste split MUST mirror bulk_paste.go, because
 * the count the sheet shows and the cap it enforces are promises about what
 * the server will do with the same raw string.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_BULK_PASTE,
  bulkPasteFailedRows,
  bulkPasteProblem,
  bulkPasteReceipt,
  parseBulkPasteResult,
  parsePastedEmails,
} from "./subscriberBulkPaste";

describe("parsePastedEmails — the server's split, mirrored", () => {
  it("splits on newline, comma, semicolon, tab and space", () => {
    expect(
      parsePastedEmails("a@x.com, b@y.com;c@z.com\nd@w.com\te@v.com f@u.com"),
    ).toEqual([
      "a@x.com",
      "b@y.com",
      "c@z.com",
      "d@w.com",
      "e@v.com",
      "f@u.com",
    ]);
  });

  it("de-dupes case-insensitively, first occurrence wins, order preserved", () => {
    expect(parsePastedEmails("A@x.com\nb@y.com\na@X.COM")).toEqual([
      "A@x.com",
      "b@y.com",
    ]);
  });

  it("ignores blank fields", () => {
    expect(parsePastedEmails("  \n , ;\n")).toEqual([]);
  });
});

describe("bulkPasteProblem", () => {
  it("refuses offline with the receipt rationale", () => {
    expect(bulkPasteProblem("a@x.com", false)).toMatch(/offline/i);
  });

  it("refuses an empty paste and an over-cap paste; accepts the rest", () => {
    expect(bulkPasteProblem("", true)).toMatch(/at least one address/);
    const over = Array.from(
      { length: MAX_BULK_PASTE + 1 },
      (_, i) => `p${i}@x.com`,
    ).join("\n");
    expect(bulkPasteProblem(over, true)).toMatch(/capped at 100/);
    expect(bulkPasteProblem("a@x.com b@y.com", true)).toBeNull();
  });
});

describe("response parsing + receipt", () => {
  const payload = {
    parsed: 4,
    created: 2,
    updated: 1,
    skipped: 0,
    errored: 1,
    rows: [
      { email: "a@x.com", status: "created" },
      { email: "b@y.com", status: "created" },
      { email: "c@z.com", status: "updated" },
      { email: "bad@", status: "error", error: "invalid address" },
    ],
  };

  it("parses the BulkPasteResponse and isolates the failures", () => {
    const result = parseBulkPasteResult(payload);
    expect(result.created).toBe(2);
    expect(bulkPasteFailedRows(result)).toEqual([
      { email: "bad@", status: "error", error: "invalid address" },
    ]);
  });

  it("names every non-zero counter in the receipt — failures never swallowed", () => {
    expect(bulkPasteReceipt(parseBulkPasteResult(payload))).toBe(
      "2 added, 1 already existed and were updated, 1 failed — of 4 pasted addresses.",
    );
  });

  it("degrades junk to an empty result", () => {
    const result = parseBulkPasteResult("nope");
    expect(result).toEqual({
      parsed: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      errored: 0,
      rows: [],
    });
    expect(bulkPasteReceipt(result)).toBe(
      "Nothing was added — of 0 pasted addresses.",
    );
  });
});
