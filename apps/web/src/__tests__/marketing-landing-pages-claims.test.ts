// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SRC = path.join(process.cwd(), "src");

function readSource(...parts: string[]): string {
  return readFileSync(path.join(SRC, ...parts), "utf8");
}

const MARKETING_FILES = [
  ["app", "(marketing)", "landing-pages", "page.tsx"],
  ["app", "(marketing)", "landing-pages", "opengraph-image.tsx"],
  ["app", "(marketing)", "forms", "page.tsx"],
  ["app", "(marketing)", "forms", "opengraph-image.tsx"],
  ["app", "(marketing)", "page.tsx"],
  ["app", "(marketing)", "features", "page.tsx"],
  ["app", "(marketing)", "roadmap", "page.tsx"],
  ["components", "marketing", "product-menu.tsx"],
];

const STALE_LANDING_PAGE_CLAIMS = [
  "Shipped and live now",
  "Both shipped",
  "block-based landing page builder",
  "Block builder on your own domain",
  "the landing page builder is on every paid plan",
  "Use the landing page builder",
  "Publish a page. Watch it convert.",
];

describe("marketing landing-page claims", () => {
  it("does not promise unavailable landing-page editor capabilities", () => {
    const sources = MARKETING_FILES.map((file) => readSource(...file)).join(
      "\n",
    );

    for (const staleClaim of STALE_LANDING_PAGE_CLAIMS) {
      expect(sources).not.toContain(staleClaim);
    }
  });

  it("keeps unavailable editor controls out of the dashboard", () => {
    const marketingLandingPage = readSource(
      "app",
      "(marketing)",
      "landing-pages",
      "page.tsx",
    );
    const dashboardLandingPages = readSource(
      "app",
      "(dashboard)",
      "app",
      "landing-pages",
      "page.tsx",
    );

    expect(marketingLandingPage).toContain(
      "The block editor, custom domains, SEO controls, and page metrics are being staged",
    );
    expect(dashboardLandingPages).not.toContain("editor coming soon");
    expect(dashboardLandingPages).not.toContain("/app/landing-pages/[id]");
  });
});
