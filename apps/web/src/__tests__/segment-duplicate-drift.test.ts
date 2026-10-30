// SPDX-License-Identifier: AGPL-3.0-only
//
// Drift guard for segment duplication.
//
// `includeArchived` decides whether archived contacts are in scope, so a
// duplicate that omits it produces a copy with a DIFFERENT audience than the
// original it claims to clone. The field is optional on CreateSegmentInput, so
// leaving it out type-checks silently — nothing catches it but a reader.
//
// It was hand-rolled in THREE places (the editor's Duplicate, the editor's
// delete-Undo, and the detail page's Duplicate); fixing the first two still
// left the third wrong. The copy-naming rule had drifted too: the detail page
// re-implemented `${name} (copy)` without duplicateName's collision check, so
// two duplicates could land on the same name.
//
// This asserts the rule lives in exactly one place rather than re-testing each
// call site, because the failure mode is a NEW call site, not a changed one.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../", import.meta.url).pathname;
const OWNER = "components/segments/segment-logic.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const FILES = walk(ROOT).map((p) => ({
  rel: p.slice(ROOT.length),
  text: readFileSync(p, "utf8"),
}));

/**
 * Files that touch segments. Other domains (campaigns, forms, flows, landing
 * pages, voice) have their own duplicate rules and their own "(copy)" strings —
 * scoping here keeps the guard about segments rather than policing the app.
 */
const SEGMENT_FILES = FILES.filter(
  (f) => f.rel !== OWNER && /segments?\//.test(f.rel) && /createSegment\s*\(/.test(f.text),
);

describe("segment duplication is defined in one place", () => {
  it("covers the call sites it claims to", () => {
    // Guard the guard: if the files move, this must fail rather than pass vacuously.
    expect(SEGMENT_FILES.length).toBeGreaterThanOrEqual(2);
  });

  it("no segment surface derives a duplicate's name itself", () => {
    // A literal "(copy)" here means a second, drifting implementation of the
    // collision-avoiding rule that lives in segment-logic.
    const offenders = SEGMENT_FILES.filter((f) => /\(copy\)/.test(f.text)).map(
      (f) => f.rel,
    );
    expect(offenders).toEqual([]);
  });

  it("no segment surface calls duplicateName directly", () => {
    const offenders = SEGMENT_FILES.filter((f) =>
      /\bduplicateName\s*\(/.test(f.text),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("every segment create that clones or restores carries the archive scope", () => {
    // A createSegment input assembled inline next to a source segment's
    // queryAst is the shape that kept dropping `includeArchived`.
    const offenders = SEGMENT_FILES.filter(
      (f) =>
        /queryAst:\s*\w+\.queryAst/.test(f.text) &&
        !f.text.includes("duplicateSegmentInput") &&
        !f.text.includes("restoreSegmentInput"),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("every segment-duplicating call site goes through the shared builder", () => {
    // Any file that duplicates a segment must import the builder rather than
    // assembling a CreateSegmentInput by hand.
    const duplicators = FILES.filter(
      (f) => f.rel !== OWNER && /onDuplicate/.test(f.text) && /createSegment\s*\(/.test(f.text),
    );
    expect(duplicators.length).toBeGreaterThan(0); // guard the guard
    for (const f of duplicators) {
      expect(
        f.text.includes("duplicateSegmentInput"),
        `${f.rel} duplicates a segment without duplicateSegmentInput`,
      ).toBe(true);
    }
  });
});
