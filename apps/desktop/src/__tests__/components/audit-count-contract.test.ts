import { describe, expect, it } from "vitest";

import { parseAuditCount } from "../../components/audit/audit-count-contract";

describe("audit count runtime contract", () => {
  it("accepts exact and approximate non-negative estimates", () => {
    expect(parseAuditCount({ totalEstimate: 0, confidence: "exact" })).toEqual(
      { totalEstimate: 0, confidence: "exact" },
    );
    expect(
      parseAuditCount({ totalEstimate: 42, confidence: "approximate" }),
    ).toEqual({ totalEstimate: 42, confidence: "approximate" });
  });

  it("rejects malformed successful payloads", () => {
    expect(parseAuditCount({})).toBeNull();
    expect(parseAuditCount({ totalEstimate: -1, confidence: "exact" })).toBeNull();
    expect(
      parseAuditCount({ totalEstimate: Number.NaN, confidence: "exact" }),
    ).toBeNull();
    expect(parseAuditCount({ totalEstimate: 1, confidence: "unknown" })).toBeNull();
  });
});
