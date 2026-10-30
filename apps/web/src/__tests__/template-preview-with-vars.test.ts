// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { sampleScenarioValues } from "@/app/(dashboard)/app/templates/_components/template-sample-data";

describe("personalization scenarios", () => {
  const keys = ["first_name", "unsubscribe_url"];
  const defaults = { first_name: "Ada", unsubscribe_url: "https://example.invalid/u" };

  it("restores declared defaults without mutating them", () => {
    const result = sampleScenarioValues(keys, defaults, "defaults");
    expect(result).toEqual(defaults);
    expect(result).not.toBe(defaults);
  });

  it("exposes unresolved values and stresses narrow layouts with safe URL placeholders", () => {
    expect(sampleScenarioValues(keys, defaults, "missing")).toEqual({
      first_name: "",
      unsubscribe_url: "",
    });
    const long = sampleScenarioValues(keys, defaults, "long");
    expect(long.first_name.length).toBeGreaterThan(60);
    expect(long.unsubscribe_url).toBe("https://example.invalid/preview");
    expect(sampleScenarioValues(keys, defaults, "conditional_on")).toEqual(defaults);
  });
});
