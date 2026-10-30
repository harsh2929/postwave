// SPDX-License-Identifier: AGPL-3.0-only
//
// WEBJS-003: `/` — the LCP-gated public homepage, first entry in
// performance-budgets.json's publicRoutes — statically imported eight
// `@/components/motion/*` wrappers, each of which imports `motion/react`. That
// put a 112.1 KiB raw / 37.0 KiB gz layout-projection animation engine in the
// route's initial chunk, on a route the bundle report had at 699.6 KiB against
// a 700 KiB budget: ~410 bytes of headroom, so any unrelated import broke CI.
//
// The replacements are CSS. What this pins is that they stay CSS — a single
// `motion/react` import anywhere in their graph puts the engine back — and
// that the page still renders the same content with the reveal classes on it.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import HomePage from "@/app/(marketing)/page";

const SRC = resolve(process.cwd(), "src");

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

/** Every first-party module reachable from `rel` by static import. */
function importGraph(rel: string, seen = new Set<string>()): Set<string> {
  if (seen.has(rel)) return seen;
  seen.add(rel);
  const text = read(rel);
  for (const m of text.matchAll(/from\s+"([^"]+)"/g)) {
    const spec = m[1]!;
    let target: string | null = null;
    if (spec.startsWith("@/")) target = spec.slice(2);
    else if (spec.startsWith(".")) target = join(dirname(rel), spec);
    if (!target) continue;
    const resolved = [".tsx", ".ts"]
      .map((ext) => `${target}${ext}`)
      .find((candidate) => {
        try {
          read(candidate);
          return true;
        } catch {
          return false;
        }
      });
    if (resolved) importGraph(resolved, seen);
  }
  return seen;
}

describe("marketing homepage motion cost", () => {
  it("does not reach the motion runtime from the homepage", () => {
    const graph = importGraph("app/(marketing)/page.tsx");
    // Guard the guard: the crawler has to be seeing a real graph, not one file.
    expect(graph.size).toBeGreaterThan(3);
    expect([...graph].filter((f) => f.startsWith("components/motion/"))).toEqual(
      [],
    );
    const offenders = [...graph].filter((f) =>
      /from\s+"motion\/react"/.test(read(f)),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps the replacements free of a client boundary", () => {
    // No hooks, so no "use client": these ship zero JavaScript, which is the
    // whole point. A stray directive would silently re-introduce a chunk.
    expect(read("components/marketing/reveal.tsx")).not.toContain("use client");
  });

  it("still renders the hero, the pillars and the CTAs", () => {
    const html = renderToStaticMarkup(<HomePage />);
    expect(html).toContain(
      "A newsletter platform being qualified with evidence.",
    );
    expect(html).toContain("Move with proof. Land in inbox. Sound like yourself.");
    // The reveal wrappers really wrapped something — vitest maps CSS-module
    // keys to their own names, so the class name is the key.
    expect(html).toContain("reveal");
    expect(html).toContain("stagger");
    expect(html).toContain('href="/migrations"');
  });

  it("leaves the resting state as the default in the stylesheet", () => {
    // Nothing may be hidden by a rule a browser might not apply: the animation
    // adds the entrance, it does not gate visibility.
    const css = readFileSync(
      join(SRC, "components/marketing/reveal.module.css"),
      "utf8",
    );
    // opacity:0 belongs in a keyframe's `from`, never in a class rule.
    const outsideKeyframes = css.replace(
      /@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\}\s*)*\}/g,
      "",
    );
    expect(outsideKeyframes).toContain(".reveal");
    expect(outsideKeyframes).not.toMatch(/opacity:\s*0\s*;/);
    expect(css).toContain("prefers-reduced-motion: reduce");
  });
});
