// SPDX-License-Identifier: AGPL-3.0-only
//
// The ops board's whole claim is that freshness is derived at READ time. Every
// number on it is a platform-operator decision input — automations not firing,
// sends stalled, incidents open — and a board that renders green because it is
// cached is worse than a board that fails to load.
//
// Two things hold that claim up, and both are held by repetition rather than
// by any shared helper:
//
//   1. Every page declares `export const dynamic = "force-dynamic"`. Without
//      it Next will statically render the route, which freezes the
//      `new Date()` used to compute the age. The board would then be
//      permanently "0s ago" — the exact lie page.tsx's own comment says it
//      exists to avoid.
//
//   2. Every server-side fetch passes `cache: "no-store"`. A cached response
//      defeats the same guarantee one layer down: the page would re-render
//      dynamically and re-derive the age from a `generated_at` that never
//      moves.
//
// A new lane added without either line looks exactly like the others and is
// silently, permanently fresh.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");

function walk(dir: string, match: (p: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p, match));
    else if (match(p)) out.push(p);
  }
  return out;
}

describe("ops board freshness is derived at read time", () => {
  const pages = walk(join(SRC, "app"), (p) => p.endsWith("page.tsx"));

  it("finds the routes", () => {
    // Guard the guard: zero pages would make every assertion below vacuous,
    // and a silently-empty freshness check is the failure this file is about.
    expect(pages.length).toBeGreaterThan(5);
  });

  it("renders every page dynamically", () => {
    const staticPages = pages
      .filter(
        (p) =>
          !/export const dynamic\s*=\s*"force-dynamic"/.test(
            readFileSync(p, "utf8"),
          ),
      )
      .map((p) => p.slice(SRC.length + 1));
    expect(staticPages.sort()).toEqual([]);
  });

  it("never caches a server-side fetch", () => {
    // Any fetch in lib/ runs on the server for these pages. One without
    // no-store re-serves an old `generated_at` under a fresh-looking render.
    const cached: string[] = [];
    for (const file of walk(SRC, (p) => /\.tsx?$/.test(p))) {
      const text = readFileSync(file, "utf8");
      if (!/\bfetch\(/.test(text)) continue;
      if (!/["']use client["']/.test(text) && !/cache:\s*["']no-store["']/.test(text)) {
        cached.push(file.slice(SRC.length + 1));
      }
    }
    expect(cached.sort()).toEqual([]);
  });

  it("fails loud on clock skew instead of clamping to zero", () => {
    // A board timestamp in the future means the API and this console disagree
    // about the clock. Clamping the age to 0 would render as freshly green —
    // the specific lie the invariant exists to prevent — so skew must reach
    // the `stale` decision, not just the displayed age.
    const board = readFileSync(join(SRC, "app/page.tsx"), "utf8");
    expect(board).toMatch(/const skewed = rawAgeSeconds < -CLOCK_SKEW_TOLERANCE_SECONDS/);
    expect(board).toMatch(/const stale = skewed \|\|/);
    // The clamp must come after skew is captured, never instead of it.
    expect(board.indexOf("const skewed")).toBeLessThan(
      board.indexOf("Math.max(0, rawAgeSeconds)"),
    );
  });

  it("computes age against a read-time now, not a build-time constant", () => {
    const board = readFileSync(join(SRC, "app/page.tsx"), "utf8");
    expect(board).toMatch(/const nowIso = new Date\(\)\.toISOString\(\)/);
    // …and that value, not a literal, is what the age subtracts from.
    expect(board).toMatch(/Date\.parse\(nowIso\) - Date\.parse\(board\.generated_at\)/);
  });
});
