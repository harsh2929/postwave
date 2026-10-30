import { describe, expect, it } from "vitest";

import { TINT_ALPHA, TINT_ALPHA_STRONG, withAlpha } from "./color";

describe("withAlpha", () => {
  it("converts a 6-digit hex to rgba", () => {
    expect(withAlpha("#f97316", 0.1)).toBe("rgba(249,115,22,0.1)");
    expect(withAlpha("#000000", 1)).toBe("rgba(0,0,0,1)");
  });

  it("returns a non-hex colour untouched rather than producing an unparseable string", () => {
    // The concatenated form this replaces would have produced "rgb(1,2,3)14".
    expect(withAlpha("rgb(1,2,3)", 0.1)).toBe("rgb(1,2,3)");
    expect(withAlpha("#f9731680", 0.1)).toBe("#f9731680");
    expect(withAlpha("#abc", 0.1)).toBe("#abc");
    expect(withAlpha("", 0.1)).toBe("");
  });

  it("clamps the alpha into 0..1", () => {
    expect(withAlpha("#ffffff", 5)).toBe("rgba(255,255,255,1)");
    expect(withAlpha("#ffffff", -3)).toBe("rgba(255,255,255,0)");
  });

  it("exposes one tint strength so the same idea looks the same everywhere", () => {
    expect(TINT_ALPHA).toBeGreaterThan(0);
    expect(TINT_ALPHA_STRONG).toBeGreaterThan(TINT_ALPHA);
  });
});
