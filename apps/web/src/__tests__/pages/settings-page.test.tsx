// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /settings. Completes the mount suite to every dashboard page.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";

import {
  clickEveryControl,
  expectMounted,
  renderPage,
  stubFixtureTransport,
  unmount,
  WHOAMI,
} from "./_harness";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/settings",
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

describe("settings page", () => {
  it("mounts without crashing", async () => {
    const Page = (await import("@/app/(dashboard)/app/settings/page")).default;
    const { text, container, root } = await renderPage(Page);
    try {
      expectMounted(text);
      // Then press everything. The transport is stubbed, so this asserts
      // no handler explodes — not that it does the right thing.
      const { failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("keeps the complete PATCH path inert until an authoritative GET succeeds", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            error: { code: "settings_unavailable", message: "Load failed" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const Page = (await import("@/app/(dashboard)/app/settings/page")).default;
    const { text, container, root } = await renderPage(Page);
    try {
      expect(text).toContain("Load failed");
      expect(text).toContain("Retry workspace settings");

      const editableControls = Array.from(
        container.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
          "input, select",
        ),
      );
      expect(editableControls.length).toBeGreaterThan(5);
      expect(editableControls.every((control) => control.disabled)).toBe(true);

      const save = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Save changes",
      );
      expect(save?.disabled).toBe(true);

      // Disabled is only the presentation mechanism. Forge a click after
      // removing it and prove the handler itself still refuses the PATCH.
      if (!save) throw new Error("Save changes button not found");
      save.disabled = false;
      await act(async () => {
        save.click();
        await Promise.resolve();
      });
      const methods = fetchMock.mock.calls.map(([input, init]) =>
        String(
          (init as RequestInit | undefined)?.method ??
            (input instanceof Request ? input.method : "GET"),
        ).toUpperCase(),
      );
      expect(methods).not.toContain("PATCH");
    } finally {
      unmount(root);
    }
  });

  it("retries the failed GET and unlocks only the server-returned settings", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { code: "settings_unavailable", message: "Load failed" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            tenant_id: WHOAMI.tenant_id,
            display_name: "Authoritative workspace",
            default_reply_to: "reply@example.test",
            timezone: "UTC",
            date_format: "MMM D, YYYY",
            brand_color: "#112233",
            logo_url: "",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const Page = (await import("@/app/(dashboard)/app/settings/page")).default;
    const { container, root } = await renderPage(Page);
    try {
      const retry = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Retry workspace settings",
      );
      if (!retry) throw new Error("Retry workspace settings button not found");
      await act(async () => {
        retry.click();
        for (let turn = 0; turn < 8; turn += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      });

      const name = container.querySelector<HTMLInputElement>("#ws-name");
      expect(name?.value).toBe("Authoritative workspace");
      expect(name?.disabled).toBe(false);
      expect(container.textContent).not.toContain("Load failed");
    } finally {
      unmount(root);
    }
  });
});
