// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  clear: vi.fn(),
  readText: vi.fn(),
  writeText: vi.fn(),
}));
vi.mock("../../lib/tauri", () => ({ isTauri: () => false }));

import { CopyButton } from "../../components/playground/Copy";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function render(node: ReactElement): HTMLButtonElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  const button = document.querySelector<HTMLButtonElement>("button");
  if (!button) throw new Error("copy button not rendered");
  return button;
}

describe("Playground CopyButton clipboard feedback", () => {
  it("awaits success, changes the visible label, and announces it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const button = render(<CopyButton value="response" label="Response" />);

    await act(async () => {
      button.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith("response");
    expect(button.textContent).toContain("Copied");
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "Response copied.",
    );
  });

  it("makes a denied write visible and accessible without claiming success", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: vi
          .fn()
          .mockRejectedValue(new DOMException("denied", "NotAllowedError")),
      },
      configurable: true,
    });
    const button = render(<CopyButton value="response" label="Response" />);

    await act(async () => {
      button.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(button.textContent).toContain("Copy failed");
    expect(button.getAttribute("aria-label")).toContain("copy failed");
    expect(
      document.querySelector('[aria-live="polite"]')?.textContent,
    ).toContain("wasn't copied");
  });
});
