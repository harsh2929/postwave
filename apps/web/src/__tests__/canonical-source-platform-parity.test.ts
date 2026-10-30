// SPDX-License-Identifier: AGPL-3.0-only
//
// The canonical SourcePlatform vocabulary is declared in TypeScript
// (@postwave/schema) and Go (packages/migrate/canonical/types.go), and
// apps/web's own types.ts says out loud that they are hand-synced: "Keep in
// sync with packages/schema/src/index.ts (canonical TS) and the Go equivalents
// … until codegen lands."
//
// They differ by exactly one value, and the difference is CORRECT.
//
//   `mailchimp_api` is provenance, not a source you can migrate FROM. The
//   gateway emits it for tenants already migrated through the Mailchimp v3 API
//   path rather than a CSV export — "every API-migrated subscriber would
//   otherwise fail strict parsing" — so the TS union must accept it. The Go
//   extraction library has no adapter for it and must not list it, or
//   adapter.Register would be claiming a source nothing can extract.
//
// Three places enforce that asymmetry today, and each is load-bearing in a
// different direction:
//
//   * apps/web narrows it away: Exclude<SchemaSourcePlatform, "mailchimp_api">
//   * sdk-ts throws from migrationSourcePathSegment and migrations.start
//   * the CLI asserts isMigrationSource("mailchimp_api") === false
//
// This exists because the asymmetry looks exactly like drift. The obvious
// "fix" in either direction breaks something: adding it to Go invents an
// adapter, removing it from TS makes every API-migrated tenant fail to parse.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(process.cwd(), "../..");

const SCHEMA_TS = readFileSync(
  resolve(REPO, "packages/schema/src/index.ts"),
  "utf8",
);
const CANONICAL_GO = readFileSync(
  resolve(REPO, "packages/migrate/canonical/types.go"),
  "utf8",
);

/** Values in a TS string-literal union. Hyphens matter: constant-contact. */
function tsUnion(source: string, name: string): string[] {
  const m = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(source);
  expect(m, `${name} union not found`).not.toBeNull();
  return [...new Set([...m![1]!.matchAll(/"([a-z0-9_-]+)"/g)].map((x) => x[1]!))];
}

/** Values of a Go typed-constant block. */
function goConsts(source: string, typeName: string): string[] {
  return [
    ...new Set(
      [
        ...source.matchAll(
          new RegExp(`\\w+\\s+${typeName}\\s*=\\s*"([a-z0-9_-]+)"`, "g"),
        ),
      ].map((m) => m[1]!),
    ),
  ];
}

/** The one value TS carries that Go deliberately does not. */
const PROVENANCE_ONLY = "mailchimp_api";

describe("canonical SourcePlatform vocabulary", () => {
  const ts = tsUnion(SCHEMA_TS, "SourcePlatform");
  const go = goConsts(CANONICAL_GO, "SourcePlatform");

  it("reads both vocabularies", () => {
    // Guard the guard: an anchored regex that stops matching would report
    // perfect parity between two empty sets. The hyphenated entries are the
    // ones a naive [a-z_]+ silently drops.
    expect(ts.length).toBeGreaterThan(15);
    expect(go.length).toBeGreaterThan(15);
    expect(go).toContain("constant-contact");
    expect(go).toContain("campaign-monitor");
  });

  it("differs from Go by exactly the provenance value", () => {
    const tsOnly = ts.filter((v) => !go.includes(v)).sort();
    const goOnly = go.filter((v) => !ts.includes(v)).sort();
    expect(tsOnly).toEqual([PROVENANCE_ONLY]);
    expect(goOnly).toEqual([]);
  });

  it("backs every Go platform with a registered adapter", () => {
    // The Go list is the extraction library's promise. A constant with no
    // adapter is a source the module claims to read and cannot.
    const registered = new Set<string>();
    const migrateDir = resolve(REPO, "packages/migrate");
    // Adapters register by constant name, so resolve names -> values.
    const nameToValue = new Map(
      [
        ...CANONICAL_GO.matchAll(
          /(\w+)\s+SourcePlatform\s*=\s*"([a-z0-9_-]+)"/g,
        ),
      ].map((m) => [m[1]!, m[2]!]),
    );
    for (const dir of readdirSync(migrateDir)) {
      const file = resolve(migrateDir, dir, "adapter.go");
      if (!existsSync(file)) continue;
      const m = /adapter\.Register\(\s*canonical\.(Source\w+)/.exec(
        readFileSync(file, "utf8"),
      );
      if (m && nameToValue.has(m[1]!)) registered.add(nameToValue.get(m[1]!)!);
    }
    expect(registered.size).toBeGreaterThan(15);
    expect(go.filter((v) => !registered.has(v)).sort()).toEqual([]);
  });

  it("keeps the provenance value unstartable on every client", () => {
    // Each of these enforces the asymmetry from a different angle; losing any
    // one lets a caller try to migrate FROM a lineage marker.
    const webTypes = readFileSync(
      resolve(REPO, "apps/web/src/lib/types.ts"),
      "utf8",
    );
    expect(webTypes).toMatch(
      new RegExp(`Exclude<\\s*SchemaSourcePlatform,\\s*"${PROVENANCE_ONLY}"`),
    );

    const sdkTests = readFileSync(
      resolve(REPO, "packages/sdk-ts/tests/migrations.test.ts"),
      "utf8",
    );
    expect(sdkTests).toContain(`migrationSourcePathSegment("${PROVENANCE_ONLY}")`);
    expect(sdkTests).toMatch(/\.toThrow\(/);

    const cliTests = readFileSync(
      resolve(REPO, "packages/cli/tests/migrate.test.ts"),
      "utf8",
    );
    expect(cliTests).toContain(
      `expect(isMigrationSource("${PROVENANCE_ONLY}")).toBe(false)`,
    );
  });

  it("explains why the TS union carries it", () => {
    // Without the reason recorded next to the value, the next reader deletes
    // it as drift and every API-migrated subscriber fails strict parsing.
    const sdkTypes = readFileSync(
      resolve(REPO, "packages/sdk-ts/src/types.ts"),
      "utf8",
    );
    expect(sdkTypes).toMatch(/gateway emits `mailchimp_api`/);
    expect(sdkTypes).toMatch(/fail strict parsing/);
  });
});
