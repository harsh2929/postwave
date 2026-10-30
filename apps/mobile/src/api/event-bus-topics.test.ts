import { describe, expect, it } from "vitest";

import { normalizeEventBusTopics } from "./event-bus-topics";

describe("mobile event-bus topic normalization", () => {
  it("deduplicates and trims valid topic patterns", () => {
    expect(
      normalizeEventBusTopics([" campaign.* ", "campaign.*", "audit.created"]),
    ).toBe("campaign.*,audit.created");
  });

  it("drops invalid topic patterns and falls back to catch-all", () => {
    expect(
      normalizeEventBusTopics(["Campaign.*", "../audit", "campaign created"]),
    ).toBe("*");
  });

  it("caps topic count and total CSV size", () => {
    expect(
      normalizeEventBusTopics(Array.from({ length: 75 }, (_, i) => `t${i}.event`))
        .split(",")
        .length,
    ).toBe(50);
    expect(
      normalizeEventBusTopics(
        Array.from({ length: 50 }, (_, i) => `verylongtopic${i}.verylongevent`),
      ),
    ).toBe("*");
  });
});
