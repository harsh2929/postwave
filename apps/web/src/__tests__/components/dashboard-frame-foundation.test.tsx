// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PageShell } from "@/components/dashboard/page-shell";
import { PageTransition } from "@/components/motion/page-transition";
import { PresenceIndicator } from "@/components/presence-indicator";
import { Table, TableContainer } from "@/components/ui/table";

const mocks = vi.hoisted(() => ({
  pathname: "/app",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
}));

vi.mock("@/lib/realtime/use-presence", () => ({
  usePresence: () => ({ count: 3 }),
  summarizePresence: () => ({
    others: 3,
    viewers: [
      { id: "ada", label: "Ada Lovelace" },
      { id: "grace", label: "Grace Hopper" },
    ],
  }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLElement;
  root: Root;
}

const mountedRoots: Root[] = [];

async function mount(node: ReactNode): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(node);
  });
  return { container, root };
}

afterEach(() => {
  while (mountedRoots.length > 0) {
    const root = mountedRoots.pop();
    act(() => root?.unmount());
  }
  document.body.innerHTML = "";
  mocks.pathname = "/app";
});

describe("dashboard frame foundation", () => {
  it("lets the transition and page primitives own one responsive content gutter", async () => {
    const { container } = await mount(
      createElement(
        PageTransition,
        null,
        createElement(PageShell, null, createElement("p", null, "Dashboard")),
      ),
    );

    const transition = container.querySelector('[data-slot="page-transition"]');
    const page = container.querySelector('[data-slot="page-shell"]');

    expect(transition?.classList.contains("min-h-full")).toBe(true);
    expect(transition?.classList.contains("min-w-0")).toBe(true);
    expect(page?.classList.contains("px-4")).toBe(true);
    expect(page?.classList.contains("py-5")).toBe(true);
    expect(page?.classList.contains("sm:px-6")).toBe(true);

    const css = readFileSync(
      resolve(process.cwd(), "src/app/globals.css"),
      "utf8",
    );
    expect(css).not.toContain("#main-content > div");
    expect(css).not.toContain("#main-content table");
    expect(css).not.toContain("min-width: 680px");
  });

  it("makes a table scroller keyboard-focusable and named by default", async () => {
    const { container } = await mount(
      createElement(
        TableContainer,
        null,
        createElement(Table, null, createElement("tbody")),
      ),
    );

    const region = container.querySelector('[data-slot="table-container"]');
    const table = container.querySelector("table");

    expect(region?.getAttribute("role")).toBe("region");
    expect(region?.getAttribute("tabindex")).toBe("0");
    expect(region?.getAttribute("aria-label")).toBe("Scrollable data table");
    expect(region?.classList.contains("overflow-x-auto")).toBe(true);
    expect(region?.classList.contains("focus-visible:ring-2")).toBe(true);
    expect(table?.className).not.toContain("680");

    (region as HTMLElement).focus();
    expect(document.activeElement).toBe(region);
  });

  it("lets a table scroller use the page's own heading as its name", async () => {
    const { container } = await mount(
      createElement(
        "section",
        null,
        createElement("h2", { id: "invoice-table-title" }, "Invoices"),
        createElement(
          TableContainer,
          { "aria-labelledby": "invoice-table-title" },
          createElement(Table),
        ),
      ),
    );

    const region = container.querySelector('[data-slot="table-container"]');
    expect(region?.getAttribute("aria-labelledby")).toBe("invoice-table-title");
    expect(region?.hasAttribute("aria-label")).toBe(false);
  });

  it("anchors and bounds the presence disclosure inside the viewport", async () => {
    const { container } = await mount(
      <PresenceIndicator className="header-presence" />,
    );

    const trigger = container.querySelector(
      '[data-testid="presence-indicator"]',
    ) as HTMLButtonElement | null;
    expect(trigger).toBeTruthy();
    expect(trigger?.parentElement?.classList.contains("header-presence")).toBe(
      true,
    );

    await act(async () => trigger?.click());

    const panel = container.querySelector('[role="dialog"]');
    expect(panel?.classList.contains("right-0")).toBe(true);
    expect(panel?.className).toContain("calc(100vw-1rem)");
    expect(panel?.className).toContain("calc(100dvh-4.5rem)");
    expect(panel?.classList.contains("overflow-y-auto")).toBe(true);
  });
});
