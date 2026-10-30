import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = process.cwd();
const source = (relativePath: string) =>
  readFileSync(join(webRoot, relativePath), "utf8");

describe("public release UX contract", () => {
  it("does not auto-open the marketing tour during first-load performance runs", () => {
    const layout = source("src/app/(marketing)/layout.tsx");
    expect(layout).toContain(
      '<TourProvider tour="marketing" autoStart={false}>',
    );
  });

  it("keeps low-contrast opacity variants out of pricing copy", () => {
    const home = source("src/app/(marketing)/page.tsx");
    const pricing = source("src/app/(marketing)/pricing/page.tsx");
    expect(home).not.toContain("text-pw-ink2/40");
    expect(pricing).not.toContain("text-pw-muted-on-paper/70");
    expect(pricing).not.toContain("text-pw-ink2/40");
    expect(pricing).not.toContain(': "text-pw-muted-on-ink"');
  });

  it("gives docs links distinct accessible names and login a main target", () => {
    const sidebar = source("src/components/docs/Sidebar.tsx");
    const login = source("src/app/login/page.tsx");
    const authShell = source("src/components/auth/auth-shell.tsx");
    expect(sidebar).toContain('label="API overview"');
    // Login (and every card auth page) renders through the shared AuthShell,
    // which owns the <main> landmark + skip link for the whole cluster
    // (AUTH-006/007/008). The guarantee — login has a main target reachable via
    // a skip link — is preserved, just centralised.
    expect(login).toContain("<AuthShell");
    expect(authShell).toContain("<main");
    expect(authShell).toContain('id="auth-main"');
    expect(authShell).toContain('href="#auth-main"');
  });

  it("keeps the footer contact label in its accessible name", () => {
    const layout = source("src/app/(marketing)/layout.tsx");
    expect(layout).toContain('aria-label="Contact Moosewave"');
    expect(layout).not.toContain('aria-label="Email Moosewave"');
  });

  it("keeps unreviewed legal and comparison copy unreachable", () => {
    const legalLayout = source("src/app/(marketing)/legal/layout.tsx");
    const comparisonLayout = source("src/app/(marketing)/vs/layout.tsx");
    for (const layout of [legalLayout, comparisonLayout]) {
      expect(layout).toContain("notFound()");
      expect(layout).toContain("index: false");
      expect(layout).toContain("follow: false");
    }
  });
});
