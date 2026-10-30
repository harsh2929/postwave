// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canNavigateWithUnsavedChanges,
  useUnsavedChangesGuard,
} from "@/lib/use-unsaved-changes-guard";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Guard({ dirty }: { dirty: boolean }) {
  useUnsavedChangesGuard(dirty);
  return null;
}

function renderGuard(dirty: boolean): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(createElement(Guard, { dirty })));
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("useUnsavedChangesGuard", () => {
  it("blocks programmatic App Router navigation when the user cancels", () => {
    const confirm = vi.fn(() => false);
    Object.defineProperty(window, "confirm", {
      configurable: true,
      value: confirm,
    });
    const root = renderGuard(true);
    try {
      expect(canNavigateWithUnsavedChanges()).toBe(false);
      expect(confirm).toHaveBeenCalledOnce();
    } finally {
      act(() => root.unmount());
    }
  });

  it("intercepts same-origin links but leaves external links alone", () => {
    const confirm = vi.fn(() => false);
    Object.defineProperty(window, "confirm", {
      configurable: true,
      value: confirm,
    });
    const root = renderGuard(true);
    try {
      const internal = document.createElement("a");
      internal.href = "/app/campaigns";
      document.body.append(internal);
      const internalClick = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      });
      internal.dispatchEvent(internalClick);
      expect(internalClick.defaultPrevented).toBe(true);

      const external = document.createElement("a");
      external.href = "https://example.org/";
      document.body.append(external);
      const externalClick = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      });
      external.dispatchEvent(externalClick);
      expect(externalClick.defaultPrevented).toBe(false);
      expect(confirm).toHaveBeenCalledOnce();
    } finally {
      act(() => root.unmount());
    }
  });

  it("restores browser history when a back navigation is cancelled", () => {
    Object.defineProperty(window, "confirm", {
      configurable: true,
      value: vi.fn(() => false),
    });
    const forward = vi
      .spyOn(window.history, "forward")
      .mockImplementation(() => {});
    const root = renderGuard(true);
    try {
      window.dispatchEvent(new PopStateEvent("popstate"));
      expect(forward).toHaveBeenCalledOnce();
    } finally {
      act(() => root.unmount());
    }
  });

  it("allows in-app navigation when the editor is clean", () => {
    const confirm = vi.fn(() => true);
    Object.defineProperty(window, "confirm", {
      configurable: true,
      value: confirm,
    });
    const root = renderGuard(false);
    try {
      expect(canNavigateWithUnsavedChanges()).toBe(true);
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});
