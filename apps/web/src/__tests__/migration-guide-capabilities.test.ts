// SPDX-License-Identifier: AGPL-3.0-only
//
// Each docs migration guide has a "What gets migrated" list and a "What does
// NOT migrate" list. The Go adapter behind it declares the same thing as
// capability flags. Nothing connected the two, and they disagreed.
//
// ConvertKit's adapter sets Supports.PaidSubs = true and implements
// ListPaidSubs. Substack intentionally does not: its export carries tier
// metadata, while Stripe/Apple billing needs a publication-bound handoff.
//
// A reader following the Kit guide would rebuild paid subscriptions by hand
// that the migration already carries.
//
// Capability flags are coarse, so this checks the direction that is decidable:
// a guide must not deny something its adapter declares supported.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");
const GUIDES = readFileSync(
  join(SRC, "app/(docs)/docs/migrations/[source]/page.tsx"),
  "utf8",
);

interface Claims {
  migrates: string[];
  doesNotMigrate: string[];
}

/** Per-slug claim lists, parsed from the GUIDES record. */
function claims(): Map<string, Claims> {
  const out = new Map<string, Claims>();
  for (const m of GUIDES.matchAll(
    /slug: "([a-z0-9]+)",(?:(?!\n  [a-z])[\s\S])*?migrates: \[([\s\S]*?)\n {4}\],(?:(?!\n {2}[a-z])[\s\S])*?doesNotMigrate: \[([\s\S]*?)\n {4}\],/g,
  )) {
    const strings = (block: string): string[] =>
      [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]!);
    out.set(m[1]!, {
      migrates: strings(m[2]!),
      // Only the item titles, not the "why" prose, which legitimately
      // discusses capabilities in order to explain a boundary.
      doesNotMigrate: [...m[3]!.matchAll(/item:\s*"((?:[^"\\]|\\.)*)"/g)].map(
        (x) => x[1]!,
      ),
    });
  }
  return out;
}

/** A capability flag from an adapter, or null when it has no such adapter. */
function supports(slug: string, flag: string): boolean | null {
  let go: string;
  try {
    go = readFileSync(
      join(REPO, "packages/migrate", slug, "adapter.go"),
      "utf8",
    );
  } catch {
    return null;
  }
  const m = new RegExp(`Supports\\.${flag}\\s*=\\s*(true|false)`).exec(go);
  return m ? m[1] === "true" : null;
}

describe("migration guides match their adapters", () => {
  const parsed = claims();

  it("parses every guide", () => {
    // Guard the guard: a restructured record would make the sweeps vacuous.
    expect(parsed.size).toBeGreaterThan(8);
    for (const [, c] of parsed) expect(c.migrates.length).toBeGreaterThan(0);
    // …and the capability side must actually resolve.
    expect(supports("convertkit", "PaidSubs")).toBe(true);
    expect(supports("substack", "PaidSubs")).toBe(false);
    expect(supports("beehiiv", "PaidSubs")).toBe(false);
  });

  it("does not deny paid subscriptions an adapter supports", () => {
    const wrong: string[] = [];
    for (const [slug, c] of parsed) {
      if (supports(slug, "PaidSubs") !== true) continue;
      const denied = c.doesNotMigrate.filter((item) =>
        /\b(paid|subscription|commerce|pay)\b/i.test(item),
      );
      const claimed = c.migrates.some((m) => /paid subscription/i.test(m));
      if (denied.length > 0 && !claimed) {
        wrong.push(`${slug}: denies "${denied.join(", ")}" but PaidSubs=true`);
      }
    }
    expect(wrong.sort()).toEqual([]);
  });

  it("says paid subscriptions migrate wherever the adapter says so", () => {
    const missing = [...parsed.entries()]
      .filter(([slug]) => supports(slug, "PaidSubs") === true)
      .filter(
        ([, c]) =>
          !c.migrates.some((m) => /paid subscription|paid subs/i.test(m)),
      )
      .map(([slug]) => slug);
    expect(missing.sort()).toEqual([]);
  });

  it("never promises paid subscriptions an adapter cannot deliver", () => {
    // The opposite error, and the more damaging one: Beehiiv's adapter is
    // explicit that premium metadata comes across but Stripe billing objects
    // do not.
    const overclaims = [...parsed.entries()]
      .filter(([slug]) => supports(slug, "PaidSubs") === false)
      .filter(([, c]) =>
        c.migrates.some((m) =>
          /\bpaid subscriptions? (?:are |do )?migrat/i.test(m),
        ),
      )
      .map(([slug]) => slug);
    expect(overclaims.sort()).toEqual([]);
  });
});
