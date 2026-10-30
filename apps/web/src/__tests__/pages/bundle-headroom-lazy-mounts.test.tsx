// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Three routes sit within a kilobyte of the 700 KiB bundle budget, so their
// heavy below-the-fold modules load on demand. These tests prove the lazy
// boundaries still deliver the module: the panel appears after the fallback,
// not only a "Loading…" status.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  expectMounted,
  renderPage,
  stubFixtureTransport,
  unmount,
  WHOAMI,
} from "./_harness";

const SEGMENT_ID = "11111111-2222-3333-4444-555555555555";
const SEGMENT = {
  id: SEGMENT_ID,
  tenantId: WHOAMI.tenant_id,
  name: "Recent openers",
  description: "",
  queryAst: { op: "and", children: [] },
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/sequences/new",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ id: SEGMENT_ID }),
  redirect: vi.fn(),
}));
vi.mock("@/lib/voice-api", () => ({
  listTemplates: vi.fn(async () => []),
}));
vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));
vi.mock("@/lib/segments-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/segments-api")>()),
  getSegment: vi.fn(async () => SEGMENT),
  getSegmentUsage: vi.fn(async () => ({ segment_id: SEGMENT_ID, items: [] })),
}));
vi.mock("@/components/EmailPreview", () => ({
  EmailPreview: ({ mjml }: { mjml: string }) =>
    createElement("div", { "data-testid": "email-preview" }, mjml),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function mount(element: React.ReactElement): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(element);
  });
  return host;
}

async function settled(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 100; i += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      });
    }
  }
  throw last;
}

describe("bundle-headroom lazy mounts", () => {
  it("sequences/new renders the brief generator through its deferred boundary", async () => {
    stubFixtureTransport();
    const Page = (await import("@/app/(dashboard)/app/sequences/new/page"))
      .default;
    // An async server page: resolve its tree first, then render it through
    // the harness's providers as a plain component.
    const tree = await Page();
    const { container, root } = await renderPage(() => tree);
    try {
      await settled(() => {
        expect(
          container.querySelector('[aria-label="Example briefs"]'),
          "the AI brief panel should mount after its fallback",
        ).not.toBeNull();
      });
      expect(
        container.querySelector(
          '[role="status"][aria-label="Loading brief generator"]',
        ),
      ).toBeNull();
    } finally {
      unmount(root);
      vi.unstubAllGlobals();
    }
  });

  it("subscribers/segments/[id]/edit delivers the editor behind its fallback", async () => {
    stubFixtureTransport();
    const Page = (
      await import("@/app/(dashboard)/app/subscribers/segments/[id]/edit/page")
    ).default;
    const { text, container, root } = await renderPage(Page, {
      params: Promise.resolve({ id: SEGMENT_ID }),
    });
    try {
      expectMounted(text);
      expect(text).toContain("Rules");
      expect(
        container.querySelector(
          '[role="status"][aria-label="Loading segment editor"]',
        ),
      ).toBeNull();
    } finally {
      unmount(root);
      vi.unstubAllGlobals();
    }
  });

  it("templates/[id] renders the MJML preview through EmailPreviewLazy", async () => {
    const { EmailPreviewLazy } = await import("@/components/EmailPreviewLazy");
    const host = await mount(
      createElement(EmailPreviewLazy, { mjml: "<mjml>hello</mjml>" }),
    );
    await settled(() => {
      expect(
        host.querySelector('[data-testid="email-preview"]')?.textContent,
      ).toBe("<mjml>hello</mjml>");
    });
    expect(
      host.querySelector('[role="status"][aria-label="Loading email preview"]'),
    ).toBeNull();
  });
});
