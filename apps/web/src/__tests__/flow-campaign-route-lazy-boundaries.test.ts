// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), "src", relativePath), "utf8");

describe("flow and campaign route lazy boundaries", () => {
  it("keeps the flow editor implementation out of the detail route entry", () => {
    const page = source("app/(dashboard)/app/flows/[id]/page.tsx");

    expect(page).not.toContain(
      'import { FlowEditor } from "../_components/flow-editor"',
    );
    expect(page).toContain('import("../_components/flow-editor")');
    expect(page).toContain("ssr: false");
    expect(page).toContain('aria-label="Loading flow editor"');
  });

  it("keeps inactive flow rails and resource clients out of the editor's initial graph", () => {
    const editor = source(
      "app/(dashboard)/app/flows/_components/flow-editor.tsx",
    );
    const pickerConfig = source(
      "app/(dashboard)/app/flows/_components/entity-picker-config.ts",
    );

    for (const modulePath of [
      "./entity-picker",
      "./node-config-panel",
      "./version-history",
      "./flow-runs-panel",
    ]) {
      expect(editor).not.toMatch(
        new RegExp(`^import .*from ["']${modulePath}["'];$`, "m"),
      );
      expect(editor).toContain(`import("${modulePath}")`);
    }

    expect(editor).toContain("showVersions ?");
    expect(editor).toContain(": showRuns ?");
    expect(editor).toContain(": selectedNode ?");
    expect(editor).toContain('role="status"');
    expect(editor).toContain('aria-live="polite"');

    expect(pickerConfig).toContain("PICKABLE_FIELDS");
    expect(pickerConfig).not.toMatch(/@\/lib\/.*-api/);
  });

  it("loads automation configuration panels per tab and retains activated drafts", () => {
    const client = source(
      "app/(dashboard)/app/flows/configuration/automation-configuration-client.tsx",
    );

    for (const modulePath of [
      "./zero-copy-drafts-panel",
      "./trigger-delay-panel",
    ]) {
      expect(client).not.toMatch(
        new RegExp(`^import .*from ["']${modulePath}["'];$`, "m"),
      );
      expect(client).toContain(`import("${modulePath}")`);
    }
    expect(client).toContain("timingActivated ?");
    expect(client).toContain("forceMount");
    expect(client).toContain('role="status"');
    expect(client).toContain('aria-live="polite"');
  });

  it("loads only the qualified send dialog after its explicit action opens", () => {
    const list = source("app/(dashboard)/app/campaigns/campaigns-client.tsx");
    const detail = source(
      "app/(dashboard)/app/campaigns/[id]/campaign-detail-client.tsx",
    );
    const selected = source(
      "app/(dashboard)/app/campaigns/selected-campaign-actions.tsx",
    );

    for (const page of [list, detail]) {
      expect(page).not.toContain("CampaignScheduleDialog");
      expect(page).not.toContain("scheduleOpen");
      expect(page).toContain("sendOpen ?");
      expect(page).toContain('role="status"');
    }
    expect(list).toContain("SelectedCampaignActions");
    expect(selected).toContain("Scheduling unavailable");
    expect(detail).toContain("Scheduling unavailable");
    expect(list.match(/import\("\.\/campaign-send-dialogs"\)/g)).toHaveLength(
      1,
    );
    expect(
      detail.match(/import\("\.\.\/campaign-send-dialogs"\)/g),
    ).toHaveLength(1);
  });

  it("keeps campaign clients behind lightweight route loaders", () => {
    const boundaries = [
      {
        page: "app/(dashboard)/app/campaigns/page.tsx",
        loader: "app/(dashboard)/app/campaigns/campaigns-client-loader.tsx",
        implementation: "./campaigns-client",
      },
      {
        page: "app/(dashboard)/app/campaigns/[id]/page.tsx",
        loader:
          "app/(dashboard)/app/campaigns/[id]/campaign-detail-client-loader.tsx",
        implementation: "./campaign-detail-client",
      },
      {
        page: "app/(dashboard)/app/campaigns/[id]/ab/page.tsx",
        loader:
          "app/(dashboard)/app/campaigns/[id]/ab/campaign-ab-client-loader.tsx",
        implementation: "./campaign-ab-client",
      },
      {
        page: "app/(dashboard)/app/campaigns/[id]/ab-results/page.tsx",
        loader:
          "app/(dashboard)/app/campaigns/[id]/ab-results/campaign-ab-results-client-loader.tsx",
        implementation: "./campaign-ab-results-client",
      },
    ] as const;

    for (const boundary of boundaries) {
      const page = source(boundary.page);
      const loader = source(boundary.loader);
      expect(page).not.toContain(`from "${boundary.implementation}"`);
      expect(loader).toContain(`import("${boundary.implementation}")`);
      expect(loader).toContain("ssr: false");
      expect(loader).toContain('role="status"');
      expect(loader).toContain('aria-live="polite"');
    }
  });
});
