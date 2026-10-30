// SPDX-License-Identifier: AGPL-3.0-only
//
// @postwave/schema's header says its Go equivalents "MUST be kept in sync",
// hand-mirrored until codegen exists. Only ONE of the shared vocabularies was
// actually enforced — SourcePlatform, by canonical-source-platform-parity.
// SubscriberStatus and ConsentSource were mirrored in Go and checked by nobody.
//
// They agree today. That is the point: a parity guard written while the two
// sides match costs nothing and is the only moment it can be added without
// first doing a migration. Written after they diverge, it is a bug report.
//
// WHY THESE TWO MATTER MORE THAN MOST ENUMS. Both are written into subscriber
// rows during an import and never surfaced again as a decision the user makes:
//   - SubscriberStatus decides whether a contact is SENDABLE. A value the Go
//     side does not recognise does not fail loudly; it flows into a status
//     column and the contact silently stops receiving mail, or starts.
//   - ConsentSource is the provenance of permission. It is what an audit points
//     at to say how someone opted in, so a value that exists on one side only
//     is a record that cannot be explained later.
//
// Deliberately NOT checked here: the automation-side ConsentSource. Go models
// it as a bare `string` with no constants, so there is no Go vocabulary to
// compare against — asserting one would mean inventing it. That gap is recorded
// in the schema header instead.
//
// `SegmentCondition.comparator` USED to be excluded for the same reason, and
// the reasoning was too narrow: it looked for Go constants and found none, but
// the branch evaluator's `switch comparator` IS a vocabulary — the one that
// actually executes. canonical-comparator-parity reads that switch, and found
// `is_null`/`is_not_null` implemented in Go and missing from the TS union the
// whole time.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(process.cwd(), "../..");
const SCHEMA_TS = resolve(REPO, "packages/schema/src/index.ts");
const MIGRATE_GO = resolve(REPO, "packages/migrate/canonical/types.go");
const AUTOMATION_GO = resolve(
  REPO,
  "services/automation/internal/canonical/types.go",
);

/** The string literals of an exported TS union type. */
function tsUnion(name: string): string[] {
  const src = readFileSync(SCHEMA_TS, "utf8");
  const decl = new RegExp(`export type ${name}\\s*=\\s*([^;]+);`, "s").exec(src);
  if (!decl?.[1]) throw new Error(`TS union ${name} not found in @postwave/schema`);
  const values = [...decl[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  if (values.length === 0) throw new Error(`TS union ${name} parsed to zero values`);
  return [...new Set(values)].sort();
}

/** The values of Go constants declared with a given named string type. */
function goConsts(file: string, typeName: string): string[] {
  const src = readFileSync(file, "utf8");
  const values = [
    ...src.matchAll(new RegExp(`\\w+\\s+${typeName}\\s*=\\s*"([^"]+)"`, "g")),
  ].map((m) => m[1]!);
  return [...new Set(values)].sort();
}

describe("canonical enums match their hand-mirrored Go counterparts", () => {
  it("finds both Go mirrors where the schema header says they are", () => {
    // Guard the guard, and the reason this test exists at all: the header used
    // to name services/migration/internal/canonical/types.go, which does not
    // exist. A path that resolves to nothing makes every comparison below
    // vacuous, so the paths are asserted before they are trusted.
    expect(() => readFileSync(MIGRATE_GO, "utf8")).not.toThrow();
    expect(() => readFileSync(AUTOMATION_GO, "utf8")).not.toThrow();
    expect(goConsts(MIGRATE_GO, "SubscriberStatus").length).toBeGreaterThan(0);
    expect(goConsts(MIGRATE_GO, "ConsentSource").length).toBeGreaterThan(0);
    expect(goConsts(AUTOMATION_GO, "SubscriberStatus").length).toBeGreaterThan(0);
  });

  it("agrees on SubscriberStatus in both Go files", () => {
    // Two Go mirrors, so a change applied to one and not the other is its own
    // failure mode — and the likelier one, since they live in different repos'
    // worth of directory.
    const ts = tsUnion("SubscriberStatus");
    expect(goConsts(MIGRATE_GO, "SubscriberStatus"), "packages/migrate").toEqual(ts);
    expect(goConsts(AUTOMATION_GO, "SubscriberStatus"), "services/automation").toEqual(
      ts,
    );
  });

  it("agrees on ConsentSource", () => {
    expect(goConsts(MIGRATE_GO, "ConsentSource")).toEqual(tsUnion("ConsentSource"));
  });

  it("can tell a real mismatch from a match", () => {
    // Without this, a comparison of two empty arrays passes forever.
    expect(tsUnion("SubscriberStatus")).toContain("blocklisted");
    expect(goConsts(MIGRATE_GO, "ConsentSource")).toContain("double_optin");
    expect(goConsts(MIGRATE_GO, "SubscriberStatus")).not.toEqual(
      tsUnion("ConsentSource"),
    );
  });
});
