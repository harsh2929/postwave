// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// analytics-41 — Export menu → Print / PDF. Asserted by consequence: the
// system print dialog is opened once the menu has closed (never with the menu
// still on screen), the CSV entry runs the page's own export, and the print
// stylesheet unclips the dashboard's fixed-height frame so every card prints,
// not one screenful.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ANALYTICS_PRINT_CSS,
  AnalyticsExportMenu,
} from "@/components/analytics/export-menu";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let print: ReturnType<typeof vi.fn>;

async function render(props: Parameters<typeof AnalyticsExportMenu>[0]) {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    root = createRoot(container);
    root.render(createElement(AnalyticsExportMenu, props));
  });
  return container;
}

function button(name: string): HTMLButtonElement {
  const match = [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.trim().startsWith(name),
  );
  if (!match) throw new Error(`no button ${name}`);
  return match as HTMLButtonElement;
}

async function openMenu() {
  await act(async () => {
    button("Export").click();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  print = vi.fn();
  window.print = print as unknown as typeof window.print;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("Analytics export menu (analytics-41)", () => {
  it("Print / PDF opens the system print dialog after the menu has closed", async () => {
    await render({ onExportCsv: vi.fn() });
    await openMenu();
    const menu = document.querySelector('[role="menu"]');
    expect(menu?.getAttribute("aria-label")).toBe("Export analytics");
    expect(
      [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])].map(
        (item) => item.textContent,
      ),
    ).toEqual([
      "CSV snapshotTenant-wide stats for this window",
      "Print / PDFOpens the print dialog — choose Save as PDF there",
    ]);

    await act(async () => {
      button("Print / PDF").click();
    });
    // The menu is gone before the dialog opens, so it is not what prints.
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(print).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(print).toHaveBeenCalledTimes(1);
  });

  it("CSV snapshot runs the page's export, and is disabled until stats load", async () => {
    const onExportCsv = vi.fn();
    await render({ onExportCsv, csvDisabled: true });
    await openMenu();
    expect(button("CSV snapshot").disabled).toBe(true);
    expect(button("CSV snapshot").textContent).toContain(
      "Available once the stats have loaded",
    );
    act(() => root?.unmount());
    document.body.innerHTML = "";

    await render({ onExportCsv });
    await openMenu();
    await act(async () => {
      button("CSV snapshot").click();
    });
    expect(onExportCsv).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(print).not.toHaveBeenCalled();
  });

  it("offers Print / PDF alone when the page passes no CSV export", async () => {
    await render({});
    await openMenu();
    expect(
      [...document.querySelectorAll('[role="menuitem"]')].map((i) =>
        i.textContent?.startsWith("Print / PDF"),
      ),
    ).toEqual([true]);
  });

  it("ships a print stylesheet that unclips the shell and hides its chrome", async () => {
    await render({});
    const style = document.querySelector("style");
    expect(style?.textContent).toBe(ANALYTICS_PRINT_CSS);
    const css = ANALYTICS_PRINT_CSS.replace(/\s+/g, " ");
    expect(css).toContain("@media print");
    // The frame and <main> are fixed-height + overflow-clipped on screen.
    expect(css).toMatch(
      /\[data-dashboard-hydrated\], \[data-dashboard-hydrated\] > div, #main-content \{ height: auto !important;[^}]*overflow: visible !important/,
    );
    // Sidebar, top bar and on-page controls do not print.
    expect(css).toMatch(/aside, header\[role="banner"\][^{]*\{ display: none !important; \}/);
    expect(css).toContain('#main-content [data-slot="button"]');
    expect(css).toContain("break-inside: avoid");
  });

  it("Escape closes the menu and returns focus to the trigger", async () => {
    await render({});
    await openMenu();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(button("Export"));
  });
});
