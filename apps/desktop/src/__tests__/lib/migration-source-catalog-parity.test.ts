// Desktop's migration source catalogue, held to the Go adapter vocabulary.
//
// migration-sources.ts states the contract in its own header — "The IDs map 1:1
// onto `canonical.SourcePlatform` in packages/migrate/canonical/types.go" — and
// nothing enforced it. Web's equivalent chain is already closed end to end: the
// TS SourcePlatform union is guarded against Go by canonical-source-platform-
// parity, and SOURCE_LABELS is a Record<SourcePlatform, string>, so the compiler
// refuses to build until a new platform has a label. Desktop declares its own
// independent union instead, which no guard and no compiler ever compares to
// anything.
//
// The consequence is silence, not breakage: ship a new adapter in
// packages/migrate and desktop's wizard simply never offers it. Nothing fails,
// no test goes red, and the feature looks unbuilt rather than unwired.
//
// They agree today — 20 Go platforms, plus `other`. That is exactly when this
// costs nothing to add; written after a divergence it is a migration.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  MIGRATION_SOURCES,
  type MigrationSourceDef,
} from "../../lib/migration-sources";

const CANONICAL_GO = resolve(
  process.cwd(),
  "../../packages/migrate/canonical/types.go",
);

/**
 * `other` is a UI-only card, documented as such in migration-sources.ts: the
 * fallback for HTML/API platforms that have no adapter at all. It has no Go
 * counterpart by design, so it is excluded by name rather than by a rule that
 * would also swallow a genuinely missing platform.
 */
const UI_ONLY = new Set(["other"]);

function goSourcePlatforms(): string[] {
  const src = readFileSync(CANONICAL_GO, "utf8");
  const values = [
    ...src.matchAll(/Source\w+\s+SourcePlatform\s*=\s*"([a-z0-9_-]+)"/g),
  ].map((m) => m[1]!);
  if (values.length === 0) {
    throw new Error(
      "no SourcePlatform constants found in packages/migrate/canonical/types.go — the guard cannot see its subject",
    );
  }
  return [...new Set(values)].sort();
}

function desktopSourceIds(): string[] {
  const ids = MIGRATION_SOURCES.map((s: MigrationSourceDef) => String(s.id));
  if (ids.length === 0) throw new Error("MIGRATION_SOURCES is empty");
  return [...new Set(ids)].sort();
}

describe("desktop migration source catalogue parity", () => {
  it("offers every adapter the Go vocabulary declares", () => {
    const missing = goSourcePlatforms().filter(
      (p) => !desktopSourceIds().includes(p),
    );
    expect(missing).toEqual([]);
  });

  it("invents no source the Go vocabulary does not know", () => {
    // The other direction: a card for a platform with no adapter is a wizard
    // step that dead-ends after the user has picked it.
    const go = goSourcePlatforms();
    const invented = desktopSourceIds().filter(
      (id) => !go.includes(id) && !UI_ONLY.has(id),
    );
    expect(invented).toEqual([]);
  });

  it("still declares the documented UI-only fallback", () => {
    // Guards the exclusion. If `other` were dropped, UI_ONLY would silently
    // stop doing anything and the test above would keep passing — an allowance
    // that outlives what it allows is how a guard quietly loosens.
    expect(desktopSourceIds()).toContain("other");
  });

  it("can see both vocabularies", () => {
    // Guards the guard: both extractors throw when empty, but a regex that
    // matched a smaller set would make the comparisons vacuous rather than
    // wrong.
    expect(goSourcePlatforms().length).toBeGreaterThanOrEqual(15);
    expect(desktopSourceIds().length).toBeGreaterThanOrEqual(15);
    expect(goSourcePlatforms()).toContain("mailchimp");
  });
});
