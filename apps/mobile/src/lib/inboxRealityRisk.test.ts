import { describe, expect, it } from "vitest";

import { inboxRealityRiskExplanation } from "./inboxRealityRisk";

describe("inboxRealityRiskExplanation", () => {
  it("uses the predictor's weighted component values", () => {
    const text = inboxRealityRiskExplanation({
      weights: { content: 0.4, reputation: 0.3, auth: 0.15, engagement: 0.15 },
      content: 0.8,
      reputation: 0.2,
      auth: 0.4,
      engagement: 0.1,
      combined: 0.455,
      assumptions: ["auth check not supplied"],
    });

    expect(text).toContain("Overall modeled risk is 46%");
    expect(text).toContain("Content 32 points");
    expect(text).toContain("auth check not supplied");
  });

  it("returns null when no breakdown was supplied", () => {
    expect(inboxRealityRiskExplanation(undefined)).toBeNull();
    expect(inboxRealityRiskExplanation({})).toBeNull();
  });
});
