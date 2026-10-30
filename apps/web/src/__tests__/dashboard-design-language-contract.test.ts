// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(process.cwd());
const source = (path: string): string =>
  readFileSync(resolve(ROOT, path), "utf8");

describe("authenticated Moosewave design-language contract", () => {
  it("scopes the product language above every dashboard tab and subtab", () => {
    const shell = source("src/app/(dashboard)/dashboard-shell.tsx");
    const css = source("src/app/globals.css");

    expect(shell).toContain('data-slot="dashboard-main"');
    expect(shell).toContain("mw-dashboard-main");
    expect(shell).toContain("<PageTransition>{children}</PageTransition>");
    expect(css).toContain(".mw-dashboard-main {");
    expect(css).toContain('[data-slot="dashboard-main"] h1.font-display');
    expect(css).toContain("var(--mw-paper-grid)");
  });

  it("uses one editorial header across the major route families", () => {
    const header = source("src/components/dashboard/page-header.tsx");
    const engagement = source(
      "src/app/(dashboard)/app/_engagement/engagement-ui.tsx",
    );
    const governance = source("src/components/governance/governance-ui.tsx");
    const integrations = source(
      "src/components/integrations/integrations-page-header.tsx",
    );

    expect(header).toContain('data-slot="dashboard-page-header"');
    expect(header).toContain("font-hand");
    expect(header).toContain("mw-display");
    expect(header).toContain('tone = "yellow"');
    for (const adapter of [engagement, governance, integrations]) {
      expect(adapter).toContain("<DashboardPageHeader");
      expect(adapter).not.toContain("bg-gradient-to-br");
    }
  });

  it("carries the paper, ink and collage grammar through working controls", () => {
    const files = [
      "src/components/ui/button.tsx",
      "src/components/ui/card.tsx",
      "src/components/ui/input.tsx",
      "src/components/ui/select.tsx",
      "src/components/ui/textarea.tsx",
      "src/components/ui/table.tsx",
      "src/components/ui/tabs.tsx",
      "src/components/ui/dialog.tsx",
      "src/components/ui/empty-state.tsx",
      "src/components/ui/header-menu.tsx",
    ].map(source);

    expect(files.every((file) => /mw-|rgb\(32_32_30/u.test(file))).toBe(true);
    expect(source("src/components/ui/table.tsx")).toContain(
      'data-slot="table-container"',
    );
    expect(source("src/components/ui/tabs.tsx")).toContain(
      'data-slot="tabs-list"',
    );
    expect(source("src/components/ui/dialog.tsx")).toContain(
      'data-slot="dialog-content"',
    );
  });

  it("keeps dense route interaction rules authored and payload-bounded", () => {
    const css = source("src/app/globals.css");
    const integrations = source("src/components/integrations/data-surface.tsx");
    const operations = source(
      "src/components/operations/operations-surface.tsx",
    );

    expect(css).toContain(".pw-interaction-surface a {");
    expect(css).toContain(
      ".pw-interaction-surface :is(a, button, input, select, textarea):focus-visible",
    );
    for (const surface of [integrations, operations]) {
      expect(surface).toContain('"pw-interaction-surface"');
      expect(surface).not.toContain("[&_button]:focus-visible:ring-2");
    }
  });

  it("ships only the motion primitives the interface actually uses", () => {
    const css = source("src/app/globals.css");
    const tailwind = source("tailwind.config.ts");

    for (const name of [
      "mw-dialog-overlay",
      "mw-dialog-content",
      "mw-docs-drawer-panel",
      "mw-row-enter",
      "mw-tooltip-enter",
      "mw-tour-enter",
    ]) {
      expect(css).toContain(`.${name}`);
    }
    expect(tailwind).toContain("plugins: []");
    expect(tailwind).not.toContain('from "tailwindcss-animate"');
  });

  it("keeps home freshness and actions in one named operational rail", () => {
    const overview = source("src/app/(dashboard)/app/page.tsx");
    const live = source("src/components/dashboard/dashboard-live.tsx");

    expect(overview).toContain("<DashboardPageHeader");
    expect(overview).toContain('tone="ink"');
    expect(overview).toContain("showReceipt={false}");
    expect(overview).toContain("Workspace refreshed");
    expect(overview).toContain('data-slot="dashboard-overview-tools"');
    expect(overview).not.toContain("{`Updated ${timeAgo(lastUpdated)}`}");
    expect(live).toContain('tone?: "default" | "ink"');
  });
});
