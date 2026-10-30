// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScopedRouteError } from "@/components/dashboard/scoped-route-error";

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

function fixtureProps(reset: () => void | Promise<void>) {
  return {
    title: "Couldn't load duplicates",
    description: "No subscriber records have been changed.",
    error: Object.assign(
      new Error("Subscriber alice@example.test could not be loaded"),
      { digest: `digest-${"x".repeat(2_000)}` },
    ),
    reset,
    backHref: "/app/subscribers",
    backLabel: "Back to subscribers",
  };
}

describe("ScopedRouteError", () => {
  it("focuses and reports a contained recovery surface without exposing raw error text", async () => {
    const props = fixtureProps(vi.fn());
    const root = render(createElement(ScopedRouteError, props));

    try {
      await flush();
      const surface = document.querySelector<HTMLElement>(
        'section[role="alert"]',
      );
      const recoveryLink = document.querySelector<HTMLAnchorElement>(
        'a[href="/app/subscribers"]',
      );

      expect(surface).not.toBeNull();
      expect(document.activeElement).toBe(surface);
      expect(surface?.getAttribute("aria-labelledby")).toBeTruthy();
      expect(surface?.getAttribute("aria-describedby")).toBeTruthy();
      expect(surface?.textContent).toContain(props.error.digest);
      expect(surface?.textContent).not.toContain("alice@example.test");
      expect(surface?.className).toContain("min-w-0");
      expect(surface?.querySelector(".font-mono")?.className).toContain(
        "[overflow-wrap:anywhere]",
      );
      expect(recoveryLink?.textContent).toContain("Back to subscribers");
      expect(recoveryLink?.className).toContain("min-h-11");
      expect(mocks.captureClientBoundaryError).toHaveBeenCalledWith(
        props.error,
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps an async retry single-flight and announces a failed recovery", async () => {
    let rejectReset: ((reason?: unknown) => void) | undefined;
    const reset = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectReset = reject;
        }),
    );
    const root = render(
      createElement(
        StrictMode,
        null,
        createElement(ScopedRouteError, fixtureProps(reset)),
      ),
    );

    try {
      const retry = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Try again"),
      ) as HTMLButtonElement;

      act(() => {
        retry.click();
        retry.click();
      });

      expect(reset).toHaveBeenCalledTimes(1);
      expect(retry.disabled).toBe(true);
      expect(retry.getAttribute("aria-busy")).toBe("true");
      expect(retry.textContent).toContain("Retrying…");

      await act(async () => {
        rejectReset?.(new Error("still offline"));
        await Promise.resolve();
      });

      expect(retry.disabled).toBe(false);
      expect(document.body.textContent).toContain("Retry could not be started");
    } finally {
      act(() => root.unmount());
    }
  });

  it("unlocks after a synchronous reset exception instead of trapping the user", () => {
    const reset = vi.fn(() => {
      throw new Error("reset failed");
    });
    const root = render(createElement(ScopedRouteError, fixtureProps(reset)));

    try {
      const retry = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Try again"),
      ) as HTMLButtonElement;
      act(() => retry.click());

      expect(reset).toHaveBeenCalledOnce();
      expect(retry.disabled).toBe(false);
      expect(document.body.textContent).toContain("Retry could not be started");
    } finally {
      act(() => root.unmount());
    }
  });
});
