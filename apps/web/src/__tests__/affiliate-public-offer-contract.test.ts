import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

describe("closed public affiliate offer", () => {
  it("keeps active dashboard routes static and operation-free", () => {
    const marketing = source("app/(marketing)/affiliates/page.tsx");
    const terms = source("app/(marketing)/legal/affiliate-terms/page.tsx");
    const changelog = source("app/(marketing)/changelog/page.tsx");
    const dashboard = source("app/(dashboard)/app/affiliates/page.tsx");
    const detail = source("app/(dashboard)/app/affiliates/[id]/page.tsx");
    const loading = source("app/(dashboard)/app/affiliates/loading.tsx");
    const unavailable = source(
      "app/(dashboard)/app/affiliates/_components/affiliate-program-unavailable.tsx",
    );
    const activeDashboard = `${dashboard}\n${detail}\n${loading}\n${unavailable}`;

    expect(dashboard).toContain("<AffiliateProgramUnavailable />");
    expect(detail).toContain("No record lookup was attempted");
    expect(activeDashboard).not.toContain("@/lib/affiliates-api");
    expect(activeDashboard).not.toContain("/api/v1/admin/affiliates");
    expect(activeDashboard).not.toContain("/api/public/affiliates");
    expect(activeDashboard).not.toContain("NewAffiliateButton");
    expect(activeDashboard).not.toContain("AffiliatesTable");
    expect(activeDashboard).not.toContain("PayoutDialog");
    expect(loading).toContain(
      'aria-label="Preparing affiliate program status"',
    );
    expect(loading).not.toContain("TableSkeleton");
    expect(loading).not.toContain("StatGridSkeleton");
    expect(activeDashboard).not.toMatch(/<form|<input|<button|onClick=/u);

    expect(marketing).toContain("Affiliate enrollment is closed");
    expect(marketing).not.toContain("mailto:");
    expect(terms).toContain("No affiliate program terms are in force");
    expect(terms).not.toContain("By submitting an application");
    expect(terms).not.toMatch(/\$\d|%\s+of|60 days|Net-30/u);

    const affiliateChangelogClaims = [
      ...changelog.matchAll(
        /"([^"]*(?:affiliate program|public signup|admin console)[^"]*)"/giu,
      ),
    ].map((match) => match[1]);
    expect(affiliateChangelogClaims).toEqual([
      "Affiliate program source prototype; public signup and admin console are release-held and not mounted in production",
    ]);
    expect(changelog).not.toContain(
      "Affiliate program backend + public signup + admin console",
    );

    const publicSurfaces = `${marketing}\n${terms}\n${changelog}`;
    expect(publicSurfaces).not.toContain("/api/public/affiliates/");
    expect(publicSurfaces).not.toContain("trackingLink(");
    expect(publicSurfaces).not.toContain("pixelLink(");
    expect(publicSurfaces).not.toMatch(/<form|<input|<button/u);
  });
});
