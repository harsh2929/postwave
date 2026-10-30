// SPDX-License-Identifier: AGPL-3.0-only
//
// The /voice marketing page states how many sequence templates and categories
// ship. Those numbers were hardcoded and had drifted: the page said "50 launch
// templates across 10 categories" while the catalog carries 50 templates in 13
// categories (`community`, `sales` and `misc` were added and never reflected).
//
// The page even enumerates ten by name, so the miscount is visible to any
// reader who counts — on the page whose whole job is describing the feature.
//
// The marketing site cannot import from services/voice (separate service, no
// build-time dependency), so the numbers stay literals and this asserts them
// against the real catalog instead.
//
// The changelog is deliberately NOT checked: its entries are historical records
// of what a release shipped, so their numbers must stay frozen.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = new URL("../../../../", import.meta.url).pathname;
const CATALOG = join(REPO, "services/voice/internal/templates/embedded");
const VOICE_PAGE = join(
  REPO,
  "apps/web/src/app/(marketing)/voice/page.tsx",
);
// The home page repeats the template count ("50 proven sequence templates").
// It was correct, but nothing tied it to the catalog, so it could drift the
// same way /voice's category count did.
const HOME_PAGE = join(REPO, "apps/web/src/app/(marketing)/page.tsx");

function catalogStats() {
  const files = readdirSync(CATALOG).filter((f) => f.endsWith(".json"));
  const categories = new Set<string>();
  for (const f of files) {
    const parsed = JSON.parse(readFileSync(join(CATALOG, f), "utf8")) as {
      category?: string;
    };
    if (parsed.category) categories.add(parsed.category);
  }
  return { templates: files.length, categories: categories.size };
}

describe("/voice template claims match the shipped catalog", () => {
  const stats = catalogStats();
  const page = readFileSync(VOICE_PAGE, "utf8");

  it("reads a non-empty catalog", () => {
    // Guard the guard: a moved or empty catalog must fail loudly rather than
    // let the assertions below pass against zeros.
    expect(stats.templates).toBeGreaterThan(0);
    expect(stats.categories).toBeGreaterThan(0);
  });

  it("states the real template count everywhere it claims one", () => {
    const claims = [...page.matchAll(/(\d+) launch templates/g)].map((m) =>
      Number(m[1]),
    );
    expect(claims.length).toBeGreaterThan(0);
    for (const claimed of claims) expect(claimed).toBe(stats.templates);
  });

  it("states the real category count everywhere it claims one", () => {
    const claims = [...page.matchAll(/across (\d+) categories/g)].map((m) =>
      Number(m[1]),
    );
    expect(claims.length).toBeGreaterThan(0);
    for (const claimed of claims) expect(claimed).toBe(stats.categories);
  });

  it("never enumerates a partial category list", () => {
    // Counting alone was not enough. /voice said "across 13 categories" in two
    // places and, three lines apart, listed ten of them in a bullet that
    // begins "spanning …" — no number for a count-based check to catch. Any
    // enumeration that names the first category has to name all of them.
    const CATEGORY_WORDS: Record<string, RegExp> = {
      community: /community/i,
      sales: /\bsales\b/i,
      misc: /general-purpose/i,
    };
    const offenders: string[] = [];
    for (const rel of [
      "apps/web/src/app/(marketing)/voice/page.tsx",
      "apps/web/src/app/(marketing)/features/page.tsx",
    ]) {
      const text = readFileSync(join(REPO, rel), "utf8");
      // Sentences that enumerate categories start from "welcome series".
      for (const m of text.matchAll(/"[^"]*welcome series[^"]*"/g)) {
        const sentence = m[0];
        if (!/cold-warm/i.test(sentence)) continue; // not the full enumeration
        for (const [name, re] of Object.entries(CATEGORY_WORDS)) {
          if (!re.test(sentence)) {
            offenders.push(`${rel.split("/").slice(-2)[0]}: omits "${name}"`);
          }
        }
      }
    }
    expect([...new Set(offenders)].sort()).toEqual([]);
  });

  it("states the real category count on the features page too", () => {
    // /features enumerated ten categories by name and omitted community,
    // sales and general-purpose — the identical miscount /voice carried, on
    // the page that exists to describe the feature in full.
    const features = readFileSync(
      join(REPO, "apps/web/src/app/(marketing)/features/page.tsx"),
      "utf8",
    );
    const claims = [...features.matchAll(/across (\d+) categories/g)].map((m) =>
      Number(m[1]),
    );
    expect(claims.length).toBeGreaterThan(0);
    for (const claimed of claims) expect(claimed).toBe(stats.categories);
  });

  it("states the real template count on the home page too", () => {
    const home = readFileSync(HOME_PAGE, "utf8");
    const claims = [...home.matchAll(/(\d+) proven sequence templates/g)].map(
      (m) => Number(m[1]),
    );
    expect(claims.length).toBeGreaterThan(0);
    for (const claimed of claims) expect(claimed).toBe(stats.templates);
  });
});
