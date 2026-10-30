// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import DashboardNotFoundPage from "@/app/(dashboard)/not-found";
import MarketingNotFound from "@/app/(marketing)/not-found";
import RootNotFoundPage from "@/app/not-found";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const APP = join(process.cwd(), "src/app/(dashboard)/app");
const APP_ROOT = join(process.cwd(), "src/app");
const SCOPED_BOUNDARIES = [
  "sequence-templates/error.tsx",
  "sequences/error.tsx",
  "voice-labels/error.tsx",
  "subscribers/segments/error.tsx",
  "subscribers/duplicates/error.tsx",
] as const;

describe("route boundary contracts", () => {
  it("keeps both dashboard-level boundaries on the focus-managed recovery surface", () => {
    for (const relativePath of [
      "(dashboard)/error.tsx",
      "(dashboard)/app/error.tsx",
    ]) {
      const source = readFileSync(join(APP_ROOT, relativePath), "utf8");
      expect(source, relativePath).toContain(
        'import { RouteError } from "@/components/dashboard/route-error"',
      );
      expect(source, relativePath).toContain("export default RouteError");
    }
  });

  it("keeps every leaf boundary on the shared PII-safe recovery primitive", () => {
    for (const relativePath of SCOPED_BOUNDARIES) {
      const source = readFileSync(join(APP, relativePath), "utf8");
      expect(source, relativePath).toContain("<ScopedRouteError");
      expect(source, relativePath).not.toContain("error.message");
      expect(source, relativePath).not.toContain("console.error");
    }
  });

  it("renders the dashboard 404 with a labelled, workspace-safe destination", () => {
    const html = renderToStaticMarkup(<DashboardNotFoundPage />);

    expect(html).toContain('aria-labelledby="dashboard-not-found-title"');
    expect(html).toContain('id="dashboard-not-found-title"');
    expect(html).toContain("<section");
    expect(html).not.toContain("<main");
    expect(html).toContain('href="/app"');
    expect(html).toContain("Back to dashboard");
    expect(html).toContain("min-h-11 w-full sm:w-auto");
    expect(html).not.toContain("Request access");
  });

  it("renders both public 404 variants with labelled public-only recovery", () => {
    const root = renderToStaticMarkup(<RootNotFoundPage />);
    const marketing = renderToStaticMarkup(<MarketingNotFound />);

    for (const html of [root, marketing]) {
      expect(html).toContain('aria-labelledby="marketing-not-found-title"');
      expect(html).toContain('id="marketing-not-found-title"');
      expect(html).toContain("Back to home");
      expect(html).toContain("Browse features");
      expect(html).not.toContain("another workspace");
      expect(html).not.toContain("Back to dashboard");
    }
    expect(root).toContain('href="#not-found-main"');
    expect(root).toContain('id="not-found-main"');
  });
});
