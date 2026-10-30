// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), "src", relativePath), "utf8");

describe("flow authoring does not imply release-held execution", () => {
  it("keeps publication, preview, history, and archive copy configuration-only", () => {
    const files = [
      "lib/flows-api.ts",
      "app/(dashboard)/app/flows/page.tsx",
      "app/(dashboard)/app/flows/_components/flow-editor.tsx",
      "app/(dashboard)/app/flows/_components/node-config-panel.tsx",
      "app/(dashboard)/app/flows/_components/flow-list-card.tsx",
      "app/(dashboard)/app/flows/_components/flow-runs-panel.tsx",
      "app/(dashboard)/app/flows/_components/flow-journey-preview.tsx",
    ].map(source);
    const combined = files.join("\n");

    for (const falseClaim of [
      "changes are now live",
      "running journey",
      "Live · published",
      "Subscribers who enter this flow appear here",
      "Enrolled subscribers stop advancing",
      "Winner selection runs server-side once the evaluation window closes",
    ]) {
      expect(combined).not.toContain(falseClaim);
    }

    expect(combined).toContain(
      "Configuration published — execution remains release-held",
    );
    expect(combined).toMatch(
      /Enrollment, scheduling, and delivery are\s+release-held in this build/u,
    );
    expect(combined).toContain(
      "saving this node does not select or promote a variant",
    );
    expect(combined).toContain(
      "Historical per-subscriber records only",
    );
  });
});
