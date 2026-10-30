// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setOnlineStatusForTest } from "@/lib/online-manager";
import { qk } from "@/lib/query-keys";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  tab: "subaccounts",
  getAgencyBranding: vi.fn(),
  listAgencyChildrenPage: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/app/agency",
  useSearchParams: () =>
    new URLSearchParams(mocks.tab === "subaccounts" ? "" : `tab=${mocks.tab}`),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue({
    user_id: "11111111-1111-4111-8111-111111111111",
    tenant_id: "22222222-2222-4222-8222-222222222222",
    email: "admin@postwave.test",
    role: "admin",
    effective_role: "admin",
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Agency",
    workspace_slug: "agency",
  }),
}));

vi.mock("@/lib/agency-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agency-api")>()),
  getAgencyBranding: mocks.getAgencyBranding,
  listAgencyChildrenPage: mocks.listAgencyChildrenPage,
}));

const FIRST_CHILD = {
  id: "33333333-3333-4333-8333-333333333333",
  slug: "alpha",
  name: "Alpha",
  tier: "studio" as const,
  parent_tenant_id: "22222222-2222-4222-8222-222222222222",
  billing_mode: "parent" as const,
  reseller_markup_bps: 250,
  whitelabel_enabled: false,
  created_at: "2026-09-10T00:00:00Z",
  updated_at: "2026-09-10T00:00:00Z",
};

const BRANDING = {
  whitelabel_enabled: true,
  brand_name: "Northwind Studio",
  custom_domain: "legacy.northwind.co",
  logo_url: "https://cdn.northwind.co/logo.svg",
  primary_color: "#1D4ED8",
  support_email: "help@northwind.co",
  legal_entity: "Northwind LLC",
  updated_at: "2026-09-10T00:00:00Z",
  etag: '"agency-branding:22222222-2222-4222-8222-222222222222:v3"',
};

beforeEach(() => {
  setOnlineStatusForTest("online");
  mocks.tab = "subaccounts";
  mocks.getAgencyBranding.mockReset().mockResolvedValue(BRANDING);
  mocks.listAgencyChildrenPage.mockReset().mockResolvedValue({
    children: [FIRST_CHILD],
    count: 1,
    has_more: false,
  });
});

afterEach(() => {
  setOnlineStatusForTest("connecting");
  document.body.innerHTML = "";
});

async function renderAgency() {
  const Page = (await import("@/app/(dashboard)/app/agency/page-client"))
    .default;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  await act(async () => {
    root.render(
      createElement(QueryClientProvider, { client }, createElement(Page)),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  for (let turn = 0; turn < 10; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (!/checking agency access|loading/i.test(container.textContent ?? "")) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      break;
    }
  }
  return { container, root, client };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${label}`);
  }
  return match;
}

describe("Agency read-only UI boundary", () => {
  it("fails closed when cached page parameters are not canonical strings", async () => {
    const { mergeAgencyChildrenPages } =
      await import("@/app/(dashboard)/app/agency/page-client");
    expect(
      mergeAgencyChildrenPages({
        pages: [
          {
            children: [FIRST_CHILD],
            count: 1,
            has_more: false,
          },
        ],
        pageParams: [{}],
      }),
    ).toEqual({
      children: [],
      issue: "The child roster returned an invalid page sequence.",
    });
  });

  it("loads each cursor page only after an explicit Load more", async () => {
    mocks.listAgencyChildrenPage
      .mockResolvedValueOnce({
        children: [FIRST_CHILD],
        count: 1,
        has_more: true,
        next_cursor: "next-page",
      })
      .mockResolvedValueOnce({
        children: [
          {
            ...FIRST_CHILD,
            id: "44444444-4444-4444-8444-444444444444",
            slug: "bravo",
            name: "Bravo",
          },
        ],
        count: 1,
        has_more: false,
      });
    const { container, root } = await renderAgency();
    try {
      expect(container.textContent).toContain("1 loaded");
      expect(mocks.listAgencyChildrenPage).toHaveBeenCalledTimes(1);
      expect(mocks.listAgencyChildrenPage.mock.calls[0]?.slice(0, 2)).toEqual([
        "22222222-2222-4222-8222-222222222222",
        undefined,
      ]);
      await act(async () => {
        button(container, "Load more").click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(mocks.listAgencyChildrenPage).toHaveBeenCalledTimes(2);
      expect(mocks.listAgencyChildrenPage.mock.calls[1]?.[1]).toBe("next-page");
      expect(container.textContent).toContain("2 loaded");
      expect(container.textContent).not.toMatch(/\b2 total\b/i);
    } finally {
      act(() => root.unmount());
    }
  });

  it("blocks a cached continuation after connectivity or authority is lost", async () => {
    mocks.listAgencyChildrenPage.mockResolvedValue({
      children: [FIRST_CHILD],
      count: 1,
      has_more: true,
      next_cursor: "next-page",
    });
    const { container, root, client } = await renderAgency();
    try {
      const staleLoadMore = button(container, "Load more");
      expect(mocks.listAgencyChildrenPage).toHaveBeenCalledTimes(1);

      await act(async () => setOnlineStatusForTest("offline"));
      const offlineLoadMore = button(container, "Reconnect to load more");
      expect(offlineLoadMore.disabled).toBe(true);
      offlineLoadMore.click();
      expect(mocks.listAgencyChildrenPage).toHaveBeenCalledTimes(1);

      await act(async () => setOnlineStatusForTest("online"));
      client.setQueryData(qk.authMe(), {
        user_id: "11111111-1111-4111-8111-111111111111",
        tenant_id: "22222222-2222-4222-8222-222222222222",
        email: "viewer@postwave.test",
        role: "viewer",
        effective_role: "viewer",
        viewer_mode: true,
        auth_provider: "password",
        email_verified: true,
        workspace_name: "Agency",
        workspace_slug: "agency",
      });
      staleLoadMore.click();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(mocks.listAgencyChildrenPage).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain(
        "Agency data is available only to workspace owners and admins",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("renders stored branding without an editor or roster request", async () => {
    mocks.tab = "branding";
    const { container, root } = await renderAgency();
    try {
      expect(container.textContent).toContain("Northwind Studio");
      expect(container.textContent).toContain("Publishing release-held");
      expect(container.textContent).toContain("legacy.northwind.co");
      expect(container.textContent).not.toMatch(/save branding|publish now/i);
      expect(mocks.getAgencyBranding).toHaveBeenCalledTimes(1);
      expect(mocks.listAgencyChildrenPage).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("makes all five holds visible without issuing either read", async () => {
    mocks.tab = "invoice";
    const { container, root } = await renderAgency();
    try {
      for (const label of [
        "Create a child workspace",
        "Unlink a child workspace",
        "Change the billing owner",
        "Preview consolidated billing",
        "Publish audit portal branding",
      ]) {
        expect(container.textContent).toContain(label);
      }
      expect(button(container, "Refresh").disabled).toBe(true);
      expect(mocks.getAgencyBranding).not.toHaveBeenCalled();
      expect(mocks.listAgencyChildrenPage).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});
