import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ENTITIES } from "@postwave/route-map";

import { routeForNavSlug } from "@/lib/navDeepLinks";

/**
 * NATIVE#4 — Android must not claim a link iOS deliberately refuses.
 *
 * The AASA route states the principle: "An AASA claim is a HIJACK, not a hint:
 * once the app is installed, iOS stops opening Safari for a claimed path and hands
 * it to the app instead. Claiming a path the app cannot route turns a working web
 * page into a dead end." So iOS claims `/app/{slug}/*` only for entities whose
 * `surfaces.mobile !== "none"`, and leaves affiliates and sequence-templates to
 * Safari on purpose.
 *
 * Android's intent filter carried `pathPrefix: "/app"` under `autoVerify`, which
 * claims EVERY dashboard URL — including the two iOS refuses — and produces exactly
 * the dead end that comment describes: the app opens, resolves nothing, and the
 * page the user wanted was one tap away in the browser.
 *
 * The two platforms are now derived from the same registry, and this fails if they
 * drift.
 *
 * SECOND HALF, added later: the registry is not the whole claim set.
 * `routeForNavLink` (lib/navDeepLinks.ts) resolves a LIST-level destination for
 * every screen in the mobile route manifest — `/app/audit`, `/app/dmarc`,
 * `/app/sms-suppressions` and forty more — and none of those urls was claimed
 * on either platform, so the grammar was reachable only through the
 * `moosewave://` scheme. The claimed subset now lives in one place per platform
 * (`MOBILE_DESTINATION_LINK_PATHS` in the AASA route, `path` entries in
 * app.json) and the assertions below hold them to each other AND to the app's
 * own router, which is the only check that can catch a claim the app cannot
 * honour.
 *
 * A third gap this closes is iOS-only and was invisible from either list: the
 * AASA emitted `/app/<slug>/*` and nothing else. Apple requires the literal
 * `/` before the wildcard (the repo's own model of that rule is
 * `advertisedPathMatchesUrl` in scripts/app-link-fixtures.mjs), so every
 * entity's LIST url was unclaimed on iOS while Android's `pathPrefix` claimed
 * it — the two platforms already disagreeing about the sixteen paths they were
 * supposed to share.
 */
const appJson = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "app.json"), "utf8"),
) as Record<string, unknown>;

const aasaSource = readFileSync(
  join(
    __dirname,
    "..",
    "..",
    "..",
    "web",
    "src",
    "app",
    ".well-known",
    "apple-app-site-association",
    "route.ts",
  ),
  "utf8",
);

/**
 * The iOS claim set, read out of the route's SOURCE.
 *
 * apps/web is a separate package with its own module graph (next/server,
 * `Response.json`), so importing the route from a mobile vitest run is not an
 * option. Reading the literals is — and it is the same technique
 * `appIntentsContract.test.ts` uses to hold Swift and TypeScript together.
 */
function aasaDestinationPaths(): string[] {
  const block = /MOBILE_DESTINATION_LINK_PATHS = \[([\s\S]*?)\]/u.exec(
    aasaSource,
  );
  if (!block) return [];
  return (block[1]?.match(/"(\/app\/[a-z0-9-]+)"/gu) ?? []).map((quoted) =>
    quoted.slice(1, -1),
  );
}

function androidAppLinkPrefixes(): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.pathPrefix === "string") found.push(record.pathPrefix);
    Object.values(record).forEach(walk);
  };
  walk(appJson);
  return found;
}

/** Exact (non-prefix) `path` claims — the destination half. */
function androidExactAppLinkPaths(): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.path === "string") found.push(record.path);
    Object.values(record).forEach(walk);
  };
  walk(appJson);
  return found.filter((path) => path.startsWith("/app/"));
}

const mobileSlugs = Object.values(ENTITIES)
  .filter((entity) => entity.surfaces.mobile !== "none")
  .map((entity) => entity.slug)
  .sort();

