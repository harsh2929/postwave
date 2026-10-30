// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Every publishable customer-facing package must be reachable from this page.
//
// @postwave/track is the case that motivated this: a browser event SDK with
// `publishConfig.access: public` and no `private` flag, whose entire audience is
// outside this repository, documented nowhere. For a package a site owner is
// meant to embed, being undocumented is indistinguishable from not existing —
// and no test in the repo could notice, because "zero importers" is its normal
// and correct state.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const packagesDir = join(repoRoot, "packages");
const pageSource = ["page.tsx", "install-tabs-data.ts"]
  .map((file) =>
    readFileSync(
      join(repoRoot, "apps/web/src/app/(marketing)/developers", file),
      "utf8",
    ),
  )
  .join("\n");

/**
 * Packages that are published for OUTSIDE consumption and are documented here.
 *
 * The server-side SDKs (sdk-go, sdk-py, …) have their own language-specific
 * install lines elsewhere on the page; this list is scoped to npm packages a
 * browser or Node consumer installs by name, which is what INSTALL_TABS covers.
 */
const EXPECTED_NPM_PACKAGES = ["@postwave/sdk", "@postwave/cli", "@postwave/track"];

describe("publishable npm packages are documented for the people who install them", () => {
  it("reads the page", () => {
    expect(pageSource.length).toBeGreaterThan(5_000);
  });

  for (const name of EXPECTED_NPM_PACKAGES) {
    it(`${name} appears in an install snippet`, () => {
      expect(
        pageSource.includes(name),
        `${name} is publishable but does not appear on the developers page. Its ` +
          `consumers are outside this repo, so nothing here would break — it would ` +
          `simply never be found.`,
      ).toBe(true);
    });
  }

  it("does not grow the set of publishable-but-undocumented packages", () => {
    // `publishConfig.access: public` turns out to be workspace boilerplate, not
    // a statement that a package is customer-facing: 14 internal substrate
    // packages carry it. So this is a RATCHET over the current set rather than a
    // demand that all of them be documented, which would only add noise.
    //
    // The 14 are worth their own look — a package that declares public publish
    // access and is internal substrate will be pushed to npm by any release step
    // that trusts that flag — but that is a separate question from this page,
    // and inventing an answer here would be guessing at intent.
    const KNOWN_UNDOCUMENTED = [
      "@postwave/ai-disclosure",
      "@postwave/audit-portal-react",
      "@postwave/claude-code-plugin",
      "@postwave/design-tokens",
      "@postwave/email-react",
      "@postwave/mcp-server",
      "@postwave/nav",
      "@postwave/notifications",
      "@postwave/onboarding-schema",
      "@postwave/openapi",
      "@postwave/query-contract",
      "@postwave/route-map",
      "@postwave/schema",
      "@postwave/telemetry",
    ];

    const publishable: string[] = [];
    for (const entry of readdirSync(packagesDir)) {
      const manifest = join(packagesDir, entry, "package.json");
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
        name?: string;
        private?: boolean;
        publishConfig?: { access?: string };
      };
      if (!pkg.name?.startsWith("@postwave/")) continue;
      if (pkg.private) continue;
      if (pkg.publishConfig?.access !== "public") continue;
      publishable.push(pkg.name);
    }
    // Guard the guard: an empty scan would make this assertion vacuous.
    expect(publishable.length).toBeGreaterThan(0);

    const undocumented = publishable.filter((name) => !pageSource.includes(name));
    const unexpected = undocumented.filter((name) => !KNOWN_UNDOCUMENTED.includes(name));
    expect(
      unexpected,
      `these packages are newly publishable and appear nowhere on the developers ` +
        `page: ${JSON.stringify(unexpected)}. Either document them or mark them ` +
        `private — a package that is publishable and unfindable is the shape of ` +
        `dead code that no import graph can detect, because zero importers is its ` +
        `normal state.`,
    ).toEqual([]);
  });
});
