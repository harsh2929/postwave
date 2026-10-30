// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SearchBar } from "@/components/docs/SearchBar";
import type { SearchIndex } from "@/lib/docs/search";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

const index: SearchIndex = {
  docs: [
    {
      id: 1,
      title: "Getting started",
      url: "/docs/getting-started",
      section: "Guides",
      body: "Connect a sending domain and import subscribers.",
    },
  ],
  postings: {
    getting: [1],
    started: [1],
    guide: [1],
  },
};

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

function sendKey(target: EventTarget, key: string, init: KeyboardEventInit = {}): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
}

describe("docs SearchBar accessibility", () => {
  it("focuses the query on open, traps Tab, and restores focus on Escape", async () => {
    const root = render(createElement(SearchBar, { index }));

    try {
      const trigger = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Search docs"),
      ) as HTMLButtonElement;
      trigger.focus();

      await act(async () => {
        trigger.click();
        await flush();
      });

      const dialog = document.querySelector('[role="dialog"]');
      const input = document.querySelector(
        'input[aria-label="Search query"]',
      ) as HTMLInputElement;
      expect(dialog).toBeTruthy();
      expect(document.activeElement).toBe(input);

      await act(async () => {
        sendKey(input, "Tab");
        await flush();
      });
      expect(document.activeElement).toBe(input);

      await act(async () => {
        sendKey(input, "Escape");
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

  it("does not open from Ctrl-K while another input is focused", async () => {
    const root = render(
      createElement(
        "div",
        null,
        createElement("input", { "aria-label": "Filter docs" }),
        createElement(SearchBar, { index }),
      ),
    );

    try {
      const input = document.querySelector(
        'input[aria-label="Filter docs"]',
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
});
