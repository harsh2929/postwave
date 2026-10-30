// SPDX-License-Identifier: AGPL-3.0-only
//
// SegmentCondition.comparator, held to the Go evaluator that executes it.
//
// canonical-enum-parity deliberately skipped this one, and said why: "Go models
// both as bare `string` with no constants, so there is no Go vocabulary to
// compare against — asserting one would mean inventing it." That is true of Go
// CONSTANTS. It is not true of Go BEHAVIOUR: services/automation's branch
// evaluator switches on the comparator, and the set of cases it answers IS the
// vocabulary — arguably the more authoritative one, because it is what actually
// runs when a segment is evaluated.
//
// Reading the switch instead of a constant block is what closes the gap the
// schema header records. It also found a real divergence the moment it was
// written: Go honoured `is_null` and `is_not_null`, and the TypeScript union
// listed neither, so two capabilities the runtime supports could not be
// expressed by a typed client at all.
//
// BOTH DIRECTIONS MATTER, for different reasons.
//   - Go-only value: a capability that exists but no typed caller can reach.
//     Silent, and it looks like a missing feature rather than a drift.
//   - TS-only value: a comparator a caller can construct that the evaluator
//     does not implement. It does not throw -- the switch simply falls through
//     to its default -- so the condition quietly evaluates false and the
//     segment matches the wrong people.
//
// Equality is therefore the assertion, not containment either way.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(process.cwd(), "../..");
const SCHEMA_TS = resolve(REPO, "packages/schema/src/index.ts");
const BRANCH_GO = resolve(
  REPO,
  "services/automation/internal/runtime/branch.go",
);

/**
 * Comparators the Go evaluator answers.
 *
 * Scoped to `switch comparator { ... }` blocks specifically. branch.go also
 * switches on field names and on node ops, and a looser scan picks those up as
 * if they were comparators -- which is exactly the false vocabulary this guard
 * would otherwise assert. There are two such blocks: the null-checks run before
 * the field-resolution bail-out, because they are the only comparators that are
 * meaningful when the field is absent.
 */
function goComparators(): string[] {
  const src = readFileSync(BRANCH_GO, "utf8");
  const blocks = [...src.matchAll(/switch comparator \{(.*?)\n\t\}/gs)].map(
    (m) => m[1]!,
  );
  if (blocks.length === 0) {
    throw new Error(
      "no `switch comparator` block found in branch.go — the guard cannot see its subject",
    );
  }
  const values: string[] = [];
  for (const block of blocks) {
    for (const c of block.matchAll(/case ((?:"[a-z_]+"(?:,\s*)?)+):/g)) {
      values.push(...[...c[1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!));
    }
  }
  if (values.length === 0) {
    throw new Error("`switch comparator` parsed to zero cases");
  }
  return [...new Set(values)].sort();
}

/** The comparator union declared on SegmentCondition. */
function tsComparators(): string[] {
  const src = readFileSync(SCHEMA_TS, "utf8");
  const decl = /comparator\??:\s*((?:\s*\|\s*"[a-z_]+")+);/.exec(src);
  if (!decl?.[1]) {
    throw new Error("SegmentCondition.comparator union not found in @postwave/schema");
  }
  const values = [...decl[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
  if (values.length === 0) {
    throw new Error("comparator union parsed to zero values");
  }
  return [...new Set(values)].sort();
}

describe("SegmentCondition.comparator parity with the Go evaluator", () => {
  it("declares exactly the comparators the evaluator implements", () => {
    expect(tsComparators()).toEqual(goComparators());
  });

  it("names a comparator the evaluator cannot silently ignore", () => {
    // Direction check, stated separately so a failure says WHICH way it drifted.
    const [ts, go] = [tsComparators(), goComparators()];
    expect({
      declaredButNotImplemented: ts.filter((c) => !go.includes(c)),
      implementedButNotDeclared: go.filter((c) => !ts.includes(c)),
    }).toEqual({ declaredButNotImplemented: [], implementedButNotDeclared: [] });
  });

  it("can actually see both vocabularies", () => {
    // Guards the guard. Both extractors throw on an empty parse, but a regex
    // that silently matched a smaller block would make the equality above
    // vacuous rather than wrong -- the failure mode this programme has hit
    // repeatedly.
    expect(goComparators().length).toBeGreaterThanOrEqual(12);
    expect(tsComparators().length).toBeGreaterThanOrEqual(12);
    expect(goComparators()).toContain("equals");
    expect(tsComparators()).toContain("equals");
  });
});
