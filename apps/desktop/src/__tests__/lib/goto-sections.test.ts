import { describe, expect, it } from "vitest";

import { GOTO_SECTIONS } from "../../lib/store";

describe("GOTO_SECTIONS (G-then-key navigation)", () => {
  it("maps the nine top sections to mnemonic keys", () => {
    expect(GOTO_SECTIONS).toEqual({
      d: "dashboard",
      s: "subscribers",
      c: "campaigns",
      q: "sequences",
      u: "automations",
      e: "segments",
      a: "analytics",
      f: "forms",
      t: "templates",
    });
  });

  it("uses single lowercase-letter keys", () => {
    for (const k of Object.keys(GOTO_SECTIONS)) {
      expect(k).toMatch(/^[a-z]$/);
    }
  });

  it("has no duplicate destinations", () => {
    const dests = Object.values(GOTO_SECTIONS);
    expect(new Set(dests).size).toBe(dests.length);
  });

  it("does not bind 'g' itself (that is the prefix key)", () => {
    expect(GOTO_SECTIONS).not.toHaveProperty("g");
  });
});
