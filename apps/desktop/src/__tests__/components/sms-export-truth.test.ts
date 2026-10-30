// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { parseSMSExportTruth } from "../../pages/SMSInbox";

function truthHeaders(overrides: Record<string, string | null> = {}): Headers {
  const values: Record<string, string> = {
    "X-Postwave-Export-Limit": "10000",
    "X-Postwave-Export-As-Of": "2026-08-21T12:00:00Z",
    "X-Postwave-Export-Row-Count": "42",
    "X-Postwave-Truncated": "false",
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) delete values[name];
    else values[name] = value;
  }
  return new Headers(values);
}

describe("SMS export truth headers", () => {
  it("accepts an explicit complete response without guessing the cap", () => {
    expect(
      parseSMSExportTruth(
        truthHeaders({
          "X-Postwave-Export-Limit": "250",
          "X-Postwave-Export-Row-Count": "17",
        }),
      ),
    ).toEqual({
      limit: 250,
      asOf: "2026-08-21T12:00:00Z",
      rowCount: 17,
      truncated: false,
    });
  });

  it("requires truncation to be explicit so a stripped true header fails closed", () => {
    expect(
      parseSMSExportTruth(truthHeaders({ "X-Postwave-Truncated": null })),
    ).toBeNull();
    expect(
      parseSMSExportTruth(truthHeaders({ "X-Postwave-Truncated": "False" })),
    ).toBeNull();
    expect(
      parseSMSExportTruth(truthHeaders({ "X-Postwave-Truncated": "true" })),
    ).toMatchObject({ truncated: true });
  });

  it("rejects contradictory counts and invalid snapshot timestamps", () => {
    expect(
      parseSMSExportTruth(
        truthHeaders({ "X-Postwave-Export-Row-Count": "10001" }),
      ),
    ).toBeNull();
    expect(
      parseSMSExportTruth(
        truthHeaders({ "X-Postwave-Export-As-Of": "not-a-timestamp" }),
      ),
    ).toBeNull();
  });
});
