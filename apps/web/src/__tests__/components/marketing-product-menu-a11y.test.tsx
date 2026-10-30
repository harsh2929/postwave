// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { ProductMenu } from "@/components/marketing/product-menu";

afterEach(() => {
  document.body.innerHTML = "";
});

function render(ui: ReactNode): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return { container, root };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function productButton(container: ParentNode): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (el): el is HTMLButtonElement =>
      el instanceof HTMLButtonElement && el.textContent?.includes("Product"),
  );
  if (!button) throw new Error("Product button not found");
  return button;
}

function sendKey(key: string): void {
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe("marketing ProductMenu accessibility", () => {
  it("uses disclosure navigation semantics and restores focus on Escape", async () => {
    const { container, root } = render(createElement(ProductMenu));

    try {
      const trigger = productButton(container);
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(container.querySelector('[role="menu"]')).toBeNull();

      await act(async () => {
        trigger.click();
        await flush();
      });

      const nav = container.querySelector("nav");
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(nav?.id).toBe(trigger.getAttribute("aria-controls"));
      expect(nav?.getAttribute("aria-labelledby")).toBe(trigger.id);
      expect(container.querySelector('[role="menu"]')).toBeNull();
      expect(container.querySelector('[role="menuitem"]')).toBeNull();

      trigger.focus();
      await act(async () => {
        sendKey("Escape");
        await flush();
      });
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(container.querySelector("nav")).toBeNull();
      expect(document.activeElement).toBe(trigger);

      await act(async () => {
        trigger.click();
        await flush();
      });
      const migrationLink = Array.from(container.querySelectorAll("a")).find(
        (link) => link.textContent?.includes("Migration"),
      );
      expect(migrationLink).toBeTruthy();
      expect(migrationLink?.textContent).toContain("dry-run report");
      expect(migrationLink?.textContent).not.toContain("20 minutes");
      await act(async () => {
        migrationLink?.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
        await flush();
      });
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(container.querySelector("nav")).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });
});
