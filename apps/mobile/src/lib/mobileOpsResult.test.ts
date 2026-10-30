import { describe, expect, it } from "vitest";

import { opsTimestamp, unwrapMobileResult } from "./mobileOpsResult";

describe("unwrapMobileResult", () => {
  it("returns the payload when the envelope carries one", () => {
    expect(unwrapMobileResult({ data: [1, 2], error: null }, "Rows")).toEqual([
      1, 2,
    ]);
  });

  it("throws the server message when the envelope carries an error", () => {
    expect(() =>
      unwrapMobileResult(
        { data: null, error: { status: 403, message: "forbidden" } },
        "Audit sinks",
      ),
    ).toThrow("forbidden");
  });

  it("names the surface when the error has no message", () => {
    expect(() =>
      unwrapMobileResult(
        { data: null, error: { status: 500, message: "" } },
        "Audit sinks",
      ),
    ).toThrow("Audit sinks failed");
  });

  it("throws rather than reporting an absent payload as empty", () => {
    // The whole point: `{data: null, error: null}` must never reach a screen
    // as a successful empty list (house rule 8 — a failed fetch is an error
    // state, never an empty list).
    expect(() =>
      unwrapMobileResult({ data: null, error: null }, "SCIM tokens"),
    ).toThrow("SCIM tokens returned no data");
  });

  it("passes a falsy-but-present payload through untouched", () => {
    expect(unwrapMobileResult({ data: 0, error: null }, "Count")).toBe(0);
    expect(unwrapMobileResult({ data: "", error: null }, "Name")).toBe("");
    expect(unwrapMobileResult({ data: false, error: null }, "Flag")).toBe(false);
  });
});

describe("opsTimestamp", () => {
  it("parses an ISO timestamp", () => {
    expect(opsTimestamp("2026-07-25T12:00:00.000Z")).toBe(
      Date.parse("2026-07-25T12:00:00.000Z"),
    );
  });

  it("sorts an absent timestamp last under a descending comparator", () => {
    const rows = [
      { at: null },
      { at: "2026-07-25T12:00:00.000Z" },
      { at: undefined },
      { at: "2026-07-26T12:00:00.000Z" },
    ];
    const sorted = [...rows].sort(
      (a, b) => opsTimestamp(b.at) - opsTimestamp(a.at),
    );
    expect(sorted[0]?.at).toBe("2026-07-26T12:00:00.000Z");
    expect(sorted[1]?.at).toBe("2026-07-25T12:00:00.000Z");
  });

  it("treats an unparseable value as absent rather than NaN", () => {
    // NaN would poison every comparison it took part in and scramble the
    // whole list, not just its own row.
    expect(opsTimestamp("not a date")).toBe(0);
    expect(Number.isNaN(opsTimestamp("not a date"))).toBe(false);
  });
});
