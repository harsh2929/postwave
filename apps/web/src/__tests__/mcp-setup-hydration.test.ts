// SPDX-License-Identifier: AGPL-3.0-only
//
// Release-held setup is deliberately static. It must remain safe to render on
// the server and must not grow a browser-only credential/configuration path
// that can diverge at hydration time.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { McpSetupPanel } from "@/app/(dashboard)/app/agent-tools/_components/mcp-setup-panel";
import { MCP_RELEASE_HOLD_CODE } from "@/lib/mcp-release-status";

const SOURCE = readFileSync(
  resolve(
    process.cwd(),
    "src/app/(dashboard)/app/agent-tools/_components/mcp-setup-panel.tsx",
  ),
  "utf8",
);

describe("MCP setup hydration boundary", () => {
  it("renders the held status during server rendering", () => {
    const html = renderToStaticMarkup(createElement(McpSetupPanel));
    expect(html).toContain(MCP_RELEASE_HOLD_CODE);
    expect(html).toContain("No runnable setup is emitted");
  });

  it("has no browser-only render input or credential transfer path", () => {
    expect(SOURCE).not.toMatch(/window\.|localStorage\.|navigator\./u);
    expect(SOURCE).not.toMatch(
      /<Input|<Button|copyToClipboard|downloadTextFile/iu,
    );
    expect(SOURCE).toContain("MCP_RELEASE_HOLD_CODE");
  });
});
