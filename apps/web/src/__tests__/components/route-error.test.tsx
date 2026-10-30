// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RouteError } from "@/components/dashboard/route-error";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  captureClientBoundaryError: vi.fn(),
}));

vi.mock("@/lib/client-error-reporting", () => ({
  captureClientBoundaryError: mocks.captureClientBoundaryError,
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
    [key: string]: unknown;
  }) => createElement("a", { href, ...props }, children),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function render(ui: React.ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return root;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

describe("RouteError", () => {
  it("reports the boundary error without exposing raw error text", async () => {
    const reset = vi.fn();
    const error = Object.assign(
      new Error("Subscriber alice@example.com could not be loaded"),
      { digest: "digest-123" },
    );
    const root = render(createElement(RouteError, { error, reset }));

    try {
      await act(async () => {
        await flush();
      });

      expect(mocks.captureClientBoundaryError).toHaveBeenCalledWith(error);
      expect(document.body.textContent).toContain("Could not load this view");
      expect(document.body.textContent).toContain("digest-123");
      expect(document.body.textContent).not.toContain("alice@example.com");
      expect(document.body.textContent).not.toContain("could not be loaded");
      expect(document.activeElement).toBe(
        document.querySelector('[role="alert"]'),
      );
      expect(document.querySelectorAll("h1")).toHaveLength(1);
      expect(
        document
          .querySelector('[role="alert"]')
          ?.getAttribute("aria-labelledby"),
      ).toBe(document.querySelector("h1")?.id);
      expect(document.querySelector('a[href="/app"]')?.textContent).toContain(
        "Back to dashboard",
      );
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("runs the provided reset action from the retry button", async () => {
    const reset = vi.fn();
    const error = Object.assign(new Error("Network failed"), {
      digest: "digest-456",
    });
    const root = render(createElement(RouteError, { error, reset }));

    try {
      const retry = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Retry"),
      );
      expect(retry).toBeTruthy();

      await act(async () => {
        retry?.click();
        retry?.click();
        await flush();
      });

      expect(reset).toHaveBeenCalledTimes(1);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it.each([
    Object.assign(new Error("A page module is unavailable"), {
      name: "ChunkLoadError",
    }),
    new Error("Loading chunk subscriber-panels failed.\n(error: /chunk.js)"),
    new Error("Loading CSS chunk dashboard failed."),
  ])(
    "reloads stale page files only after the user requests recovery: %s",
    async (error) => {
      const reset = vi.fn();
      const reload = vi
        .spyOn(window.location, "reload")
        .mockImplementation(() => {});
      const root = render(createElement(RouteError, { error, reset }));

      try {
        expect(reload).not.toHaveBeenCalled();
        const recovery = Array.from(document.querySelectorAll("button")).find(
          (button) => button.textContent?.includes("Reload view"),
        );
        expect(recovery).toBeTruthy();
        await act(async () => {
          recovery?.click();
          recovery?.click();
          await flush();
        });
        expect(reload).toHaveBeenCalledTimes(1);
        expect(reset).not.toHaveBeenCalled();
      } finally {
        act(() => root.unmount());
      }
    },
  );
});
