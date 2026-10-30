// SPDX-License-Identifier: AGPL-3.0-only
//
// The docs sidebar is built from lib/docs/catalog.ts, while the pages
// themselves are built from the INTEGRATIONS and GUIDES records inside the
// dynamic routes. Two lists, one truth — and drift breaks in both directions:
// a slug only in the catalog renders a sidebar link to a 404, and a slug only
// in the page record ships a guide nothing links to.
//
// They agree today (8 integrations, 11 migration sources). This keeps them
// agreeing, because the failure is silent either way: nothing type-checks the
// relationship and neither list is generated from the other.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { POPULAR } from "@/lib/docs/popular";
import { docsRouteExists, docsRouteStats } from "./helpers/docs-routes";

const SRC = resolve(process.cwd(), "src");
const CATALOG = readFileSync(join(SRC, "lib/docs/catalog.ts"), "utf8");

/** Slugs in an exported string-array constant. */
function catalogSlugs(name: string): string[] {
  const m = new RegExp(`${name}[^=]*=\\s*\\[(.*?)\\]`, "s").exec(CATALOG);
  if (!m) return [];
  return [...m[1]!.matchAll(/"([a-z0-9-]+)"/g)].map((x) => x[1]!).sort();
}

/** Top-level keys of a `const <name> = { … }` record in a route file. */
function recordKeys(rel: string, name: string, ignore: string[]): string[] {
  const text = readFileSync(join(SRC, rel), "utf8");
  const start = new RegExp(`const ${name}[^=]*=\\s*\\{`).exec(text);
  const body = start ? text.slice(start.index + start[0].length) : text;
  return [
    ...new Set(
      [...body.matchAll(/^ {2}"?([a-z0-9-]+)"?:\s*\{/gm)].map((m) => m[1]!),
    ),
  ]
    .filter((k) => !ignore.includes(k))
    .sort();
}

describe("docs sidebar catalog matches the pages that exist", () => {
  const integrationsNav = catalogSlugs("DOCS_INTEGRATIONS");
  const migrationsNav = catalogSlugs("DOCS_MIGRATION_SOURCES");

  it("reads both catalogs", () => {
    // Guard the guard: an empty parse would make the equalities below trivial.
    expect(integrationsNav.length).toBeGreaterThan(4);
    expect(migrationsNav.length).toBeGreaterThan(6);
  });

  it("lists exactly the integration guides that ship", () => {
    const pages = recordKeys(
      "app/(docs)/docs/integrations/[integration]/page.tsx",
      "INTEGRATIONS",
      ["steps"],
    );
    expect(integrationsNav).toEqual(pages);
  });

  it("names every migration source the getting-started card enumerates", () => {
    // The card listed ten sources by name while the paragraph below it renders
    // DOCS_MIGRATION_SOURCES.length — "all 11 supported migration sources".
    // Customer.io was the missing one. The count is derived and cannot drift;
    // only the hand-written enumeration beside it can, so that is what this
    // checks.
    const page = readFileSync(
      join(SRC, "app/(docs)/docs/getting-started/page.tsx"),
      "utf8",
    );
    const card = /body: "Switch from ([^"]+)"/.exec(page);
    expect(card).not.toBeNull();
    const named = card![1]!.toLowerCase();

    // Slug → the human name the card uses for it.
    const LABEL: Record<string, string> = {
      activecampaign: "activecampaign",
      hubspot: "hubspot",
      mailchimp: "mailchimp",
      convertkit: "convertkit",
      customerio: "customer.io",
      brevo: "brevo",
      beehiiv: "beehiiv",
      substack: "substack",
      mailerlite: "mailerlite",
      sendy: "sendy",
      csv: "csv",
    };
    const missing = migrationsNav.filter(
      (slug) => !named.includes(LABEL[slug] ?? slug),
    );
    expect(missing).toEqual([]);
  });

  it("lists exactly the migration guides that ship", () => {
    const pages = recordKeys(
      "app/(docs)/docs/migrations/[source]/page.tsx",
      "GUIDES",
      ["steps", "errors"],
    );
    expect(migrationsNav).toEqual(pages);
  });
});

