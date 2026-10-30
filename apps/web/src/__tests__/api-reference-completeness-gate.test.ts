// SPDX-License-Identifier: AGPL-3.0-only
//
// The API reference is the set of operations published in OpenAPI, not an
// inventory of every route mounted by the gateway. Exposure categories are
// evaluated per exact method and path: a category can contain published
// operations, while an excluded operation needs its own reviewed gateway-only
// classification. This test pins that boundary and the fail-closed exemption.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");

const CLAIM_PAGES = [
  "app/(docs)/docs/api/page.tsx",
  "app/(marketing)/api-docs/page.tsx",
  "app/(marketing)/docs/page.tsx",
  "app/(marketing)/api-docs/_components/api-reference-preview.tsx",
];

describe("API reference publication boundary", () => {
  it("describes the published contract without making exposure categories blanket exclusions", () => {
    for (const rel of CLAIM_PAGES) {
      const source = readFileSync(join(SRC, rel), "utf8");
      expect(source, rel).toMatch(/publish(?:ed|es)/iu);
      expect(source, rel).not.toMatch(/(?:every|each) supported public/iu);
    }

    const readme = readFileSync(
      join(REPO, "packages/openapi/README.md"),
      "utf8",
    ).replace(/\s+/gu, " ");
    expect(readme).toContain(
      "These categories are evaluated per exact method and path; none is a blanket exclusion.",
    );

    const marketingReference = readFileSync(
      join(SRC, "app/(marketing)/api-docs/page.tsx"),
      "utf8",
    ).replace(/\s+/gu, " ");
    expect(marketingReference).toContain(
      "gateway route remains outside OpenAPI and the SDK only when its exact method and path have a reviewed gateway-only exclusion.",
    );
  });

  it("is backed by a CI gate that can falsify it", () => {
    // Published operations may not silently fall out of the generated artifact,
    // and reviewed gateway-only dispositions may not silently disappear.
    const workflow = readFileSync(
      join(REPO, ".github/workflows/openapi-check.yml"),
      "utf8",
    );
    expect(workflow).toMatch(/regenerate\.go\s+-check/);
  });

  it("keeps direct-route exemptions exact, classified, and fail closed", () => {
    const exemptionDocument = JSON.parse(
      readFileSync(
        join(REPO, "packages/openapi/openapi-exemptions.json"),
        "utf8",
      ),
    ) as { version: number; routes: string[] };
    const contractDocument = JSON.parse(
      readFileSync(join(REPO, "packages/openapi/route-contracts.json"), "utf8"),
    ) as {
      rules: Array<{
        route?: string;
        pattern?: string;
        exposure?: string;
        reason?: string;
      }>;
    };

    expect(exemptionDocument.version).toBe(1);
    expect(exemptionDocument.routes).toEqual(
      [...new Set(exemptionDocument.routes)].sort(),
    );
    for (const route of exemptionDocument.routes) {
      expect(route).toMatch(
        /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|ANY) \/api\//u,
      );
      const contract = contractDocument.rules.find(
        (rule) => rule.route === route,
      );
      expect(contract, route).toBeDefined();
      expect(contract?.reason?.trim(), route).not.toBe("");
      expect(contract?.exposure?.trim(), route).not.toBe("");
      expect(contract?.exposure, route).not.toMatch(
        /pending|uncodified|triage|provisional/iu,
      );
    }

    const generator = readFileSync(
      join(REPO, "packages/openapi/scripts/regenerate.go"),
      "utf8",
    );
    expect(generator).toContain("stale OpenAPI exemption");
    expect(generator).toContain("has no reviewed route-contract");
    expect(generator).toContain("unknown exposure category");
    expect(generator).toContain("unresolvedRouteWarningsError(warnings)");
  });

  it("runs that gate whenever the routes or the spec change", () => {
    // A gate scoped to the wrong paths never fires. Route changes live in
    // apps/api; the artifact lives in packages/openapi.
    const workflow = readFileSync(
      join(REPO, ".github/workflows/openapi-check.yml"),
      "utf8",
    );
    const triggers = /on:([\s\S]*?)\nconcurrency:/.exec(workflow)?.[1] ?? "";
    expect(triggers).not.toBe("");
    expect(triggers).toContain("apps/api/**");
    expect(triggers).toContain("packages/openapi/**");
  });

  it("keeps the reference pointing at the same spec the gate checks", () => {
    // /docs/api serves the spec it renders from at /api/openapi.json. If that
    // route ever read a different file, the gate would be guarding an artifact
    // nobody publishes.
    const route = readFileSync(
      join(SRC, "app/api/openapi.json/route.ts"),
      "utf8",
    );
    expect(route).toMatch(/from "@\/lib\/docs\/loadOpenAPI"/);
    const loader = readFileSync(join(SRC, "lib/docs/loadOpenAPI.ts"), "utf8");
    expect(loader).toContain("packages/openapi/openapi.json");
  });

  it("keeps surrogate-bearing schema patterns out of webpack's string serializers", () => {
    const loader = readFileSync(join(SRC, "lib/docs/loadOpenAPI.ts"), "utf8");
    const nextConfig = readFileSync(
      join(REPO, "apps/web/next.config.mjs"),
      "utf8",
    );

    expect(loader).toContain("openapi.json?base64");
    expect(loader).toContain("JSON.parse(openapiSpecSource)");
    expect(nextConfig).toMatch(/test:\s*\/openapi\\\.json\$\//);
    expect(nextConfig).toMatch(/resourceQuery:\s*\/base64\//);
    expect(nextConfig).toContain('type: "javascript/auto"');
    expect(nextConfig).toContain("scripts/openapi-base64-loader.cjs");
    const base64Loader = readFileSync(
      join(REPO, "apps/web/scripts/openapi-base64-loader.cjs"),
      "utf8",
    );
    expect(base64Loader).toContain('toString("base64")');
    expect(base64Loader).toContain("module.exports.raw = true");
  });
});