describe("Android app-link claims match iOS", () => {
  it("never claims the whole /app tree", () => {
    // The blanket prefix is the bug: it hijacks every dashboard URL, including
    // the ones with no mobile screen behind them.
    expect(androidAppLinkPrefixes()).not.toContain("/app");
  });

  it("claims exactly the entities iOS claims", () => {
    const claimed = androidAppLinkPrefixes()
      .filter((prefix) => prefix.startsWith("/app/"))
      .map((prefix) => prefix.slice("/app/".length))
      .sort();
    expect(claimed).toEqual(mobileSlugs);
  });

  it("claims nothing for an entity with no mobile surface", () => {
    const webOnly = Object.values(ENTITIES)
      .filter((entity) => entity.surfaces.mobile === "none")
      .map((entity) => entity.slug);
    // Guards the guard: if the registry ever has no web-only entity, this
    // assertion would pass vacuously and prove nothing.
    expect(webOnly.length).toBeGreaterThan(0);
    const claimed = new Set(androidAppLinkPrefixes());
    for (const slug of webOnly) {
      expect(
        claimed.has(`/app/${slug}`),
        `Android claims /app/${slug}, which iOS leaves to the browser because mobile cannot route it`,
      ).toBe(false);
    }
  });
});

describe("destination claims name screens the app can actually open", () => {
  const claimedSlugs = [
    ...androidAppLinkPrefixes(),
    ...androidExactAppLinkPaths(),
  ]
    .filter((path) => path.startsWith("/app/"))
    .map((path) => path.slice("/app/".length));

  it("finds claims at all", () => {
    // Vacuity floor: a renamed key or a restructured intent filter would make
    // every loop below iterate zero times.
    expect(claimedSlugs.length).toBeGreaterThanOrEqual(30);
    expect(aasaDestinationPaths().length).toBeGreaterThanOrEqual(15);
  });

  it("claims nothing the mobile router cannot resolve", () => {
    // THE invariant. An app-link claim is a hijack: iOS and Android stop
    // opening the browser for a claimed url and hand it to the app, so a claim
    // the app answers with "couldn't open that link" is strictly worse than no
    // claim at all.
    for (const slug of claimedSlugs) {
      expect(
        routeForNavSlug(slug),
        `/app/${slug} is claimed but routeForNavSlug("${slug}") is null — the app would open and land nowhere while the page was one tap away in Safari.`,
      ).not.toBeNull();
    }
  });

  it("claims the SAME destinations on both platforms", () => {
    // The whole point of NATIVE#4, applied to the second claim set: one
    // platform hijacking a url the other leaves to the browser is a link that
    // behaves differently depending on which phone opened it.
    expect(androidExactAppLinkPaths().sort()).toEqual(
      aasaDestinationPaths().sort(),
    );
  });

  it("claims destinations EXACTLY, never as a prefix", () => {
    // These screens have no detail route, and `routeForNavLink` REJECTS a
    // third path segment rather than truncating it (an unrecognised
    // `/app/tags/42` must not silently land on the tag list). A prefix claim
    // would therefore hand the app urls it refuses.
    const prefixed = new Set(androidAppLinkPrefixes());
    for (const path of androidExactAppLinkPaths()) {
      expect(prefixed.has(path), `${path} is claimed as a prefix`).toBe(false);
    }
  });

  it("claims each entity's LIST url, not only its detail urls", () => {
    // The iOS-only half. `/app/campaigns/*` does not match `/app/campaigns`
    // (scripts/app-link-fixtures.mjs `advertisedPathMatchesUrl` is this repo's
    // model of Apple's rule), so the wildcard alone left every list url to
    // Safari on iOS while Android's pathPrefix claimed it.
    expect(
      aasaSource,
      "the AASA no longer emits the bare entity path alongside the wildcard",
    ).toContain(
      ".flatMap((entity) => [`/app/${entity.slug}`, `/app/${entity.slug}/*`])",
    );
    // …and the router really does resolve every bare list url, which is what
    // makes the added claim safe rather than a new dead end.
    for (const slug of mobileSlugs) {
      expect(routeForNavSlug(slug), `/app/${slug}`).not.toBeNull();
    }
  });
});
