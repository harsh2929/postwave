// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The companion to docs-nav-payload.test.ts: that one proves the layout stops
// inlining the tree, this one proves the sidebar still works without it.
//
// Falsifiable claims, given a summary-only payload (groups with counts, no
// items — what the layout now serializes):
//   - groups render with their real counts and no endpoint links, and nothing
//     is fetched until the reader needs item-level data
//   - expanding a group fetches /api/docs/nav exactly once and fills it in
//   - typing in the filter fetches it too, and item-level matches then appear
//   - a provider handed a complete tree never fetches at all
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount } from "../pages/_harness";

const mocks = vi.hoisted(() => ({ pathname: "/docs/getting-started" }));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    prefetch: _prefetch,
    ...props
  }: {
    href: string;
    children: ReactNode;
    prefetch?: boolean;
  }) => createElement("a", { href, ...props }, children),
}));

const INDEX = {
  apiGroups: [
    {
      tag: "Campaigns",
      count: 2,
      items: [
        { slug: "list-campaigns", method: "get", path: "/api/v1/campaigns" },
        { slug: "create-campaign", method: "post", path: "/api/v1/campaigns" },
      ],
    },
    {
      tag: "Subscribers",
      count: 1,
      items: [
        {
          slug: "list-subscribers",
          method: "get",
          path: "/api/v1/subscribers",
        },
      ],
    },
  ],
  skillGroups: [
    {
      category: "Messaging",
      count: 1,
      items: [{ slug: "send-campaign", name: "send_campaign" }],
    },
  ],
  migrationSources: [{ slug: "mailchimp", name: "Mailchimp" }],
  integrations: [{ slug: "shopify", name: "Shopify" }],
};

// Exactly what docsNavSummary() produces: the same groups, minus every item.
const SUMMARY = {
  apiGroups: INDEX.apiGroups.map(({ tag, count }) => ({ tag, count })),
  skillGroups: INDEX.skillGroups.map(({ category, count }) => ({
    category,
    count,
  })),
  migrationSources: INDEX.migrationSources,
  integrations: INDEX.integrations,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => INDEX,
  }));
  vi.stubGlobal("fetch", fetchMock);
  // Force the setTimeout path so the idle fetch is deterministic here.
  vi.stubGlobal("requestIdleCallback", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.pathname = "/docs/getting-started";
  document.body.innerHTML = "";
});

async function mount(
  value: unknown,
): Promise<{ container: HTMLElement; root: import("react-dom/client").Root }> {
  const { Sidebar } = await import("@/components/docs/Sidebar");
  const { DocsNavProvider } = await import(
    "@/components/docs/docs-nav-context"
  );
  const Wrapper = (): JSX.Element => (
    <DocsNavProvider value={value as never}>
      <Sidebar />
    </DocsNavProvider>
  );
  return renderPage(Wrapper);
}

function hrefs(container: HTMLElement): string[] {
  return [...container.querySelectorAll("a")].map(
    (a) => a.getAttribute("href") ?? "",
  );
}

function groupToggle(container: HTMLElement, label: string): HTMLButtonElement {
  return [...container.querySelectorAll("button")].find(
    (b) => b.hasAttribute("aria-expanded") && b.textContent?.startsWith(label),
  )! as HTMLButtonElement;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("docs Sidebar with a summary-only payload", () => {
  it("renders every group with its real count and fetches nothing", async () => {
    const { container, root } = await mount(SUMMARY);
    try {
      await settle();
      expect(
        [...container.querySelectorAll("button")]
          .filter((b) => b.hasAttribute("aria-expanded"))
          .map((b) => b.textContent),
      ).toEqual(["Campaigns2", "Subscribers1", "Messaging1"]);
      // No endpoint or skill rows have been paid for.
      expect(hrefs(container)).not.toContain("/docs/api/list-campaigns");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });

  it("fetches the index once when a group is expanded, then fills it in", async () => {
    const { container, root } = await mount(SUMMARY);
    try {
      await act(async () => {
        groupToggle(container, "Campaigns").click();
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![0]).toBe("/api/docs/nav");

      await settle();
      expect(hrefs(container)).toContain("/docs/api/list-campaigns");
      expect(hrefs(container)).toContain("/docs/api/create-campaign");
      // The other group stayed collapsed even though its data is now present.
      expect(hrefs(container)).not.toContain("/docs/api/list-subscribers");

      // Expanding a second group reuses what was already fetched.
      await act(async () => {
        groupToggle(container, "Subscribers").click();
      });
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(hrefs(container)).toContain("/docs/api/list-subscribers");
    } finally {
      unmount(root);
    }
  });

  it("filters across endpoints once the index arrives", async () => {
    const { container, root } = await mount(SUMMARY);
    try {
      const input = container.querySelector<HTMLInputElement>("input")!;
      await act(async () => {
        typeInto(input, "/api/v1/subscribers");
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // Before the index lands the sidebar must not claim there is no match.
      expect(container.textContent).not.toContain("No matches for");

      await settle();
      expect(hrefs(container)).toContain("/docs/api/list-subscribers");
      expect(hrefs(container)).not.toContain("/docs/api/list-campaigns");
    } finally {
      unmount(root);
    }
  });

  it("opens the group holding the current endpoint after the idle fetch", async () => {
    mocks.pathname = "/docs/api/list-subscribers";
    const { container, root } = await mount(SUMMARY);
    try {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 250));
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(hrefs(container)).toContain("/docs/api/list-subscribers");
      expect(hrefs(container)).not.toContain("/docs/api/list-campaigns");
    } finally {
      unmount(root);
    }
  });

  it("never fetches when the provider is handed a complete tree", async () => {
    mocks.pathname = "/docs/api/list-campaigns";
    const { container, root } = await mount(INDEX);
    try {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 250));
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(hrefs(container)).toContain("/docs/api/list-campaigns");
    } finally {
      unmount(root);
    }
  });
});
