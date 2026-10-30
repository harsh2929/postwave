//
// CI DRIFT GUARD — asserts every client's theme still tracks the canonical
// brand tokens, so the cross-platform brand can't silently re-diverge (the
// failure the 2026-06-21 ecosystem audit found). Mirrors the openapi/sdk
// parity guards, but for design.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BRAND_ANCHORS, motion, PORTAL_VAR_MAP, toCssVars, tokens } from "./index";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");
const has = (hay: string, needle: string) =>
  hay.toLowerCase().includes(needle.toLowerCase());

describe("design-token drift guard", () => {
  it("mobile sources its palette from @postwave/design-tokens (no hand-rolled hex)", () => {
    const theme = read("apps/mobile/src/lib/theme.ts");
    expect(theme).toContain("@postwave/design-tokens");
    // The old drift vector was a hand-maintained `const dark/light` hex
    // object. Assert those literal palettes are gone.
    expect(theme).not.toMatch(/accent:\s*["']#[0-9a-fA-F]{6}["']/);
  });

  it("web globals.css still carries the brand ember + paper anchors", () => {
    const css = read("apps/web/src/app/globals.css");
    expect(has(css, BRAND_ANCHORS.emberLight)).toBe(true); // #C8102E
    expect(has(css, BRAND_ANCHORS.emberDark)).toBe(true); // #E55262
    expect(has(css, BRAND_ANCHORS.paper)).toBe(true); // #FDFCF8
    expect(has(css, BRAND_ANCHORS.gold)).toBe(true); // #F2B233
  });

  it("desktop stylesheet layer uses the brand ember accent + warm canvas (dark ink + light paper + warm border)", () => {
    // styles.css was refactored into an @import aggregator; the theme values
    // now live in the files it imports under src/styles/ (foundation.css et
    // al). Concatenate the aggregator plus every imported sheet so the guard
    // tracks the anchors wherever the layer splits them, instead of silently
    // going stale on a file move (which is exactly what un-RED'd this test
    // in the 2026-07-18 validation).
    const dir = resolve(REPO, "apps/desktop/src/styles");
    const css = [
      read("apps/desktop/src/styles.css"),
      ...readdirSync(dir)
        .filter((f) => f.endsWith(".css"))
        .map((f) => readFileSync(resolve(dir, f), "utf8")),
    ].join("\n");
    expect(has(css, BRAND_ANCHORS.emberDark)).toBe(true); // #E55262 (dark)
    expect(has(css, BRAND_ANCHORS.emberLight)).toBe(true); // #C8102E (light)
    // Reconciled: desktop's dark canvas is now warm ink (was cool blue-slate
    // #0c0e14), and its light canvas is warm paper (was cool #fafbfc).
    expect(has(css, BRAND_ANCHORS.ink)).toBe(true); // #0F0F0F dark canvas
    expect(has(css, BRAND_ANCHORS.paper)).toBe(true); // #FDFCF8 light canvas
    expect(has(css, BRAND_ANCHORS.warmBorder)).toBe(true); // #E0DDD3
  });

  it("ops console globals.css rides the canonical dark palette (ink canvas, ember accent, canonical status hues)", () => {
    // The 2026-07-18 integration audit's #1 critical seam: ops was a
    // navy/sky-slate island with zero token adoption. It is now pinned to
    // the canonical DARK palette via OPS_VAR_MAP; the exhaustive per-var
    // equality check lives in apps/ops/src/lib/designTokens.test.ts — this
    // anchor check makes the package's own suite fail if ops re-islands.
    const css = read("apps/ops/src/app/globals.css");
    expect(has(css, BRAND_ANCHORS.ink)).toBe(true); // #0F0F0F canvas
    expect(has(css, BRAND_ANCHORS.emberDark)).toBe(true); // #E55262 accent
    expect(has(css, tokens.dark.danger)).toBe(true); // canonical fail-loud red
    expect(has(css, tokens.dark.success)).toBe(true); // canonical green
    // The old island must be gone.
    expect(has(css, "#38bdf8")).toBe(false); // sky accent
    expect(has(css, "#020617")).toBe(false); // navy canvas
  });

  it("audit-portal index.html rides the canonical palette via PORTAL_VAR_MAP (light + dark, every var)", () => {
    // The last true design island (2026-07-18 audit): the portal used generic
    // Tailwind gray/blue-700. It now derives every --portal-* var from
    // PORTAL_VAR_MAP; this re-emits toCssVars for both modes and asserts each
    // declaration appears byte-for-byte, so the static embed can't re-island.
    const html = read("apps/audit-portal/index.html");
    for (const mode of ["light", "dark"] as const) {
      for (const line of toCssVars(mode, PORTAL_VAR_MAP, "hex", "").split("\n")) {
        expect(has(html, line.trim()), `${mode}: ${line.trim()}`).toBe(true);
      }
    }
    // Canonical anchors present …
    expect(has(html, BRAND_ANCHORS.emberLight)).toBe(true); // #C8102E
    expect(has(html, BRAND_ANCHORS.emberDark)).toBe(true); // #E55262
    expect(has(html, BRAND_ANCHORS.paper)).toBe(true); // #FDFCF8 page bg
    // … and the old generic-gray/blue island gone.
    expect(has(html, "#1d4ed8")).toBe(false); // blue-700 primary
    expect(has(html, "#6b7280")).toBe(false); // gray-500 muted
    expect(has(html, "#f9fafb")).toBe(false); // gray-50 surface-2
  });
});

// ---------------------------------------------------------------------------
// MOTION drift. Everything above guards COLOUR; nothing guarded the motion
// tokens, and desktop had quietly kept its own.
//
// web and mobile IMPORT `motion`, so their values cannot drift — the type
// system carries them. Desktop does not: its tour is plain CSS with no token
// injection, so the numbers live as literals in collaboration-tour.css and
// this is the only thing holding them to the canonical set.
//
// It had already drifted. The scrim was 78% / blur(3px) against a canonical
// 0.76 / 2 — the top of the very "0.72–0.78 across clients" spread motion.ts
// says it reconciled. Durations and confetti count happened to agree, but by
// hand-tuning rather than by sharing a source, which is the state that drifts
// again.
describe("motion-token drift guard", () => {
  const tourCss = read("apps/desktop/src/styles/collaboration-tour.css");

  it("desktop's tour scrim carries the canonical backdrop values", () => {
    const opacityPct = Math.round(motion.backdrop.opacity * 100);
    expect(
      has(tourCss, `var(--pw-shadow-color) ${opacityPct}%`),
      `desktop scrim must use ${opacityPct}% (motion.backdrop.opacity)`,
    ).toBe(true);
    expect(
      has(tourCss, `blur(${motion.backdrop.blur}px)`),
      `desktop scrim must blur ${motion.backdrop.blur}px (motion.backdrop.blur)`,
    ).toBe(true);
  });

  it("desktop's tour durations match the canonical ones", () => {
    // These agreed already; pinning them is what stops the next edit from
    // reintroducing the split.
    expect(has(tourCss, `${motion.durations.spotlightTravelMs}ms`)).toBe(true);
    expect(has(tourCss, `${motion.durations.tooltipEnterMs}ms`)).toBe(true);
    // The CSS writes these two in seconds, not milliseconds.
    expect(has(tourCss, `${motion.durations.pulseMs / 1000}s`)).toBe(true);
    expect(has(tourCss, `${motion.confetti.flightMs / 1000}s`)).toBe(true);
  });

  it("web drives its motion from the tokens rather than literals", () => {
    // The other half of the guarantee: if web ever stops importing the module,
    // desktop's literals become the only definition and this whole file is
    // guarding a copy against a copy.
    const overlay = read("apps/web/src/components/tour/TourOverlay.tsx");
    expect(has(overlay, 'from "@postwave/design-tokens"')).toBe(true);
    expect(has(overlay, "motion.backdrop.frosted.opacity")).toBe(true);
    expect(has(overlay, "motion.backdrop.frosted.blur")).toBe(true);
  });

  it("desktop's confetti count matches the canonical one", () => {
    const tooltip = read("apps/desktop/src/components/tour/TourTooltip.tsx");
    expect(has(tooltip, `${motion.confetti.count} small CSS-animated particles`)).toBe(
      true,
    );
  });
});
