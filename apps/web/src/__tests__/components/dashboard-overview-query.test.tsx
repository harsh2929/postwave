// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import OverviewPage from "@/app/(dashboard)/app/page";
import { base } from "@/lib/query-keys";

import { importBeforeTests, waitFor } from "../pages/_wait";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  listAuditLog: vi.fn(),
  whoami: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: mocks.apiGet,
    },
  };
});

vi.mock("@/lib/audit-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit-api")>();
  return {
    ...actual,
    listAuditLog: mocks.listAuditLog,
  };
});

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoami,
}));

vi.mock("@/components/onboarding/OnboardingChecklist", () => ({
  OnboardingChecklist: () =>
    createElement("div", { "data-testid": "onboarding-checklist" }),
}));

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

function render(ui: ReactNode): { queryClient: QueryClient; root: Root } {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(QueryClientProvider, { client: queryClient }, ui),
    );
  });
  return { queryClient, root };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function primeAuth(): void {
  mocks.whoami.mockResolvedValue({
    user_id: "usr_1",
    tenant_id: "tnt_1",
    email: "ada@example.com",
    role: "admin",
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Acme",
    workspace_slug: "acme",
  });
}

function installOverviewMocks(state: {
  subscriberTotal: number;
  campaignCountFails?: boolean;
  campaigns?: Array<{
    id: string;
    name: string;
    status: string;
    scheduled_at?: string;
  }>;
}): void {
  mocks.apiGet.mockImplementation((path: string) => {
    if (path === "/api/health") return Promise.resolve({ ok: true });
    if (path === "/api/v1/subscribers?page=1&per_page=1") {
      return Promise.resolve({ total: state.subscriberTotal, items: [] });
    }
    if (path === "/api/v1/campaigns?limit=10") {
      return Promise.resolve(
        state.campaigns ?? [
          { id: "cmp_1", name: "June launch", status: "sent" },
        ],
      );
    }
    if (path === "/api/v1/campaigns/count") {
      if (state.campaignCountFails) {
        return Promise.reject(new Error("campaign counts unavailable"));
      }
      return Promise.resolve({ total: 3, by_status: { sent: 2 } });
    }
    return Promise.reject(new Error(`Unhandled API path: ${path}`));
  });
  mocks.listAuditLog.mockResolvedValue({
    rows: [
      {
        id: 7,
        action: "campaign.send",
        resourceType: "campaign",
        actorType: "user",
        actorLabel: "Ada",
        metadata: {},
        at: "2026-06-27T12:00:00.000Z",
      },
    ],
  });
}

