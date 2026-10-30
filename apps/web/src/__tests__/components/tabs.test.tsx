// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

let mountedRoot: Root | null = null;

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  document.body.innerHTML = "";
});

function render(ui: ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  mountedRoot = createRoot(container);
  act(() => mountedRoot?.render(ui));
  return container;
}

async function press(target: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function exampleTabs(): ReactNode {
  return createElement(
    Tabs,
    { defaultValue: "overview" },
    createElement(
      TabsList,
      { "aria-label": "Example sections" },
      createElement(TabsTrigger, { value: "overview" }, "Overview"),
      createElement(
        TabsTrigger,
        { value: "audience" },
        "A very long audience label",
      ),
      createElement(TabsTrigger, { value: "delivery" }, "Delivery"),
    ),
    createElement(TabsContent, { value: "overview" }, "Overview panel"),
    createElement(TabsContent, { value: "audience" }, "Audience panel"),
    createElement(TabsContent, { value: "delivery" }, "Delivery panel"),
  );
}

describe("shared tabs", () => {
  it("names the tablist and keeps narrow-screen tabs scrollable with 44px targets", () => {
    const container = render(exampleTabs());
    const list = container.querySelector<HTMLElement>('[role="tablist"]');
    const trigger = container.querySelector<HTMLElement>('[role="tab"]');

    expect(list?.getAttribute("aria-label")).toBe("Example sections");
    expect(list?.className).toContain("w-full");
    expect(list?.className).toContain("max-w-full");
    expect(list?.className).toContain("overflow-x-auto");
    expect(list?.className).toContain("touch-pan-x");
    expect(trigger?.className).toContain("min-h-11");
    expect(trigger?.className).toContain("min-w-11");
    expect(trigger?.className).toContain("shrink-0");
    expect(trigger?.className).toContain("sm:min-h-9");
    expect(trigger?.className).toContain("[@media(pointer:coarse)]:min-h-11");
  });

  it("moves selection and focus with arrows, Home, and End", async () => {
    const container = render(exampleTabs());
    const triggers = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    const list = container.querySelector<HTMLElement>('[role="tablist"]');

    // Radix places the composite itself in the page tab order, then redirects
    // entry focus to the selected item. Once inside, exactly one trigger owns
    // the roving stop.
    expect(list?.tabIndex).toBe(0);
    expect(triggers.map((trigger) => trigger.tabIndex)).toEqual([-1, -1, -1]);
    await act(async () => {
      triggers[0].focus();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(triggers.map((trigger) => trigger.tabIndex)).toEqual([0, -1, -1]);

    await press(triggers[0], "ArrowRight");
    expect(document.activeElement).toBe(triggers[1]);
    expect(triggers[1].getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain("Audience panel");
    expect(container.textContent).not.toContain("Overview panel");

    await press(triggers[1], "End");
    expect(document.activeElement).toBe(triggers[2]);
    expect(triggers[2].getAttribute("aria-selected")).toBe("true");

    await press(triggers[2], "Home");
    expect(document.activeElement).toBe(triggers[0]);
    expect(triggers[0].getAttribute("aria-selected")).toBe("true");

    await press(triggers[0], "ArrowLeft");
    expect(document.activeElement).toBe(triggers[2]);
    expect(triggers[2].getAttribute("aria-selected")).toBe("true");
  });
});
