// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { DEVELOPER_INSTALL_TABS } from "@/app/(marketing)/developers/install-tabs-data";
import { InstallTabs } from "@/components/marketing/install-tabs";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function render(ui: ReactNode): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return { container, root };
}

function tabs(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  );
}

async function press(target: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("public developer install variants", () => {
  it("holds the server-rendered controls inert until their handlers hydrate", () => {
    const shell = document.createElement("div");
    shell.innerHTML = renderToString(
      createElement(InstallTabs, { tabs: DEVELOPER_INSTALL_TABS }),
    );
    const island = shell.firstElementChild;
    expect(island?.getAttribute("data-install-tabs-hydrated")).toBe("false");
    expect(island?.getAttribute("aria-busy")).toBe("true");
    expect(island?.hasAttribute("inert")).toBe(true);
  });

  it("renders and selects all six published package snippets truthfully", async () => {
    expect(DEVELOPER_INSTALL_TABS).toEqual([
      expect.objectContaining({
        label: "npm",
        snippet: "npm install @postwave/sdk",
      }),
      expect.objectContaining({
        label: "pnpm",
        snippet: "pnpm add @postwave/sdk",
      }),
      expect.objectContaining({
        label: "Browser events",
        snippet: "npm install @postwave/track",
      }),
      expect.objectContaining({
        label: "pip",
        snippet: "pip install postwave",
      }),
      expect.objectContaining({
        label: "Composer",
        snippet: "composer require postwave/postwave-php",
      }),
      expect.objectContaining({
        label: "CLI",
        snippet: "npm install -g @postwave/cli",
      }),
    ]);

    const { container, root } = render(
      createElement(InstallTabs, { tabs: DEVELOPER_INSTALL_TABS }),
    );
    try {
      expect(
        container.firstElementChild?.getAttribute("data-install-tabs-hydrated"),
      ).toBe("true");
      expect(container.firstElementChild?.hasAttribute("inert")).toBe(false);
      const controls = tabs(container);
      expect(controls).toHaveLength(6);
      expect(
        container
          .querySelector('[role="tablist"]')
          ?.getAttribute("aria-orientation"),
      ).toBe("horizontal");

      for (const [index, expected] of DEVELOPER_INSTALL_TABS.entries()) {
        await act(async () => controls[index]?.click());
        const selected = controls.filter(
          (control) => control.getAttribute("aria-selected") === "true",
        );
        expect(selected).toEqual([controls[index]]);
        expect(controls.map((control) => control.tabIndex)).toEqual(
          controls.map((_, candidate) => (candidate === index ? 0 : -1)),
        );

        const panel = container.querySelector<HTMLElement>('[role="tabpanel"]');
        expect(controls[index]?.getAttribute("aria-controls")).toBe(panel?.id);
        expect(panel?.getAttribute("aria-labelledby")).toBe(
          controls[index]?.id,
        );
        expect(panel?.textContent).toContain(expected.snippet);
        expect(
          panel?.querySelector("code")?.getAttribute("data-language"),
        ).toBe(expected.language);
      }

      for (const control of controls) {
        expect(control.className).toContain("min-h-11");
        expect(control.className).toContain("motion-reduce:transition-none");
      }
      expect(container.firstElementChild?.className).toContain("min-w-0");
      expect(container.querySelector("pre")?.className).toContain("pr-28");
    } finally {
      act(() => root.unmount());
    }
  });

  it("supports wrapped arrows plus Home/End with one roving tab stop", async () => {
    const { container, root } = render(
      createElement(InstallTabs, { tabs: DEVELOPER_INSTALL_TABS }),
    );
    try {
      const controls = tabs(container);
      controls[0]?.focus();

      await press(controls[0]!, "ArrowLeft");
      expect(document.activeElement).toBe(controls[5]);
      expect(controls[5]?.getAttribute("aria-selected")).toBe("true");

      await press(controls[5]!, "Home");
      expect(document.activeElement).toBe(controls[0]);

      await press(controls[0]!, "End");
      expect(document.activeElement).toBe(controls[5]);

      await press(controls[5]!, "ArrowRight");
      expect(document.activeElement).toBe(controls[0]);
    } finally {
      act(() => root.unmount());
    }
  });

  it("uses unique relationships per instance and fails closed for no variants", () => {
    const { container, root } = render(
      createElement(
        "div",
        null,
        createElement(InstallTabs, { tabs: DEVELOPER_INSTALL_TABS }),
        createElement(InstallTabs, { tabs: DEVELOPER_INSTALL_TABS }),
        createElement(InstallTabs, { tabs: [] }),
      ),
    );
    try {
      const ids = Array.from(
        container.querySelectorAll("[id]"),
        (node) => node.id,
      );
      expect(new Set(ids).size).toBe(ids.length);
      expect(container.querySelector('[role="status"]')?.textContent).toContain(
        "No install snippets are available",
      );
    } finally {
      act(() => root.unmount());
    }
  });
});
