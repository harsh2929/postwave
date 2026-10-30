import { describe, expect, it } from "vitest";

import { normalizeStoredTourStep } from "./tourPersistence";

describe("normalizeStoredTourStep", () => {
  it("resumes a valid persisted index", () => {
    expect(normalizeStoredTourStep("3", 6)).toBe(3);
  });

  it("clamps an old index after adaptive steps shrink", () => {
    expect(normalizeStoredTourStep("8", 4)).toBe(3);
  });

  it("falls back safely for corrupt or empty state", () => {
    expect(normalizeStoredTourStep("nope", 4)).toBe(0);
    expect(normalizeStoredTourStep("-1", 4)).toBe(0);
    expect(normalizeStoredTourStep(null, 4)).toBe(0);
  });
});
