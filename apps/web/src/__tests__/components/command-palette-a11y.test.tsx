// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandPalette } from "@/components/command-palette";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  setTheme: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({
    resolvedTheme: "light",
    setTheme: mocks.setTheme,
  }),
}));

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

function render(ui: ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return root;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function sendKey(
  target: EventTarget,
  key: string,
  init: KeyboardEventInit = {},
): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
}

describe("CommandPalette accessibility", () => {
  it("opens from the app event and restores focus when closed", async () => {
    const root = render(
      createElement(
        "div",
        null,
        createElement("button", { type: "button" }, "Search trigger"),
        createElement(CommandPalette),
      ),
    );

    try {
      const trigger = document.querySelector("button") as HTMLButtonElement;
      trigger.focus();
      expect(document.activeElement).toBe(trigger);

      await act(async () => {
        window.dispatchEvent(new Event("pw:open-command-palette"));
        await flush();
      });

      const dialog = document.querySelector('[role="dialog"]');
      const input = document.querySelector(
        'input[placeholder="Search subscribers, segments, pages…"]',
      );
      expect(dialog).toBeTruthy();
      expect(input).toBeTruthy();
      const commandInput = input as HTMLInputElement;
      expect(document.activeElement).toBe(commandInput);

      await act(async () => {
        sendKey(commandInput, "Escape");
        await flush();
        await flush();
      });

      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("does not hijack Ctrl-K while the user is typing", async () => {
    const root = render(
      createElement(
        "div",
        null,
        createElement("input", { "aria-label": "Subject" }),
        createElement(CommandPalette),
      ),
    );

    try {
      const input = document.querySelector(
        'input[aria-label="Subject"]',
      ) as HTMLInputElement;
      input.focus();

      await act(async () => {
        sendKey(input, "k", { ctrlKey: true });
        await flush();
      });

      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(input);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("toggles closed from its own search field and restores the opener", async () => {
    const root = render(
      createElement(
        "div",
        null,
        createElement("button", { type: "button" }, "Search trigger"),
        createElement(CommandPalette),
      ),
    );

    try {
      const trigger = document.querySelector("button") as HTMLButtonElement;
      trigger.focus();
      await act(async () => {
        window.dispatchEvent(new Event("pw:open-command-palette"));
        await flush();
      });
      const input = document.querySelector(
        'input[placeholder="Search subscribers, segments, pages…"]',
      ) as HTMLInputElement;
      expect(document.activeElement).toBe(input);

      await act(async () => {
        sendKey(input, "k", { ctrlKey: true });
        await flush();
        await flush();
      });

      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not stack over an open header disclosure", async () => {
    const root = render(
      createElement(
        "div",
        null,
        createElement("button", { type: "button" }, "Create trigger"),
        createElement("div", { "data-header-menu-panel": "" }),
        createElement(CommandPalette),
      ),
    );

    try {
      const trigger = document.querySelector("button") as HTMLButtonElement;
      trigger.focus();

      await act(async () => {
        sendKey(document, "k", { ctrlKey: true });
        await flush();
      });

      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);

      document.querySelector("[data-header-menu-panel]")?.remove();
      await act(async () => {
        window.dispatchEvent(new Event("pw:open-command-palette"));
        await flush();
      });
      expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    } finally {
      act(() => root.unmount());
    }
  });
});
