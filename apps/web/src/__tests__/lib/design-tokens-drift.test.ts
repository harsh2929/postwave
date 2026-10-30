// SPDX-License-Identifier: AGPL-3.0-only
//
// Drift guard for the web theme's brand-critical CSS custom properties.
//
// apps/web/src/app/globals.css hand-writes HSL triplets for the shadcn
// semantic vars. Those values MUST equal the canonical hex tokens from
// @postwave/design-tokens (converted to space-separated HSL triplets via
// the package's own `toCssVars`). Before this guard, web had drifted
// (e.g. --background was `40 33% 98%` instead of the true `48 56% 98%`
// for #FDFCF8). This test re-derives the expected triplets from the
// package and asserts the :root (light) and .dark blocks carry them, so a
// future brand change in the package — or a hand-edit that re-introduces
// drift — fails CI here.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { toCssVars, WEB_VAR_MAP } from "@postwave/design-tokens";

const GLOBALS = path.resolve(__dirname, "../../app/globals.css");

/** Extract the inner declarations of a single CSS selector block. */
function blockFor(css: string, selector: string): string {
  // Match `selector {` ... first `}` at the same nesting (the token
  // blocks contain no nested braces).
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  const m = css.match(re);
  if (!m) throw new Error(`selector ${selector} not found in globals.css`);
  return m[1];
}

/** Parse `--name: value;` declarations into a map (value trimmed, comments stripped). */
function declMap(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^\s*(--[\w-]+)\s*:\s*([^;]+);/);
    if (!m) continue;
    out[m[1].trim()] = m[2].trim();
  }
  return out;
}

/** The canonical `name -> triplet` pairs the package emits for a mode. */
function canonicalVars(mode: "light" | "dark"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of toCssVars(mode, WEB_VAR_MAP, "hsl-triplet").split("\n")) {
    const m = line.match(/(--[\w-]+):\s*(.+);/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

describe("design-tokens drift guard (web globals.css)", () => {
  const css = readFileSync(GLOBALS, "utf8");

  it(":root (light) mapped vars match @postwave/design-tokens", () => {
    const actual = declMap(blockFor(css, ":root"));
    const expected = canonicalVars("light");
    for (const [name, triplet] of Object.entries(expected)) {
      expect(actual[name], `${name} (light)`).toBe(triplet);
    }
  });

  it(".dark mapped vars match @postwave/design-tokens", () => {
    const actual = declMap(blockFor(css, ".dark"));
    const expected = canonicalVars("dark");
    for (const [name, triplet] of Object.entries(expected)) {
      expect(actual[name], `${name} (dark)`).toBe(triplet);
    }
  });

  it("corrects the documented --background drift (#FDFCF8 = 48 56% 98%)", () => {
    const light = canonicalVars("light");
    expect(light["--background"]).toBe("48 56% 98%");
  });
});
