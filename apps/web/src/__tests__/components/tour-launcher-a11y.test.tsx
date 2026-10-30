// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TourLauncher } from "@/components/tour/TourLauncher";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  replay: vi.fn(),
}));

vi.mock("@/components/tour/TourProvider", () => ({
  useTour: () => ({
    state: { isOpen: false, stepIndex: 0, tourId: null },
    start: mocks.start,
    replay: mocks.replay,
    hasCompleted: false,
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

function sendKey(key: string, init: KeyboardEventInit = {}): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
}

describe("TourLauncher accessibility", () => {
  it("uses disclosure semantics and restores focus when Escape closes it", async () => {
    const root = render(createElement(TourLauncher));

    try {
      const trigger = document.querySelector(
        'button[aria-label="Open product tour menu"]',
      ) as HTMLButtonElement;
      expect(trigger).toBeTruthy();
      expect(trigger.getAttribute("aria-expanded")).toBe("false");

      await act(async () => {
        trigger.click();
        await flush();
      });

      const panel = document.querySelector('[data-testid="command-launcher"]');
      expect(panel).toBeTruthy();
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(trigger.getAttribute("aria-controls")).toBe(panel?.id);
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(document.querySelector('[role="menuitem"]')).toBeNull();

      trigger.focus();
      await act(async () => {
        sendKey("Escape");
        await flush();
      });

      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(document.querySelector('[data-testid="command-launcher"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("moves focus into the keyboard shortcuts dialog", async () => {
    const root = render(createElement(TourLauncher));

    try {
      const trigger = document.querySelector(
        'button[aria-label="Open product tour menu"]',
      ) as HTMLButtonElement;

      await act(async () => {
        trigger.click();
        await flush();
      });

      const shortcuts = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Keyboard shortcuts"),
      );
      expect(shortcuts).toBeTruthy();

      await act(async () => {
        shortcuts?.click();
        await flush();
      });

      const dialog = document.querySelector('[role="dialog"]');
      const close = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Got it"),
      );
      expect(dialog).toBeTruthy();
      expect(close).toBeTruthy();
      expect(document.activeElement).toBe(close);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });
});
