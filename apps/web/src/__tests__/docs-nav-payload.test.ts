// SPDX-License-Identifier: AGPL-3.0-only
//
// RSC-01 / CACHE-09: the docs layout used to hand the whole navigation tree to
// DocsNavProvider, a client component. Client-component props are serialized
// into the flight payload embedded in the HTML, so every one of the ~2,260
// /docs documents carried ~208 KB of JSON describing 1,955 operations and the
// generated skill catalogue — for a sidebar whose groups all render collapsed.
//
// What is pinned here is the boundary itself: the payload the layout inlines
// must stay group-level, the full tree must stay behind the cacheable
// /api/docs/nav route, and the two must not drift apart (a summary that lost a
// group, or reported a count the tree does not have, is a silently broken nav).
//
// The thresholds are absolute byte counts, not "whatever the code produces" —
// a regression that re-inlined the tree would blow straight through them.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { operationsByTag } from "@/lib/docs/loadOpenAPI";
import { skillsByCategory } from "@/lib/docs/loadSkills";
import { docsNavIndex, docsNavSummary } from "@/lib/docs/nav-index";

const SRC = resolve(process.cwd(), "src");

const bytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

describe("docs navigation payload", () => {
  it("has a tree large enough for inlining it to matter", () => {
    // Guard the guard: if the spec ever shrank to a handful of operations the
    // size assertions below would pass for the wrong reason.
    expect(operationsByTag().length).toBeGreaterThan(50);
    expect(bytes(docsNavIndex())).toBeGreaterThan(100_000);
  });

  it("inlines only group names and counts", () => {
    const summary = docsNavSummary();
    expect(summary.apiGroups.length).toBeGreaterThan(50);
    expect(summary.apiGroups.some((g) => g.items !== undefined)).toBe(false);
    expect(summary.skillGroups.some((g) => g.items !== undefined)).toBe(false);
    // ~7 KB in practice. 20 KB leaves room for new tags without letting an
    // item-level payload back in.
    expect(bytes(summary)).toBeLessThan(20_000);
  });

  it("reports the counts the real sources hold", () => {
    // Counts come from the spec and the skill catalogue, not from the summary
    // builder's own view of them.
    const apiCounts = Object.fromEntries(
      operationsByTag().map((g) => [g.tag, g.operations.length]),
    );
    expect(
      Object.fromEntries(
        docsNavSummary().apiGroups.map((g) => [g.tag, g.count]),
      ),
    ).toEqual(apiCounts);

    const skillCounts = Object.fromEntries(
      skillsByCategory().map((g) => [g.category, g.skills.length]),
    );
    expect(
      Object.fromEntries(
        docsNavSummary().skillGroups.map((g) => [g.category, g.count]),
      ),
    ).toEqual(skillCounts);
  });

  it("keeps every endpoint reachable through the served index", () => {
    const inIndex = new Set(
      docsNavIndex().apiGroups.flatMap((g) =>
        (g.items ?? []).map((i) => i.slug),
      ),
    );
    const expected = operationsByTag().flatMap((g) =>
      g.operations.map((o) => o.slug),
    );
    expect(expected.length).toBeGreaterThan(1_000);
    expect(expected.filter((slug) => !inIndex.has(slug))).toEqual([]);
  });

  it("keeps the layout off the item-level builders", () => {
    const layout = readFileSync(join(SRC, "app/(docs)/layout.tsx"), "utf8");
    expect(layout).toContain("docsNavSummary()");
    expect(layout).not.toContain("operationsByTag");
    expect(layout).not.toContain("skillsByCategory");
  });

  it("keeps the spec out of the client bundle", () => {
    // nav-index.ts statically imports openapi.json and the generated skill
    // catalogue. The provider is a client component, so a VALUE import from it
    // would risk bundling megabytes of JSON into the browser — the same cost,
    // relocated. Type imports are erased; nothing else may cross.
    const ctx = readFileSync(
      join(SRC, "components/docs/docs-nav-context.tsx"),
      "utf8",
    );
    expect(ctx).toContain("use client");
    expect(ctx).not.toMatch(/^import\s+\{[^}]*\}\s+from\s+"@\/lib\/docs\//m);
    expect(ctx).toContain(
      'import type { DocsNavData } from "@/lib/docs/nav-types"',
    );
    // And the types module itself imports nothing at all.
    const types = readFileSync(join(SRC, "lib/docs/nav-types.ts"), "utf8");
    expect(types).not.toMatch(/^import\s/m);
  });

  it("serves the full index from a cacheable route", () => {
    const route = readFileSync(join(SRC, "app/api/docs/nav/route.ts"), "utf8");
    expect(route).toContain("docsNavIndex()");
    expect(route).toContain("public, max-age=300");
  });
});
