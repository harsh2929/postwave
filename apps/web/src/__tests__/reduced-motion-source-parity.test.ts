// SPDX-License-Identifier: AGPL-3.0-only
//
// Reduce Motion: one rule, and one source per surface.
//
// The ecosystem blueprint's dim-3 finding was "no shared focus-trap/aria/
// reduced-motion abstraction". The reduced-motion half is now split the only way
// it can be: HOW a surface learns the preference is platform-bound (matchMedia
// on the desk, reanimated's hook on the phone, a CSS media query on the web),
// so each surface keeps exactly one such source; WHAT it does with the answer
// is platform-free, so that lives once, in @postwave/design-tokens'
// `reducedMotion()`.
//
// Writing this found that desktop was not one source either: three components
// re-declared the media query inline to pick a scroll behaviour. Two are
// migrated to `prefersReducedMotionNow()`; the third is named below.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(process.cwd(), "../..");

/** Comments are stripped before matching: the fixes for these duplications
 *  describe the old pattern in prose, and a guard that flags the explanation
 *  of a removal reports the opposite of the truth. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "__tests__") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

function rel(p: string): string {
  return p.replace(REPO + "/", "");
}

function filesCalling(root: string, needle: RegExp): string[] {
  return walk(resolve(REPO, root))
    .filter((p) => needle.test(stripComments(readFileSync(p, "utf8"))))
    .map(rel)
    .sort();
}

/** A read that RE-DECLARES the media query as a string literal -- the shape
 *  that bypasses the hook. The hook itself reads via its exported constant, so
 *  it does not match this and is asserted separately. */
const DESKTOP_DIRECT_READ = /matchMedia\(\s*["'`]\(prefers-reduced-motion/;
const DESKTOP_SOURCE = "apps/desktop/src/hooks/usePrefersReducedMotion.ts";

/**
 * Desktop files that still read the media query themselves, with the reason
 * each cannot be migrated yet. An entry that stops reading it directly fails
 * the stale check below, so an allowance cannot outlive its gap.
 */
const DESKTOP_BLOCKED: Readonly<Record<string, string>> = {
  "apps/desktop/src/pages/SMSInbox.tsx":
    "carries uncommitted changes from the in-flight SMS work; editing it underneath that is not an option",
};

const MOBILE_DIRECT_READ = /isReduceMotionEnabled\(|"reduceMotionChanged"/;

describe("reduced-motion: one rule, one source per surface", () => {
  it("the rule is exported once, from design-tokens", () => {
    const src = readFileSync(resolve(REPO, "packages/design-tokens/src/motion.ts"), "utf8");
    expect(src).toMatch(/export function reducedMotion\(/);
    const barrel = readFileSync(resolve(REPO, "packages/design-tokens/src/index.ts"), "utf8");
    expect(barrel).toMatch(/\breducedMotion\b/);
  });

  it("desktop declares the media query once, in its source file", () => {
    const src = stripComments(readFileSync(resolve(REPO, DESKTOP_SOURCE), "utf8"));
    expect(src).toMatch(/REDUCED_MOTION_QUERY = "\(prefers-reduced-motion: reduce\)"/);
    expect(src).toMatch(/matchMedia\(QUERY\)/);
    expect(src).toMatch(/export function prefersReducedMotionNow\(/);
  });

  it("no other desktop file re-declares the media query (except the named, blocked one)", () => {
    const readers = filesCalling("apps/desktop/src", DESKTOP_DIRECT_READ);
    expect(readers).toEqual(Object.keys(DESKTOP_BLOCKED).sort());
  });

  it("desktop's blocked exception is still blocked, not forgotten", () => {
    for (const p of Object.keys(DESKTOP_BLOCKED)) {
      expect(DESKTOP_DIRECT_READ.test(stripComments(readFileSync(resolve(REPO, p), "utf8")))).toBe(true);
    }
  });

  it("the migrated desktop components use the shared one-shot reader", () => {
    for (const p of [
      "apps/desktop/src/components/commerce/CatalogsTab.tsx",
      "apps/desktop/src/components/commerce/IntegrationBrowsePanel.tsx",
    ]) {
      expect(readFileSync(resolve(REPO, p), "utf8")).toMatch(/prefersReducedMotionNow\(\)/);
    }
  });

  it("mobile never reads AccessibilityInfo for it — reanimated's hook is the source", () => {
    const direct = [
      ...filesCalling("apps/mobile/src", MOBILE_DIRECT_READ),
      ...filesCalling("apps/mobile/app", MOBILE_DIRECT_READ),
    ];
    expect(direct).toEqual([]);
    expect(filesCalling("apps/mobile/src", /useReducedMotion\(\)/).length).toBeGreaterThanOrEqual(4);
  });

  it("web honours it at the CSS layer", () => {
    const cssFiles: string[] = [];
    const scan = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (name === "node_modules") continue;
        if (statSync(p).isDirectory()) scan(p);
        else if (p.endsWith(".css") && /prefers-reduced-motion/.test(readFileSync(p, "utf8"))) cssFiles.push(p);
      }
    };
    scan(resolve(REPO, "apps/web/src"));
    expect(cssFiles.length).toBeGreaterThanOrEqual(1);
  });
});