describe("OverviewPage query freshness", () => {
  // The overview query imports @/lib/audit-api and @/lib/dashboard-activity on
  // first use, the layout query imports @/lib/analytics-api, and four panels
  // are next/dynamic chunks. Cold, those imports are wall-clock work that
  // outran the old 30-turn wait on a loaded run, and the test failed with the
  // page still waiting on them. Import them in a hook, one at a time, on the
  // cold-import timeout. (One at a time also keeps the importOriginal factory
  // of the mocked audit-api out of two concurrent imports.)
  importBeforeTests(
    () => import("@/lib/audit-api"),
    () => import("@/lib/dashboard-activity"),
    () => import("@/lib/analytics-api"),
    () => import("@/components/dashboard/layout-customizer"),
    () => import("@/components/dashboard/share-snapshot-button"),
    () => import("@/components/dashboard/revenue-tiles"),
    () => import("@/components/resume-card"),
  );

  it("loads overview data through a tenant-scoped dashboard query", async () => {
    primeAuth();
    installOverviewMocks({ subscriberTotal: 12 });

    const { queryClient, root } = render(createElement(OverviewPage));

    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("12");
        expect(document.body.textContent).toContain("June launch");
        // Audit rows are humanized: "campaign.send" → "Sent a campaign".
        expect(document.body.textContent).toContain("Sent a campaign");
      });

      const subscriberCall = mocks.apiGet.mock.calls.find(
        ([path]) => path === "/api/v1/subscribers?page=1&per_page=1",
      );
      expect(subscriberCall?.[1]).toEqual({
        signal: expect.any(AbortSignal),
      });
      // The feed renders 8 rows but asks for 100: `buildActivityItems` drops
      // the audit middleware's own `http.*` request-log rows client-side, so a
      // limit equal to the render count let a burst of plumbing rows empty the
      // feed. Keep this pinned to an exact number, not a range.
      expect(mocks.listAuditLog).toHaveBeenCalledWith(
        { limit: 100 },
        { signal: expect.any(AbortSignal) },
      );
      expect(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.queryKey),
      ).toContainEqual([
        "dashboard",
        "tnt_1",
        "admin",
        "overview",
        "usr_1",
        "member",
      ]);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("shows the next five scheduled sends in date order without including drafts", async () => {
    primeAuth();
    installOverviewMocks({
      subscriberTotal: 12,
      campaigns: [6, 3, 1, 5, 2, 4]
        .map((day) => ({
          id: `scheduled-${day}`,
          name: `Scheduled ${day}`,
          status: "scheduled",
          scheduled_at: `2099-01-0${day}T12:00:00Z`,
        }))
        .concat([
          {
            id: "draft",
            name: "Draft with a date",
            status: "draft",
            scheduled_at: "2098-01-01T12:00:00Z",
          },
        ]),
    });
    const { root } = render(createElement(OverviewPage));
    try {
      await waitFor(() => {
        expect(
          document.querySelector('[data-testid="upcoming-sends"]'),
        ).not.toBeNull();
      });
      const links = [
        ...document.querySelectorAll<HTMLAnchorElement>(
          '[data-testid="upcoming-sends"] a',
        ),
      ];
      expect(links.map((link) => link.getAttribute("href"))).toEqual(
        [1, 2, 3, 4, 5].map((day) => `/app/campaigns/scheduled-${day}`),
      );
      expect(links.some((link) => link.textContent?.includes("Draft"))).toBe(
        false,
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("refetches when the shared dashboard prefix is invalidated", async () => {
    primeAuth();
    const state = { subscriberTotal: 12 };
    installOverviewMocks(state);

    const { queryClient, root } = render(createElement(OverviewPage));

    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("12");
      });

      state.subscriberTotal = 13;
      await act(async () => {
        await queryClient.invalidateQueries({
          queryKey: base("dashboard", "tnt_1", "admin"),
          exact: false,
        });
        await flush();
      });

      await waitFor(() => {
        expect(document.body.textContent).toContain("13");
      });
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("shows activity errors without hiding loaded overview data", async () => {
    primeAuth();
    installOverviewMocks({ subscriberTotal: 12 });
    mocks.listAuditLog.mockRejectedValueOnce(new Error("audit unavailable"));

    const { root } = render(createElement(OverviewPage));

    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("12");
        expect(document.body.textContent).toContain("June launch");
        expect(document.body.textContent).toContain(
          "Recent activity could not be loaded.",
        );
      });
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("does not present the bounded recent list as all-time campaign counts", async () => {
    primeAuth();
    installOverviewMocks({ subscriberTotal: 12, campaignCountFails: true });

    const { root } = render(createElement(OverviewPage));

    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "Some dashboard data could not be loaded.",
        );
      });
      const cards = [...document.querySelectorAll('[data-testid="stat-card"]')];
      const campaignsCard = cards.find((card) =>
        card.textContent?.includes("Campaigns"),
      );
      const sentCard = cards.find((card) => card.textContent?.includes("Sent"));
      expect(campaignsCard?.textContent).toContain("—");
      expect(sentCard?.textContent).toContain("—");
      expect(document.body.textContent).toContain("June launch");
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("does not fetch or link protected audit evidence in viewer mode", async () => {
    mocks.whoami.mockResolvedValue({
      user_id: "usr_1",
      tenant_id: "tnt_1",
      email: "ada@example.com",
      role: "owner",
      effective_role: "viewer",
      viewer_mode: true,
      auth_provider: "password",
      email_verified: true,
      workspace_name: "Acme",
      workspace_slug: "acme",
    });
    installOverviewMocks({ subscriberTotal: 12 });

    const { root } = render(createElement(OverviewPage));
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "available to workspace admins",
        );
      });
      expect(mocks.listAuditLog).not.toHaveBeenCalled();
      expect(
        Array.from(document.querySelectorAll("a")).some(
          (link) => link.textContent?.trim() === "New campaign",
        ),
      ).toBe(false);
      expect(
        document.querySelector('a[href="/app/settings/audit"]'),
      ).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });
});
