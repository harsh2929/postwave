// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { MCPExecution } from "../../lib/api-client";
import { ExecutionSlideover } from "../../pages/MCP";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
});

const execution = {
  id: 42,
  tenantId: "tenant-1",
  apiKeyId: "key-1",
  apiKeyPrefix: "pw_live_12",
  method: "POST",
  path: "/api/v1/campaigns",
  toolName: "campaigns_create",
  statusCode: 201,
  latencyMs: 42,
  userAgent: "postwave-mcp-server/1.0",
  remoteIp: "203.0.113.10",
  costMicros: 1_800,
  calledAt: "2026-07-17T08:00:00.000Z",
  requestBody: { name: "Launch" },
  dryRunAsserted: true,
} as MCPExecution;

function Harness(): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open execution
      </button>
      {open ? (
        <ExecutionSlideover
          execution={execution}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function render(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Harness />));
}

describe("ExecutionSlideover", () => {
  it("uses shared focus, naming, pointer dismissal, and scroll ownership", async () => {
    render();
    const trigger = document.querySelector<HTMLButtonElement>("button")!;
    trigger.focus();
    act(() => trigger.click());

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(
      document.getElementById(dialog.getAttribute("aria-labelledby")!)
        ?.textContent,
    ).toContain("campaigns_create");
    expect(
      document.getElementById(dialog.getAttribute("aria-describedby")!)
        ?.textContent,
    ).toContain("POST /api/v1/campaigns");
    expect(dialog.textContent).toContain("1 request metadata item was omitted");
    expect(dialog.textContent).not.toContain('"Launch"');
    expect(dialog.textContent).toContain("Executable replay is release-held");
    expect(dialog.textContent).not.toContain("X-Postwave-Dry-Run: 1");
    expect(dialog.textContent).not.toContain("Copy template");
    expect(dialog.textContent).toContain("API key IDkey-1");
    expect(dialog.textContent).toContain(
      "Remote IPRemoved before UI retention",
    );
    expect(dialog.textContent?.match(/1,800 micro-USD/gu)).toHaveLength(1);
    expect(dialog.querySelectorAll("[title]")).toHaveLength(0);
    expect(document.activeElement?.textContent).toBe("Copy metadata");
    expect(document.body.style.overflow).toBe("hidden");

    const result = await axe.run(dialog);
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);

    act(() => {
      document
        .querySelector<HTMLElement>(".slideover-overlay")
        ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    await act(async () => Promise.resolve());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
