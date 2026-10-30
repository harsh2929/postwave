// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
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

describe("replies page", () => {
  it("mounts and renders its classification bands", async () => {
    const RepliesPage = (await import("@/app/(dashboard)/app/replies/page"))
      .default;
    const { text, container, root } = await renderPage(RepliesPage);
    try {
      expectRendered(text, "Replies");
      // Then press everything. The transport is stubbed, so this asserts
      // no handler explodes — not that it does the right thing.
      const { failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
      // The page's whole reason to exist: three bands, not two.
      expect(text).toContain("Not yet classified");
      // And the window mismatch it was built to disclose.
      expect(text).toMatch(/different period/i);
    } finally {
      unmount(root);
    }
  });

  it("keeps identifying sender details restricted for a report viewer", async () => {
    const { whoami } = await import("@/lib/auth-api");
    vi.mocked(whoami).mockResolvedValueOnce({
      ...WHOAMI,
      role: "viewer",
      effective_role: "viewer",
    });
    const RepliesPage = (await import("@/app/(dashboard)/app/replies/page"))
      .default;
    const { text, root } = await renderPage(RepliesPage);
    try {
      expect(text).toContain("Sender identities are restricted");
      expect(text).not.toContain("No repeat senders in this window");
    } finally {
      unmount(root);
    }
  });
});
