/**
 * Affiliate-program boundary contract (MAP#3 / COMMERCE#27).
 *
 * WHY THIS FILE EXISTS INSTEAD OF app/(tabs)/affiliates.tsx
 * --------------------------------------------------------
 * Two audit findings ask mobile for an affiliates monitor ("partner list +
 * payouts due"). Both were written against a desktop page that has since been
 * withdrawn, and both name endpoints that DO NOT EXIST AT RUNTIME. Building
 * the screen would ship a tab that can only ever render a 404, for a
 * commercial programme the platform has deliberately closed. The evidence,
 * all re-verified against source rather than against openapi.json or the
 * routeauth manifest:
 *
 *  1. apps/api/internal/affiliates/availability.go declares four COMPILE-TIME
 *     constants — AdminOperationsAvailable, PublicOfferAvailable,
 *     NewAttributionAvailable, PayoutOperationsAvailable — all `false`.
 *     MountAdminRoutes / MountPublicRoutes early-return on them, so the chi
 *     router never learns the paths. The package's own
 *     TestClosedAffiliateMountsRegisterNoRoutes asserts GET
 *     /api/v1/admin/affiliates answers 404 even after MountAdminRoutes runs.
 *
 *  2. The composition root never calls it anyway: apps/api/main.go leaves
 *     `affiliatesDeps.MountAdminRoutes` as a comment explaining the legal and
 *     commercial release gate, and packages/openapi/route-reachability.json
 *     lists both mount symbols under `forbidden_composition_calls`.
 *
 *  3. apps/api/internal/routeauth/manifest.json carries ZERO affiliate rows
 *     out of 2382, and main.go records that the route-authz validator refuses
 *     to boot if an unregistered route is mounted. There is no feature flag
 *     that opens this; it takes a reviewed release.
 *
 * Desktop and web already reached the same conclusion and locked it down:
 * apps/desktop/src/pages/Affiliates.tsx is a release-qualification workspace
 * that issues no requests, and both
 * apps/desktop/src/__tests__/components/user-facing-capability-contract.test.ts
 * and apps/web/src/__tests__/affiliate-public-offer-contract.test.ts assert
 * their surfaces contain no "/api/v1/admin/affiliates" string. Mobile was the
 * only client with no such guard — and the only one where an audit finding
 * could still talk somebody into building the dead screen. So this is that
 * guard.
 *
 * The failure mode is invisible without it: a phone screen wired to a closed
 * endpoint does not crash, it just shows an error forever, or — worse, under
 * a `?? []` — an empty partner list that reads as "nobody is owed anything".
 * That is rule 8 (ABSENCE IS NOT ZERO) applied to a whole surface.
 *
 * WHEN THE PROGRAMME OPENS: assertion 1 goes red on purpose. That red is the
 * to-do. Flipping AdminOperationsAvailable is necessary but nowhere near
 * sufficient — registering the routes in the gateway manifest and clearing
 * the reachability entry must land in the same release — so re-read all three
 * checks below before deleting any of them, then build the monitor.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const mobileRoot = fileURLToPath(new URL("../../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const selfPath = fileURLToPath(import.meta.url);

function repoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

/** Every path the closed affiliate sub-tree would have answered on. */
const CLOSED_ENDPOINT_PREFIXES = [
  "/api/v1/admin/affiliates",
  "/api/public/affiliates",
] as const;

/** The Go availability constants that gate the whole programme. */
const AVAILABILITY_CONSTANTS = [
  "AdminOperationsAvailable",
  "PublicOfferAvailable",
  "NewAttributionAvailable",
  "PayoutOperationsAvailable",
] as const;

function goConstant(source: string, name: string): string {
  const match = new RegExp(`\\b${name}\\s*=\\s*(\\w+)`, "u").exec(source);
  if (!match?.[1]) {
    throw new Error(
      `apps/api/internal/affiliates/availability.go no longer declares ${name}. ` +
        `The affiliate release boundary has been restructured — re-read it ` +
        `before changing this contract.`,
    );
  }
  return match[1];
}

function sourceFilesUnder(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root).sort()) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const absolute = join(root, entry);
    if (statSync(absolute).isDirectory()) {
      found.push(...sourceFilesUnder(absolute));
      continue;
    }
    if (![".ts", ".tsx"].includes(extname(entry))) continue;
    if (absolute === selfPath) continue;
    found.push(absolute);
  }
  return found;
}

describe("affiliate programme boundary", () => {
  it("keeps every affiliate operational boundary closed in the Go source", () => {
    const availability = repoFile(
      "apps/api/internal/affiliates/availability.go",
    );
    for (const name of AVAILABILITY_CONSTANTS) {
      expect(
        goConstant(availability, name),
        `${name} is no longer false. If the affiliate programme has been ` +
          `released, MAP#3 / COMMERCE#27 are now buildable on mobile — see ` +
          `this file's header for what else must land first.`,
      ).toBe("false");
    }
  });

  it("keeps both affiliate mounts forbidden in the composition root", () => {
    const reachability = JSON.parse(
      repoFile("packages/openapi/route-reachability.json"),
    ) as { forbidden_composition_calls: { symbol: string }[] };
    const forbidden = reachability.forbidden_composition_calls.map(
      (entry) => entry.symbol,
    );
    expect(forbidden).toContain("affiliatesDeps.MountAdminRoutes");
    expect(forbidden).toContain("affiliatesDeps.MountPublicRoutes");
  });

  it("has no affiliate route registered in the gateway authz manifest", () => {
    const manifest = JSON.parse(
      repoFile("apps/api/internal/routeauth/manifest.json"),
    ) as { routes: { path: string }[] };
    expect(manifest.routes.length).toBeGreaterThan(0);
    expect(
      manifest.routes.filter((route) => route.path.includes("affiliate")),
    ).toEqual([]);
  });

  it("never calls a closed affiliate endpoint from mobile source", () => {
    const offenders: string[] = [];
    for (const absolute of [
      ...sourceFilesUnder(join(mobileRoot, "app")),
      ...sourceFilesUnder(join(mobileRoot, "src")),
    ]) {
      const source = readFileSync(absolute, "utf8");
      for (const prefix of CLOSED_ENDPOINT_PREFIXES) {
        if (source.includes(prefix)) {
          offenders.push(`${absolute.slice(mobileRoot.length)} → ${prefix}`);
        }
      }
    }
    expect(
      offenders,
      "These files call an affiliate endpoint that returns 404 in every " +
        "deployed environment. See this file's header for the evidence.",
    ).toEqual([]);
  });
});
