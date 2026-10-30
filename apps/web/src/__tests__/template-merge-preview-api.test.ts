// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { nestMergePreviewVars } from "@/lib/template-merge-preview-api";

describe("nestMergePreviewVars", () => {
  it("builds server-resolvable dotted paths", () => {
    expect(nestMergePreviewVars({ "subscriber.first_name": "Ada", "subscriber.tier": "pro", campaign: "Launch" }))
      .toEqual({ subscriber: { first_name: "Ada", tier: "pro" }, campaign: "Launch" });
  });
  it("refuses ambiguous and prototype keys", () => {
    expect(() => nestMergePreviewVars({ subscriber: "Ada", "subscriber.first_name": "A" })).toThrow(/conflicts/);
    expect(() => nestMergePreviewVars({ "__proto__.polluted": "yes" })).toThrow(/unsupported/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
