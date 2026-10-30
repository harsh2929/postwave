// SPDX-License-Identifier: AGPL-3.0-only
//
// The same migration source is described twice: a marketing guide at
// /migrations/{from} and a docs guide at /docs/migrations/{source}. Nothing
// tied the two together, so they drifted into contradicting each other about
// the same product:
//
//   * ConvertKit was "OAuth" on one page and "API key" on the other. The
//     adapter declares AuthMethod "oauth2" with a legacy key fallback — and
//     the fallback the docs documented was the *public* api_key, which is
//     less privileged than api_secret and can 403 on exactly the segment and
//     automation reads the same page promised would migrate.
//   * Substack comments were "read-only archive" in docs and "not the comments
//     themselves" in marketing. The adapter records comments as a parity gap,
//     so marketing was right; the docs page promised data that never arrives.
//
// A reader who lands on either page should get the same answer, so the
// structured auth field is asserted equal for every source both pages cover.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const DOCS = join(SRC, "app/(docs)/docs/migrations/[source]/page.tsx");
const MARKETING = join(SRC, "app/(marketing)/migrations/[from]/page.tsx");

/**
 * slug → value of `field`, for each guide entry.
 *
 * A block counts as a guide only when it declares `slug: "<its own key>"`.
 * Matching on indentation alone is not enough — the nested `steps` and
 * `errors` arrays get picked up as if they were sources, which silently
 * invents a "steps" source that appears to disagree across the two pages.
 */
function guideField(file: string, field: string): Map<string, string> {
  const whole = readFileSync(file, "utf8");
  // Start at the record literal. The `Guide`/`SourceDetail` interface above it
  // declares `steps: { title: string; body: string }[];` at the same two-space
  // indent, and a scan from the top of the file matches that first and then
  // runs to the first `  },` — swallowing the entire first guide.
  const start = whole.search(/^const (?:GUIDES|DETAILS)[^=]*=\s*\{/m);
  const text = start === -1 ? whole : whole.slice(start);
  const out = new Map<string, string>();
  for (const m of text.matchAll(/^ {2}"?([a-z0-9-]+)"?:\s*\{(.*?)^ {2}\},/gms)) {
    const key = m[1]!;
    const body = m[2]!;
    if (!new RegExp(`slug:\\s*"${key}"`).test(body)) continue;
    const value = new RegExp(`${field}:\\s*"([^"]+)"`).exec(body);
    if (value) out.set(key, value[1]!);
  }
  return out;
}

describe("migration guides agree across marketing and docs", () => {
  const docs = guideField(DOCS, "authType");
  const marketing = guideField(MARKETING, "authMethod");
  const shared = [...docs.keys()].filter((slug) => marketing.has(slug));

  it("parses both guides", () => {
    // Guard the guard: a restructured record would otherwise leave `shared`
    // empty and make the comparison below vacuous.
    expect(docs.size).toBeGreaterThan(8);
    expect(marketing.size).toBeGreaterThan(5);
    expect(shared.length).toBeGreaterThan(5);
  });

  it("every marketing source has a docs guide", () => {
    // The reverse is fine: docs may cover sources marketing has no page for.
    const orphans = [...marketing.keys()].filter((slug) => !docs.has(slug));
    expect(orphans).toEqual([]);
  });

  it("states the same authentication method on both pages", () => {
    const conflicts = shared
      .filter((slug) => docs.get(slug) !== marketing.get(slug))
      .map((slug) => `${slug}: docs="${docs.get(slug)}" marketing="${marketing.get(slug)}"`);
    expect(conflicts).toEqual([]);
  });
});
