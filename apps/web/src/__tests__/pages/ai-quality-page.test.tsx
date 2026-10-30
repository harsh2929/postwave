// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /ai-quality. Generated against the page's own <h1>.
//
// This page had ZERO coverage: nothing imported its module, so a crash on
// mount or a wrong variable in a loading/error/empty chain was invisible.
// Responses come from recorded fixtures, so it renders against shapes the
// server really sends.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";

import {
  clickEveryControl,
  expectRendered,
  renderPage,
  stubFixtureTransport,
  unmount,
  WHOAMI,
} from "./_harness";

vi.mock("next/navigation", () => ({
  // Pages that call useRouter/usePathname throw "invariant expected app router
  // to be mounted" outside a Next app shell. The smoke test asks whether the
  // page renders, not whether navigation works, so the router is stubbed to
  // the same shape the repo's other render tests use.
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

beforeEach(() => {
  stubFixtureTransport();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ai-quality page", () => {
  it("does not claim corpus eligibility under an invalid draft policy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        return new Response(
          JSON.stringify(
            url.includes("/settings")
              ? {
                  warn_threshold: 70,
                  hard_gate_enabled: true,
                  hard_gate_threshold: 50,
                  min_examples_for_gate: 10,
                }
              : { items: [] },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const Page = (await import("@/app/(dashboard)/app/ai-quality/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      const minimum = container.querySelector<HTMLInputElement>(
        "#ai-minimum-examples",
      )!;
      expect(minimum).not.toBeNull();
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )?.set?.call(minimum, "0");
        minimum.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(container.textContent).toContain(
        "Enter a valid evaluation policy before assessing corpus eligibility.",
      );
      expect(container.textContent).not.toContain("configured 0-example floor");
      const save = [
        ...container.querySelectorAll<HTMLButtonElement>("button"),
      ].find((b) => b.textContent?.includes("Save future-run policy"));
      expect(save?.disabled).toBe(true);
    } finally {
      unmount(root);
    }
  });

  it("mounts and renders its heading", async () => {
    const Page = (await import("@/app/(dashboard)/app/ai-quality/page"))
      .default;
    const { text, container, root } = await renderPage(Page);
    try {
      expectRendered(text, "AI quality gate");
      // Then press everything. The transport is stubbed, so this asserts
      // no handler explodes — not that it does the right thing.
      const { failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("does not infer an inert gate from a failed corpus request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as Request).url;
        if (url.includes("/golden-examples")) {
          return new Response(
            JSON.stringify({
              error: { code: "bad_request", message: "corpus unavailable" },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/settings")) {
          return new Response(
            JSON.stringify({
              warn_threshold: 70,
              hard_gate_enabled: true,
              hard_gate_threshold: 50,
              min_examples_for_gate: 10,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const Page = (await import("@/app/(dashboard)/app/ai-quality/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      expect(container.textContent).toContain(
        "gate status cannot be determined",
      );
      expect(container.textContent).not.toContain("The gate is not active yet");
      expect(container.textContent).not.toContain("Hard gate is");
    } finally {
      unmount(root);
    }
  });
});
