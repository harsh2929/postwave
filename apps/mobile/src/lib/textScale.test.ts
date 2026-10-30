import { describe, expect, it } from "vitest";

import { MAX_TEXT_SCALE } from "./textScale";

describe("MAX_TEXT_SCALE", () => {
  it("caps dense text without pinning it at the default size", () => {
    // Above 1 or the ceiling would do nothing; at or above the largest OS step it
    // would stop being a ceiling at all. 1.6 is the app-wide number every dense
    // surface shares.
    expect(MAX_TEXT_SCALE).toBeGreaterThan(1);
    expect(MAX_TEXT_SCALE).toBe(1.6);
  });

  it("is the module's only export, so no dead rule can be mistaken for practice", () => {
    // GATE#6: this file used to export METADATA_STACK_FONT_SCALE and
    // shouldStackMetadata as "the shared threshold" for stacking a metadata row.
    // Nothing ever called them — the only mention was a comment elsewhere citing
    // their fail-safe as precedent. A stated rule with no enforcement and no
    // caller reads as settled practice, which is worse than no rule.
    return import("./textScale").then((module) => {
      expect(Object.keys(module).sort()).toEqual(["MAX_TEXT_SCALE"]);
    });
  });
});
