import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const MARKETING = join(SRC, "app", "(marketing)");

function source(path: string): string {
  return readFileSync(join(SRC, path), "utf8");
}

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, files);
    else files.push(path);
  }
  return files;
}

const EXPECTED_ROUTE_TEMPLATES = [
  "/",
  "/about",
  "/accessibility",
  "/affiliates",
  "/analytics",
  "/api-docs",
  "/audiences",
  "/automations",
  "/blog",
  "/blog/[slug]",
  "/blog/author/[author]",
  "/blog/tag/[tag]",
  "/changelog",
  "/commerce",
  "/customers",
  "/deliverability",
  "/developers",
  "/docs",
  "/features",
  "/forms",
  "/integrations",
  "/integrations/[slug]",
  "/landing-pages",
  "/legal/account-deletion",
  "/legal/affiliate-terms",
  "/legal/aup",
  "/legal/cookies",
  "/legal/dpa",
  "/legal/dpia",
  "/legal/privacy",
  "/legal/refund",
  "/legal/report-content",
  "/legal/sub-processors",
  "/legal/terms",
  "/legal/tom",
  "/mcp",
  "/migrate-anywhere",
  "/migrations",
  "/migrations/[from]",
  "/podcasts",
  "/pricing",
  "/pricing/success",
  "/roadmap",
  "/security",
  "/sms",
  "/voice",
  "/vs",
  "/vs/beehiiv",
  "/vs/convertkit",
  "/vs/mailchimp",
  "/vs/mailerlite",
  "/vs/sendy",
  "/vs/substack",
];

describe("marketing surface foundation", () => {
  it("keeps the route inventory explicit so every new page enters the browser matrix", () => {
    const routes = walk(MARKETING)
      .filter((path) => path.endsWith("/page.tsx"))
      .map((path) => {
        const route = `/${relative(MARKETING, path).replace(/(^|\/)page\.tsx$/, "")}`;
        return route === "/" ? route : route.replace(/\/$/, "");
      })
      .sort();
    expect(routes).toEqual([...EXPECTED_ROUTE_TEMPLATES].sort());
  });

  it("owns exactly one main landmark through the shared layout", () => {
    const layout = source("app/(marketing)/layout.tsx");
    expect(layout.match(/<main\b/g)).toHaveLength(1);
    const nestedMains = walk(MARKETING)
      .filter((path) => path.endsWith(".tsx") && !path.endsWith("/layout.tsx"))
      .filter((path) => /<main\b/.test(readFileSync(path, "utf8")))
      .map((path) => relative(MARKETING, path));
    expect(nestedMains).toEqual([]);
  });

  it("uses mobile viewport units and a fixed-light browser chrome policy", () => {
    const layout = source("app/(marketing)/layout.tsx");
    expect(layout).toContain("min-h-dvh");
    expect(layout).not.toContain("min-h-screen");
    expect(layout).toContain('colorScheme: "light"');
    expect(layout).toContain('themeColor: "#FDFCF8"');
  });

  it("bounds both navigation overlays and preserves 44px phone targets", () => {
    const layout = source("app/(marketing)/layout.tsx");
    const mobile = source("components/marketing/mobile-nav.tsx");
    const product = source("components/marketing/product-menu.tsx");
    const cookie = source("components/marketing/cookie-banner.tsx");

    expect(layout).toContain("gap-3 px-4");
    expect(layout).toContain("min-h-11 shrink-0");
    expect(mobile).toContain("h-11 w-11");
    expect(mobile.match(/min-h-11/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(product).toContain("w-[min(calc(100vw_-_2rem),52rem)]");
    expect(product).toContain("max-h-[calc(100dvh-4.25rem)]");
    expect(product).toContain("overflow-y-auto");
    expect(cookie).toContain("max-h-[calc(100dvh-6rem)]");
    expect(cookie).toContain("overflow-y-auto");
  });

  it("keeps the API reference lightweight and inline reference links visually distinct", () => {
    const apiPreview = source(
      "app/(marketing)/api-docs/_components/api-reference-preview.tsx",
    );
    const integration = source("app/(marketing)/integrations/[slug]/page.tsx");

    expect(apiPreview).not.toContain('"use client"');
    expect(apiPreview).not.toContain('import("redoc")');
    expect(apiPreview).toContain("Browse published API operations");
    expect(integration).toContain(
      "underline decoration-pw-ember-500/70 underline-offset-2",
    );
  });

  it("keeps the marketing not-found recovery links phone-sized and overflow-safe", () => {
    const notFound = source("components/marketing/not-found-content.tsx");

    expect(notFound.match(/min-h-11/g)).toHaveLength(3);
    expect(notFound).toContain("[overflow-wrap:anywhere]");
    expect(notFound.match(/focus-visible:ring-2/g)).toHaveLength(3);
  });
});
