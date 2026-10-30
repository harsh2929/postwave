import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), "src", path), "utf8");
}

describe("DUX-009/022 overlay convergence wave 2", () => {
  it.each([
    "components/consent/ConsentReceiptDrawer.tsx",
    "components/mcp/McpExecutionDetail.tsx",
    "components/analytics/CampaignAnalyticsSlideover.tsx",
    "components/subscribers/SubscriberDetailPresentation.tsx",
  ])("routes %s through the shared slideover shell", (path) => {
    const contents = source(path);
    expect(contents).toContain("SlideoverShell");
    expect(contents).not.toContain('role="dialog"');
    expect(contents).not.toMatch(/onMouseDown=\{[^}]*onClose/);
  });

  it("keeps the Consent and MCP pages connected to their shared-shell owners", () => {
    expect(source("pages/Consent.tsx")).toContain("ConsentReceiptDrawer");
    expect(source("pages/MCP.tsx")).toContain("McpExecutionDetail");
  });

  it("keeps one subscriber dialog-stack owner and IME-safe navigation", () => {
    const owner = source("components/SubscriberDetailSlideover.tsx");
    const data = source("components/subscribers/useSubscriberDetailData.ts");
    expect(owner).not.toContain("useSlideoverBehavior");
    expect(data).toContain("event.isComposing || event.keyCode === 229");
    expect(data).toContain("detailError");
    expect(data).toContain("reloadDetail");
  });
});
