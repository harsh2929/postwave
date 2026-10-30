// SPDX-License-Identifier: AGPL-3.0-only
//
// Two fleet-size numbers are published repeatedly across the marketing surface,
// and they need opposite treatment.
//
// "10 mailbox environments" (cross-client preview) IS derivable: the
// deliverability service declares AllEnvironments, and it has exactly ten
// entries. A hardcoded count sitting beside a derivable list is the drift shape
// that has already produced the native-tool count in three places and the
// migration-source enumeration beside a derived length — so it is pinned to the
// Go slice.
//
// Seedlist size is NOT derivable. ActiveSeedCount is runtime deployment state,
// so public copy is guarded separately against fixed fleet-size claims rather
// than forcing every unsupported number to agree with every other unsupported
// number.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Every "<n> mailbox|inbox|seed…" claim in the app, with where it appears. */
function fleetClaims(pattern: RegExp): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of walk(SRC)) {
    for (const m of readFileSync(file, "utf8").matchAll(pattern)) {
      const n = m[1]!;
      found.set(n, [...(found.get(n) ?? []), file.slice(SRC.length + 1)]);
    }
  }
  return found;
}

describe("published deliverability fleet counts", () => {
  it("matches the render service's environment list", () => {
    const go = readFileSync(
      join(REPO, "services/deliverability/internal/render/render.go"),
      "utf8",
    );
    const start = go.indexOf("var AllEnvironments = []Environment{");
    expect(start).toBeGreaterThan(-1);
    const block = go.slice(start, go.indexOf("\n}\n", start));
    const declared = [...block.matchAll(/Name:\s*"([^"]+)"/g)].length;
    expect(declared).toBeGreaterThan(3); // guard the guard

    const claims = fleetClaims(/(\d+)\s+mailbox environments/g);
    expect(claims.size).toBeGreaterThan(0);
    const wrong = [...claims.entries()]
      .filter(([n]) => Number(n) !== declared)
      .map(
        ([n, files]) => `${n} in ${files.join(", ")} (declared ${declared})`,
      );
    expect(wrong.sort()).toEqual([]);
  });

  it("does not state a fixed seedlist fleet size", () => {
    const claims = fleetClaims(
      /(\d+)[\s-]*(?:seed[\s-]*(?:inbox|mailbox)|(?:inbox|mailbox)[\s-]*seedlist|inbox seedlist|mailbox seedlist|seedlist)\b/gi,
    );
    expect([...claims.entries()]).toEqual([]);
  });
});
