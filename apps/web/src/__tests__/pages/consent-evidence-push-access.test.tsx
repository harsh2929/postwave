// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount } from "./_harness";

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue({
    user_id: "viewer-user",
    tenant_id: "11111111-1111-4111-8111-111111111111",
    email: "viewer@example.test",
    role: "viewer",
    effective_role: "viewer",
    viewer_mode: false,
  }),
}));

afterEach(() => vi.unstubAllGlobals());

describe("consent evidence customer push access", () => {
  it("shows restricted truth and makes no registry request for a viewer", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const path = new URL(raw, "http://postwave.test").pathname;
      const body =
        path === "/api/v1/consent/events"
          ? {
              events: [],
              count: 0,
              source_planes: [],
              snapshot_at: "2026-08-29T10:00:00Z",
              has_more: false,
              schema_version: 1,
            }
          : path === "/api/v1/privacy/incidents"
            ? { incidents: [], known_jurisdictions: [] }
            : {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const Page = (await import("@/app/(dashboard)/app/consent-evidence/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      // The push-suppressions manager is a next/dynamic chunk; give it a
      // bounded moment to mount before reading its restricted-state copy.
      const deadline = Date.now() + 10_000;
      while (
        !/restricted to an active owner or admin/iu.test(
          container.textContent ?? "",
        ) &&
        Date.now() < deadline
      ) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      }
      expect(container.textContent).toMatch(
        /restricted to an active owner or admin/iu,
      );
      expect(container.textContent).toMatch(/no zero total is inferred/iu);
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes("/api/v1/push/suppressions"),
        ),
      ).toBe(false);
    } finally {
      unmount(root);
    }
  });
});
