// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import AppError from "@/app/error";

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

function render(ui: ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return root;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("app error boundary", () => {
  it("focuses a PII-safe alert with contained recovery destinations", async () => {
    const error = Object.assign(
      new Error("Workspace owner@example.test could not be loaded"),
      { digest: `digest-${"z".repeat(2_000)}` },
    );
    const root = render(createElement(AppError, { error, reset: vi.fn() }));

    try {
      await flush();
      const alert = document.querySelector<HTMLElement>('[role="alert"]');
      const retry = document.querySelector<HTMLButtonElement>("button");
      const home = document.querySelector<HTMLAnchorElement>('a[href="/"]');

      expect(document.activeElement).toBe(alert);
      expect(alert?.getAttribute("aria-labelledby")).toBe("app-error-title");
      expect(alert?.getAttribute("aria-describedby")).toBe(
        "app-error-description",
      );
      expect(alert?.textContent).toContain(error.digest);
      expect(alert?.textContent).not.toContain("owner@example.test");
      expect(alert?.className).toContain("min-w-0");
      expect(alert?.querySelector(".font-mono")?.className).toContain(
        "[overflow-wrap:anywhere]",
      );
      expect(retry?.className).toContain("min-h-11");
      expect(home?.className).toContain("min-h-11");
      expect(home?.textContent).toContain("Back to home");
      expect(mocks.captureClientBoundaryError).toHaveBeenCalledWith(error);
    } finally {
      act(() => root.unmount());
    }
  });

  it("deduplicates same-tick retry activation", async () => {
    const reset = vi.fn();
    const root = render(
      createElement(AppError, {
        error: new Error("failed"),
        reset,
      }),
    );

    try {
      const retry = document.querySelector("button") as HTMLButtonElement;
      act(() => {
        retry.click();
        retry.click();
      });
      expect(reset).toHaveBeenCalledTimes(1);
      await flush();
      expect(retry.disabled).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it("requests a fresh server payload on retry after a digested layout failure", async () => {
    const reset = vi.fn();
    const reload = vi
      .spyOn(window.location, "reload")
      .mockImplementation(() => {});
    const root = render(
      createElement(AppError, {
        error: Object.assign(new Error("network failure"), {
          digest: "server-failure",
        }),
        reset,
      }),
    );
    try {
      expect(reload).not.toHaveBeenCalled();
      const retry = document.querySelector<HTMLButtonElement>("button")!;
      act(() => {
        retry.click();
        retry.click();
      });
      expect(reload).toHaveBeenCalledTimes(1);
      expect(reset).not.toHaveBeenCalled();
      await flush();
      expect(retry.disabled).toBe(false);
    } finally {
      act(() => root.unmount());
      reload.mockRestore();
    }
  });
});
