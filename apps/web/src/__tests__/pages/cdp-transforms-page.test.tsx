// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, it, vi } from "vitest";

import {
  expectRendered,
  renderPage,
  stubFixtureTransport,
  unmount,
  WHOAMI,
} from "./_harness";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/app/cdp-transforms",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));
vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

beforeEach(() => stubFixtureTransport());
afterEach(() => vi.unstubAllGlobals());

describe("CDP transforms page", () => {
  it("mounts the non-persistent transform laboratory", async () => {
    const Page = (await import("@/app/(dashboard)/app/cdp-transforms/page")).default;
    const { text, root } = await renderPage(Page);
    try {
      expectRendered(text, "CDP transform preview");
    } finally {
      unmount(root);
    }
  });
});
