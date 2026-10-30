// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Removing sample data while one of your own campaigns (not yet sent) targets
// the sample segment. The API used to fail the whole removal with 500 on the
// segment-delete guard; it now removes the rest and reports the kept segment
// (fixtures/segments/sample-data-remove-kept.json, recorded from the Go
// handler). The page must say what stayed and why, and keep offering removal.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import kept from "../fixtures/segments/sample-data-remove-kept.json";
import { renderPage, unmount, WHOAMI } from "./_harness";

const mocks = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/settings/developer",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    warning: mocks.toastWarning,
    error: mocks.toastError,
    message: vi.fn(),
  },
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
  whoamiFresh: vi.fn().mockResolvedValue(WHOAMI),
}));

let seeded = true;

beforeEach(() => {
  seeded = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
        "http://localhost",
      );
      const method = (init?.method ?? "GET").toUpperCase();
      const reply = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (url.pathname === "/api/v1/onboarding/sample-data") {
        if (method === "DELETE") return reply(kept);
        return reply({ seeded });
      }
      return reply({ error: { code: "not_found", message: "" } }, 404);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function exactButton(text: string, scope: ParentNode = document) {
  const button = Array.from(scope.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

describe("removing sample data a campaign still depends on", () => {
  it("names the kept segment and the campaign, and keeps offering removal", async () => {
    const Page = (await import("@/app/(dashboard)/app/settings/developer/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      await act(async () =>
        exactButton("Remove sample data", container).click(),
      );
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog?.textContent).toContain(
        "that segment stays until you move the campaign",
      );
      await act(async () => {
        exactButton("Remove", dialog!).click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(mocks.toastSuccess).not.toHaveBeenCalled();
      // The explanation stays on the page, beside the button it is about,
      // rather than in a toast that is gone before anyone acts on it.
      const notice = container.querySelector<HTMLElement>(
        '[data-testid="sample-data-kept"]',
      );
      expect(notice?.getAttribute("role")).toBe("status");
      expect(notice?.textContent).toContain(
        'Sample data removed, except the sample segment "Sample · enabled subscribers": your campaign "Campaign for the sample audience" hasn\'t sent yet and still targets it. Move that campaign to another audience, then remove sample data again.',
      );
      const link = notice?.querySelector<HTMLAnchorElement>("a");
      expect(link?.getAttribute("href")).toBe(
        "/app/subscribers/segments/1c821638-d29e-4d8c-9c1f-c74d6c5f585f",
      );
      expect(link?.textContent).toBe(
        "See the campaigns using \u201cSample · enabled subscribers\u201d",
      );
      expect(container.textContent).toContain("Remove sample data");
      expect(container.textContent).not.toContain("Load sample data");
    } finally {
      unmount(root);
    }
  });
});
