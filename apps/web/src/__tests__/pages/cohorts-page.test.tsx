// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /cohorts. Generated against the page's own <h1>.
//
// This page had ZERO coverage: nothing imported its module, so a crash on
// mount or a wrong variable in a loading/error/empty chain was invisible.
// Responses come from recorded fixtures, so it renders against shapes the
// server really sends.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("cohorts page", () => {
  it("mounts and renders its heading", async () => {
    const Page = (await import("@/app/(dashboard)/app/cohorts/page")).default;
    const { text, container, root } = await renderPage(Page);
    try {
      expectRendered(text, "Cohorts");
      // Then press everything. The transport is stubbed, so this asserts
      // no handler explodes — not that it does the right thing.
      const { failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("keeps tied fatigue deciles as distinct React rows", async () => {
    const tiedDeciles = Array.from({ length: 10 }, (_, index) => ({
      sends_bucket: "1",
      subscribers: index + 1,
      open_rate: 0.5 - index * 0.01,
      unsub_rate: index * 0.001,
    }));

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as Request).url;
        const path = new URL(url, "http://postwave.test").pathname;
        const bodies: Record<string, unknown> = {
          "/api/v1/analytics/cohorts": [
            {
              cohort_label: "2026-08",
              cohort_size: 12,
              weeks: [0.5],
            },
          ],
          "/api/v1/analytics/fatigue": { deciles: tiedDeciles },
          "/api/v1/analytics/engagement-classification/summary": {
            unit: "interaction_events",
            methodology: "Browser-certification fixture",
            human: 8,
            machine: 3,
            unknown: 1,
            total: 12,
            classifier_version: "test-v1",
          },
        };
        const body = bodies[path];
        return new Response(
          JSON.stringify(body ?? { error: { code: "not_found", message: "" } }),
          {
            status: body === undefined ? 404 : 200,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
      // React reports duplicate child keys through console.error.
    });
    const Page = (await import("@/app/(dashboard)/app/cohorts/page")).default;
    const { container, root } = await renderPage(Page);
    try {
      expect(
        container.querySelectorAll('[aria-label="Send fatigue buckets"] > li'),
      ).toHaveLength(10);
      expect(
        consoleError.mock.calls.filter((args) =>
          args.some((value) =>
            String(value).includes(
              "Encountered two children with the same key",
            ),
          ),
        ),
      ).toEqual([]);
    } finally {
      unmount(root);
      consoleError.mockRestore();
    }
  });
});
