// SPDX-License-Identifier: AGPL-3.0-only
//
// Public copy that defers a capability to a numbered release ("on the v0.3.0
// roadmap") quietly becomes false the day that release ships. The migration
// guides promised an automation AST translator and active commenting "on the
// v0.3.0 roadmap" while the changelog had already shipped v0.3.0, v0.3.1 and
// v0.4.0 — so readers were pointed at a future that was already the past.
//
// The rule enforced here is narrow: a forward-looking promise may not name a
// version the changelog says has shipped. Referring to an unreleased version
// is still allowed, and the changelog itself is exempt because its entries are
// historical records.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const CHANGELOG = join(SRC, "app/(marketing)/changelog/page.tsx");

/** Versions the changelog says are released. */
function shippedVersions(): Set<string> {
  const text = readFileSync(CHANGELOG, "utf8");
  return new Set(
    [...text.matchAll(/version:\s*"(v[\d.]+)"/g)].map((m) => m[1]!),
  );
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

function publicPages(): string[] {
  return [
    ...walk(join(SRC, "app/(marketing)")),
    ...walk(join(SRC, "app/(docs)")),
  ].filter((f) => f !== CHANGELOG);
}

// "on the v0.3.0 roadmap", "coming in v1.2.0", "planned for v2.0.0".
const FORWARD_LOOKING =
  /\b(?:on the|coming in|planned for|ships in|scheduled for|slated for)\s+(v?\d+\.\d+\.\d+)\s*(?:roadmap|release)?/gi;

describe("forward-looking version claims", () => {
  it("reads a changelog with released versions", () => {
    // Guard the guard: an empty set would make every promise look unshipped.
    expect(shippedVersions().size).toBeGreaterThan(3);
    expect(publicPages().length).toBeGreaterThan(30);
  });

  it("never defers a capability to a version that already shipped", () => {
    const shipped = shippedVersions();
    const stale: string[] = [];
    for (const file of publicPages()) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(FORWARD_LOOKING)) {
        const raw = m[1]!;
        const normalized = raw.startsWith("v") ? raw : `v${raw}`;
        if (shipped.has(normalized)) {
          stale.push(`${normalized} (${file.slice(SRC.length + 1)})`);
        }
      }
    }
    expect([...new Set(stale)].sort()).toEqual([]);
  });
});
