// SPDX-License-Identifier: AGPL-3.0-only
//
// Drift guard: the ops console's palette MUST ride @postwave/design-tokens.
//
// The 2026-07-18 Apple-level integration audit's #1 critical seam was that
// ops was a total substrate island — a hand-rolled navy/sky-slate theme with
// zero token adoption, "the single most visible 'this surface is bolted on'
// break". globals.css now pins every canonical var to the package's DARK
// palette (warm ink + ember + canonical status hues) via OPS_VAR_MAP. This
// test re-derives the expected declarations from the package with its own
// `toCssVars` and asserts the :root block carries them byte-for-byte, so a
// hand-edit that re-islands the console fails CI here (the package's own
// drift.test.ts holds the anchor hexes as a second tripwire).

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { fonts, OPS_VAR_MAP, toCssVars } from "@postwave/design-tokens";

const GLOBALS = path.resolve(__dirname, "../app/globals.css");

/** Extract the inner declarations of the `:root { … }` block. */
function rootBlock(css: string): string {
  const m = css.match(/:root\s*\{([^}]*)\}/);
  if (!m) throw new Error(":root block not found in ops globals.css");
  return m[1];
}

/** Parse `--name: value;` declarations into a map (comments stripped). */
function declMap(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const noComments = block.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const decl of noComments.split(";")) {
    const m = decl.match(/(--[\w-]+)\s*:\s*([\s\S]+)/);
    if (!m) continue;
    out[m[1].trim()] = m[2].trim();
  }
  return out;
}

describe("ops console ↔ @postwave/design-tokens drift guard", () => {
  const css = readFileSync(GLOBALS, "utf8");
  const decls = declMap(rootBlock(css));

  it("every OPS_VAR_MAP var equals the canonical dark token, byte-for-byte", () => {
    const expected = toCssVars("dark", OPS_VAR_MAP, "hex");
    for (const line of expected.split("\n")) {
      const m = line.match(/(--[\w-]+)\s*:\s*([^;]+);/);
      if (!m) continue;
      const [, varName, value] = m;
      expect(decls[varName], `${varName} missing from :root`).toBeDefined();
      expect(decls[varName], `${varName} drifted from canonical`).toBe(value.trim());
    }
  });

  it("brand type stacks lead with the canonical faces (Inter body, Fraunces display)", () => {
    expect(decls["--font"]).toMatch(new RegExp(`^"${fonts.sans}"`));
    expect(decls["--font-display"]).toMatch(new RegExp(`^"${fonts.display}"`));
  });

  it("the navy/sky island cannot silently return", () => {
    const lower = css.toLowerCase();
    expect(lower).not.toContain("#38bdf8"); // old sky accent
    expect(lower).not.toContain("#020617"); // old navy canvas
    expect(lower).not.toContain("#0b1120"); // old navy surface
  });
});
