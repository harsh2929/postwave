// SPDX-License-Identifier: AGPL-3.0-only
//
// A useQuery whose data is rendered but whose isError is never read turns a
// failed request into a legitimate-looking empty result.
//
// assets/page.tsx shipped this: `${(folders.data ?? []).length} folder(s)`.
// When the folders request 500s, `.data` is undefined, `?? []` makes it an
// empty array, and the page prints "0 folder(s)" — byte-identical to a
// workspace that genuinely has none. The operator has no way to tell, and no
// reason to retry. Sixteen bindings across eight pages did this.
//
// The rule: if a query's `.data` reaches the render, its `.isError` must be
// consulted somewhere in the same file.
//
// Identity queries are exempt. `meQuery`/`me` exist to derive a tenant-scoped
// query key, not to be displayed; requiring an error branch for them would be
// noise, and noise is how a ratchet gets an exception list instead of a fix.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const APP = resolve(process.cwd(), "src/app/(dashboard)/app");

const IDENTITY_QUERIES = new Set(["meQuery", "me"]);

/** Temporary page exclusions. Kept as a ratcheted map so any future carve-out
 * has to name its reason and automatically fails once the defect is fixed. */
const EXCLUDED: Record<string, string> = {};

function pages(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) pages(p, out);
    else if (entry === "page.tsx") out.push(p);
  }
  return out;
}

function unguardedQueries(text: string): string[] {
  const declared = [...text.matchAll(/const\s+(\w+)\s*=\s*useQuery\(/g)].map(
    (m) => m[1],
  );
  return declared.filter((q) => {
    if (IDENTITY_QUERIES.has(q)) return false;
    const rendersData = new RegExp(`\\b${q}\\.data\\b`).test(text);
    const readsError = new RegExp(`\\b${q}\\.isError\\b`).test(text);
    return rendersData && !readsError;
  });
}

const PAGES = pages(APP);

describe("a rendered query reports its own failure", () => {
  it("scans a non-trivial corpus", () => {
    // Vacuity floor: a broken walk would make the rule below pass for free.
    expect(PAGES.length).toBeGreaterThan(100);
    const withQueries = PAGES.filter((p) =>
      /useQuery\(/.test(readFileSync(p, "utf8")),
    );
    expect(withQueries.length).toBeGreaterThan(80);
  });

  it("still recognises identity queries as exempt", () => {
    // Guard the guard: if the exemption stopped matching, every page would
    // "pass" only because meQuery drowned the signal — or fail en masse.
    const sample = PAGES.map((p) => readFileSync(p, "utf8")).find((t) =>
      /const\s+meQuery\s*=\s*useQuery\(/.test(t),
    );
    expect(sample).toBeDefined();
    expect(unguardedQueries(sample as string)).not.toContain("meQuery");
  });

  it("renders an error branch for every displayed query", () => {
    const offenders: string[] = [];
    for (const file of PAGES) {
      const rel = relative(APP, file);
      if (EXCLUDED[rel] !== undefined) continue;
      for (const q of unguardedQueries(readFileSync(file, "utf8"))) {
        offenders.push(`${rel}: ${q}`);
      }
    }
    expect(offenders.sort()).toEqual([]);
  });

  it("tests isError in every loading ternary that falls through to an empty state", () => {
    // The per-query rule above asks whether a query reads isError ANYWHERE in
    // the file. That is not enough, and assets/page.tsx proved it: `listing`
    // was guarded in one section and displayed in a second whose chain read
    //     listing.isLoading ? "Loading…" : items.length === 0 ? "No assets…"
    // so a failed request printed "No assets uploaded yet." The file passed
    // the per-query check the whole time.
    //
    // This looks at the SHAPE instead: a chain that branches on isLoading and
    // then falls through to an emptiness test must also branch on isError,
    // because those are three outcomes and it only distinguishes two.
    const offenders: string[] = [];
    for (const file of PAGES) {
      const rel = relative(APP, file);
      if (EXCLUDED[rel] !== undefined) continue;
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(
        /(\w+)\.isLoading\s*\n?\s*\?[\s\S]{0,400}?\.length === 0/g,
      )) {
        const chain = m[0];
        const query = m[1];
        if (chain.includes(`${query}.isError`)) continue;
        // A combined guard (a.isError || b.isError) counts too.
        if (/\.isError/.test(chain)) continue;
        const line = text.slice(0, m.index).split("\n").length;
        offenders.push(
          `${rel}:${line}: ${query} distinguishes loading from empty, but not failed`,
        );
      }
    }
    expect(offenders.sort()).toEqual([]);
  });

  it("keeps every exclusion real", () => {
    // An exclusion for a page that no longer offends excuses nothing and hides
    // the next real one behind it. This is what stops the carve-out above from
    // outliving the refactor it was written for.
    const stale = Object.keys(EXCLUDED).filter((rel) => {
      const file = join(APP, rel);
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        return true;
      }
      return unguardedQueries(text).length === 0;
    });
    expect(stale).toEqual([]);
  });
});
