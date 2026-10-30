// SPDX-License-Identifier: AGPL-3.0-only
//
// A <th> without scope leaves the header/data relationship to be guessed. For
// a single header row browsers infer it; for a row header — the first cell of
// each row, naming what the rest of the row is about — nothing infers it, and
// a screen reader reads a line of values with no subject.
//
// This started as a ratchet over 167 unscoped headers in 33 files. They are
// all closed now, so it is a flat assertion instead.
//
// The bulk was mechanical and safe: a <th> inside <thead> is a column header by
// definition, so scope="col" needs no judgement. The eight that remained were
// SortableTh-style helper components — <th> renderers defined outside any
// <thead> but rendered into one — which is why a lexical codemod could not see
// them and they had to be read.
//
// Row headers are the part a codemod must not guess, and they were added by
// hand only where the table has one: the source IP in the DMARC table, the
// resource in the migration parity table, the dimension in the comparison
// table, the parameter in the API reference. A metrics grid has none, and
// inventing one is worse than omitting it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

/** repo-relative file → count of <th> elements with no scope attribute. */
function unscopedHeaders(): Map<string, number> {
  const found = new Map<string, number>();
  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    const n = [...text.matchAll(/<th\b([^>]*)>/g)].filter(
      (m) => !/scope=/.test(m[1]!),
    ).length;
    if (n > 0) found.set(file.slice(SRC.length + 1), n);
  }
  return found;
}

/** Every <th> the app renders, so the sweep can prove it looked at some. */
function totalHeaders(): number {
  let n = 0;
  for (const file of walk(SRC)) {
    n += [...readFileSync(file, "utf8").matchAll(/<th\b/g)].length;
  }
  return n;
}

describe("table headers declare their scope", () => {
  it("finds headers to check", () => {
    // Guard the guard: with no <th> anywhere, "none are unscoped" is true and
    // meaningless. This started at 167 unscoped across 33 files.
    expect(totalHeaders()).toBeGreaterThan(150);
  });

  it("scopes every one", () => {
    const offenders = [...unscopedHeaders().entries()]
      .map(([file, count]) => `${file}: ${count}`)
      .sort();
    expect(offenders).toEqual([]);
  });
});
