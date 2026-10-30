import { describe, expect, it } from "vitest";

import { safeAuthTokenParam } from "../lib/auth-token";

describe("safeAuthTokenParam", () => {
  it("keeps ordinary auth tokens", () => {
    expect(safeAuthTokenParam("tok_123")).toBe("tok_123");
  });

  it("rejects missing and oversized auth tokens", () => {
    expect(safeAuthTokenParam(null)).toBeNull();
    expect(safeAuthTokenParam("a".repeat(3000))).toBeNull();
  });
});
