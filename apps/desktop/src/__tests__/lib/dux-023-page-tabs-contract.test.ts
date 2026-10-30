import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const MANUAL_TAB_PAGES = [
  "pages/Agency.tsx",
  "pages/APIPlayground.tsx",
  "pages/Helpdesk.tsx",
  "pages/InboundRoutes.tsx",
  "pages/MCP.tsx",
  "pages/PostwaveAI.tsx",
  "pages/Reviews.tsx",
  "pages/SMSInbox.tsx",
  "pages/WebhooksHome.tsx",
] as const;

function source(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), "utf8");
}

describe("DUX-023 manual page tab migration", () => {
  for (const relativePath of MANUAL_TAB_PAGES) {
    it(`${relativePath} uses the qualified manual tab contract`, () => {
      const contents = source(relativePath);
      expect(contents).toContain("useTabsInteraction");
      expect(contents).toContain('activation: "manual"');
      expect(contents).toContain(".listProps");
      expect(contents).toContain(".getTabProps(");
      expect(contents).toContain(".getPanelProps(");
      expect(contents).not.toMatch(/role=["']tab(?:list|panel)?["']/u);
    });
  }

  it("keeps the already-loaded API response tabs automatic", () => {
    const contents = source("pages/APIPlayground.tsx");
    const responseTabs = contents.slice(
      contents.indexOf("export function ResponseTabs"),
      contents.indexOf("/* ---------- main page"),
    );
    expect(responseTabs).toContain('activation: "automatic"');
  });
});
