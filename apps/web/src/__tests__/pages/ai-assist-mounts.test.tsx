// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// messaging-52 entry — the Moosewave AI chat workspace lives at
// /app/ai-assist/chat, and /app/ai-assist is where an operator looks for it.
// Pins that the AI assist page links there and that the target route exists.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderPage, stubFixtureTransport, unmount, WHOAMI } from "./_harness";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app/ai-assist",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ai-assist — Moosewave AI chat entry (messaging-52)", () => {
  it("links from the page header to the chat workspace route", async () => {
    stubFixtureTransport();
    const Page = (await import("@/app/(dashboard)/app/ai-assist/page")).default;
    const { container, root } = await renderPage(Page);
    try {
      const link = [...container.querySelectorAll<HTMLAnchorElement>("header a")].find(
        (a) => a.textContent?.trim() === "Open Moosewave AI chat",
      );
      expect(link).toBeDefined();
      expect(link!.getAttribute("href")).toBe("/app/ai-assist/chat");
      expect(
        existsSync(
          resolve(process.cwd(), "src/app/(dashboard)/app/ai-assist/chat/page.tsx"),
        ),
      ).toBe(true);
    } finally {
      unmount(root);
    }
  });
});
