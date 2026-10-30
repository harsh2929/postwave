// SPDX-License-Identifier: AGPL-3.0-only
//
// /commerce publishes the recommendation ranker's scoring weights, twice —
// once as a bullet and once in the FAQ. It advertised "+0.5 for products
// updated in the last 7 days", but that weight is not applied anywhere:
// recommendations.go explains that updated_at is absent from the candidate
// struct, appends the reason string "recent in catalog", and adds nothing to
// the score. The package's own doc comment still claims +0.5 too, which is
// where the marketing copy came from.
//
// Only weights the ranker really adds may appear as "+N" in the copy.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");
const PAGE = readFileSync(
  join(SRC, "app/(marketing)/commerce/page.tsx"),
  "utf8",
);
const RANKER = readFileSync(
  join(REPO, "apps/api/internal/commerce/recommendations.go"),
  "utf8",
);

/** Weights the ranker actually adds, i.e. `score += <n>` in the body. */
function appliedWeights(): number[] {
  return [...RANKER.matchAll(/^\s*score \+= ([\d.]+)/gm)].map((m) =>
    Number(m[1]),
  );
}

/** Weights the marketing copy advertises as "+N". */
function advertisedWeights(): number[] {
  return [...PAGE.matchAll(/\+(\d\.\d)\s/g)].map((m) => Number(m[1]));
}

describe("commerce recommendation weights", () => {
  it("reads the ranker and the page", () => {
    // Guard the guard: a renamed file or restructured scoring loop must fail
    // loudly rather than compare two empty lists.
    expect(appliedWeights().length).toBeGreaterThan(1);
    expect(advertisedWeights().length).toBeGreaterThan(1);
  });

  it("only advertises weights the ranker applies", () => {
    const applied = new Set(appliedWeights());
    const bogus = advertisedWeights().filter((w) => !applied.has(w));
    expect(bogus).toEqual([]);
  });

  it("does not claim a freshness score the ranker never adds", () => {
    // The reason label "recent in catalog" is real; a numeric freshness weight
    // is not. If the ranker later scores freshness, this is what says so.
    const scoresFreshness = /score \+= [\d.]+[^\n]*\n[^\n]*fresh/i.test(RANKER);
    const claimsFreshness = /\+\d\.\d for products updated/i.test(PAGE);
    expect(claimsFreshness).toBe(scoresFreshness);
  });
});
