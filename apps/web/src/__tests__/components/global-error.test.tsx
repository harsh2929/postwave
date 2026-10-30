// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import GlobalError from "@/app/global-error";

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

describe("global error boundary", () => {
  it("announces and focuses a contained, recoverable failure", async () => {
    const digest = `digest-${"x".repeat(2_000)}`;
    const error = Object.assign(
      new Error("Subscriber alice@example.test failed"),
      { digest },
    );
    const root = render(createElement(GlobalError, { error, reset: vi.fn() }));

    try {
      await flush();
      const alert = document.querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
      expect(document.activeElement).toBe(alert);
      expect(alert?.textContent).toContain(digest);
      expect(alert?.textContent).not.toContain("alice@example.test");
      expect(alert?.querySelector(".font-mono")?.className).toContain(
        "break-all",
      );
      expect(mocks.captureClientBoundaryError).toHaveBeenCalledWith(error);

      const retry = document.querySelector("button");
      const home = document.querySelector('a[href="/"]');
      expect(retry?.className).toContain("min-h-11");
      expect(home?.className).toContain("min-h-11");
      expect(home?.textContent).toContain("Back to home");
    } finally {
      act(() => root.unmount());
    }
  });

  it("deduplicates same-tick retry activation", async () => {
    const reset = vi.fn();
    const root = render(
      createElement(GlobalError, {
        error: Object.assign(new Error("failed"), { digest: "digest" }),
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
});
