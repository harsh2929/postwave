// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { McpSetupPanel } from "@/app/(dashboard)/app/agent-tools/_components/mcp-setup-panel";
import {
  MCP_RELEASE_HOLD_CODE,
  MCP_RELEASE_STATUS_COPY,
} from "@/lib/mcp-release-status";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function renderPanel(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    root = createRoot(container);
    root.render(createElement(McpSetupPanel));
  });
  return container;
}

describe("MCP client setup release hold", () => {
  it("renders the shared authoritative status", async () => {
    const container = await renderPanel();
    expect(container.textContent).toContain(MCP_RELEASE_HOLD_CODE);
    expect(container.textContent).toContain(MCP_RELEASE_STATUS_COPY);
    expect(container.textContent).toContain("No runnable setup is emitted");
  });

  it("offers no runnable or credential-transfer controls", async () => {
    const container = await renderPanel();
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    expect(container.textContent).not.toMatch(
      /copy configuration|save configuration|API key to insert/iu,
    );
  });
});