describe("⌘K empty-state shortcuts", () => {
  // POPULAR is what every visitor sees the instant they open ⌘K, before they
  // have typed anything — the most-seen list of links in the docs. It is the
  // one curated catalog nothing checked: the sidebar catalogs are pinned to
  // the guides that ship (above), but these seven hrefs were free to rot into
  // 404s on the first screen of the search palette.

  it("reads the routes and the list", () => {
    // Guard the guard: either side empty makes the sweep below vacuous.
    expect(POPULAR.length).toBeGreaterThan(4);
    const stats = docsRouteStats();
    expect(stats.literal).toBeGreaterThan(30);
    // The param tables are what make this non-vacuous: without them a
    // dynamic pattern matches any slug at all.
    expect(stats.params).toBeGreaterThan(500);
  });

  it("points every shortcut at a page that exists", () => {
    const dead = POPULAR.filter((p) => !docsRouteExists(p.href)).map(
      (p) => `${p.label} → ${p.href}`,
    );
    expect(dead.sort()).toEqual([]);
  });

  it("derives the tool count rather than writing one down", () => {
    // The shortcut reports the mutable source-candidate inventory and its
    // release hold. Hardcoding a live-sounding tool total is how the native
    // count ended up wrong in three places at once.
    const source = readFileSync(join(SRC, "lib/docs/popular.ts"), "utf8");
    expect(source).toContain("${MCP_SOURCE_CANDIDATE_TOOL_COUNT}");
    expect(source).toContain("${MCP_RELEASE_HOLD_CODE}");
    expect(source).not.toMatch(/catalog \(\d+ (?:tools|definitions)/);
  });

  it("keeps the shortcuts distinct", () => {
    // Two rows pointing at the same page waste one of seven slots.
    const hrefs = POPULAR.map((p) => p.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe("docs guides are prebuilt from one list", () => {
  // generateStaticParams decides which pages Next actually builds. The
  // integrations route derives its params from its own INTEGRATIONS record;
  // the migrations route kept a second hand-written array beside GUIDES, so a
  // new guide could be fully written, wired into the sidebar catalog, pass
  // every check here — and still never be prebuilt, because one list of eleven
  // slugs had not been updated to twelve.
  const ROUTES: [string, string][] = [
    ["app/(docs)/docs/migrations/[source]/page.tsx", "GUIDES"],
    ["app/(docs)/docs/integrations/[integration]/page.tsx", "INTEGRATIONS"],
  ];

  /**
   * The body of generateStaticParams. Sliced to the first line-anchored "}"
   * rather than the first "}" of any kind: both signatures are
   * `generateStaticParams(): { source: string }[] {`, so a lazy `[^}]*` ends
   * inside the *return type* and never reaches the body — which made the first
   * version of this check fail on both routes, including the one already
   * written correctly.
   */
  function paramsBody(rel: string): string | null {
    const text = readFileSync(join(SRC, rel), "utf8");
    const at = text.indexOf("export function generateStaticParams");
    if (at === -1) return null;
    const end = text.indexOf("\n}", at);
    return end === -1 ? text.slice(at) : text.slice(at, end);
  }

  it("derives every param list from the record it renders", () => {
    // Guard the guard: a signature rename would otherwise report "clean".
    for (const [rel] of ROUTES) expect(paramsBody(rel)).not.toBeNull();

    const hardcoded = ROUTES.filter(
      ([rel, record]) => !paramsBody(rel)?.includes(`Object.keys(${record})`),
    ).map(([rel]) => rel);
    expect(hardcoded.sort()).toEqual([]);
  });

  it("prebuilds exactly the guides the sidebar links to", () => {
    // Guard the guard, and the invariant that actually matters: the params
    // Next builds must be the catalog the nav advertises.
    const guides = recordKeys(
      "app/(docs)/docs/migrations/[source]/page.tsx",
      "GUIDES",
      ["steps", "errors"],
    );
    const integrations = recordKeys(
      "app/(docs)/docs/integrations/[integration]/page.tsx",
      "INTEGRATIONS",
      ["steps"],
    );
    expect(guides.length).toBeGreaterThan(6);
    expect(integrations.length).toBeGreaterThan(4);
    expect(guides).toEqual(catalogSlugs("DOCS_MIGRATION_SOURCES"));
    expect(integrations).toEqual(catalogSlugs("DOCS_INTEGRATIONS"));
  });
});

describe("docs index pages list the same guides", () => {
  // There are five hand-maintained slug lists for two sets of guides: the two
  // dynamic-route records, lib/docs/catalog (the sidebar), and a separate
  // ITEMS array on each index page. Only the catalog↔record pairs were
  // checked, which left the two edges a reader actually walks into:
  // a slug on an index card with no guide behind it is a dead link, and a
  // guide missing from the index is a page nothing links to.
  /** `slug: "..."` entries in an index page's card array. */
  function indexSlugs(rel: string): string[] {
    const text = readFileSync(join(SRC, rel), "utf8");
    return [...text.matchAll(/\n {4}slug: "([a-z0-9-]+)"/g)]
      .map((m) => m[1]!)
      .sort();
  }

  const PAIRS: [string, string, string, string[]][] = [
    [
      "migrations",
      "app/(docs)/docs/migrations/page.tsx",
      "app/(docs)/docs/migrations/[source]/page.tsx",
      ["steps", "errors"],
    ],
    [
      "integrations",
      "app/(docs)/docs/integrations/page.tsx",
      "app/(docs)/docs/integrations/[integration]/page.tsx",
      ["steps"],
    ],
  ];

  it("parses both index pages", () => {
    // Guard the guard: an empty parse makes the equalities below trivial.
    for (const [name, index] of PAIRS) {
      expect(indexSlugs(index).length, name).toBeGreaterThan(4);
    }
  });

  it("cards and guides are the same set, in both directions", () => {
    for (const [name, index, route, ignore] of PAIRS) {
      const record = new RegExp(`const ([A-Z_]+): Record`).exec(
        readFileSync(join(SRC, route), "utf8"),
      );
      expect(record, name).not.toBeNull();
      expect(indexSlugs(index), name).toEqual(
        recordKeys(route, record![1]!, ignore),
      );
    }
  });
});
