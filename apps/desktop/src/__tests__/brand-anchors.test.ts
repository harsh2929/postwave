// Brand-anchor drift guard (frontier G-59).
//
// The desktop theme (src/styles/foundation.css) used to duplicate the brand
// palette by hand with no mechanical link to @postwave/design-tokens — the
// package wasn't even a declared dependency — so the two UIs would "drift by
// construction": a change to the canonical ember/paper/ink would silently NOT
// reach desktop.
//
// This test closes that by consuming the package's BRAND_ANCHORS — the values
// its own author marks as "MUST be byte-identical across every consumer" — and
// asserting each appears in the desktop theme. It deliberately does NOT force
// the non-anchor status colors (success/warning/danger/info/subtle) to match
// canonical: those are intentionally tuned per-consumer for WCAG AA on
// desktop-specific surfaces (tinted badges, 11px sidebar text), and the
// foundation.css comments document the contrast math. Anchors are the contract;
// status colors are local craft. If someone hand-edits an anchor away from
// canonical, this fails.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { BRAND_ANCHORS } from "@postwave/design-tokens";
import { describe, expect, it } from "vitest";

// Strip /* … */ comments before matching so an anchor hex mentioned only in
// prose (e.g. "ember-500 (#C8102E)") can't satisfy the guard while the actual
// token value has drifted — the check must see the hex in a real declaration.
const foundationCss = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../styles/foundation.css"),
  "utf8",
)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .toLowerCase();

// gold (#F2B233) is a web/BIMI brand accent the desktop app does not use — its
// data-viz ramp uses amber #fbbf24 instead. Documented exclusion so the guard
// enforces exactly the anchors desktop commits to, and a newly-consumed gold
// would need to be added here consciously.
const DESKTOP_UNCONSUMED = new Set<keyof typeof BRAND_ANCHORS>(["gold"]);

describe("brand-anchor drift guard (G-59)", () => {
  for (const [name, hex] of Object.entries(BRAND_ANCHORS) as [keyof typeof BRAND_ANCHORS, string][]) {
    if (DESKTOP_UNCONSUMED.has(name)) {
      // Documented exclusion only — no assertion. Desktop is free to adopt the
      // canonical gold later; that must not trip the guard. The point of the
      // allowlist is that a MISSING gold is expected, not an error.
      it.skip(`${name} (${hex}) is intentionally not consumed by desktop`, () => {});
      continue;
    }
    it(`${name} anchor ${hex} is present in the desktop theme (not drifted)`, () => {
      expect(foundationCss).toContain(hex.toLowerCase());
    });
  }
});
