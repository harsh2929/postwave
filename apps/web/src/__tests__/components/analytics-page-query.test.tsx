// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AnalyticsPage from "@/app/(dashboard)/app/analytics/page";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  dashboardStats: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoami,
}));

vi.mock("@/lib/analytics-api", () => ({
  analyticsApi: {
    dashboardStats: mocks.dashboardStats,
  },
  DASHBOARD_LIVE_PATH: "/api/v1/dashboard/live",
  // Overview widgets fetch these; resolve benign values so the test triggers no
  // real network (which would abort at teardown and spew noise).
  getBenchmarks: vi.fn().mockResolvedValue({ rows: [], note: "" }),
  getSubscriberTimeseries: vi
    .fn()
    .mockResolvedValue({ range: "30d", points: [] }),
  listAnomalies: vi.fn().mockResolvedValue({ items: [] }),
  compareCampaigns: vi.fn().mockResolvedValue([]),
  getDigestPrefs: vi.fn().mockResolvedValue({ frequency: "off" }),
  putDigestPrefs: vi.fn().mockResolvedValue({ ok: true, frequency: "off" }),
}));

vi.mock("@/lib/mailchimp-compat-api", () => ({
  getMailchimpCompatSummary: vi.fn().mockResolvedValue({
    ecommerce: {
      integrations: 0,
      customers: 0,
      products: 0,
      orders: 0,
      revenue_cents: 0,
      attributed_revenue_cents: 0,
    },
  }),
  runInlineAI: vi.fn(),
}));

vi.mock("@/lib/campaigns-api", () => ({
  listCampaigns: vi.fn().mockResolvedValue([]),
}));

// The analytics page lazy-imports each panel from its own module (per-panel
// code-splitting), so stub those modules directly — not a barrel.
vi.mock("@/components/mailchimp-parity/campaign-intelligence-panel", () => ({
  CampaignIntelligencePanel: () =>
    createElement("div", { "data-testid": "campaign-intelligence" }),
}));
vi.mock("@/components/mailchimp-parity/audience-intelligence-panel", () => ({
  AudienceIntelligencePanel: () =>
    createElement("div", { "data-testid": "audience-intelligence" }),
}));
vi.mock("@/components/analytics/human-engaged-reach-panel", () => ({
  HumanEngagedReachPanel: () =>
    createElement("div", { "data-testid": "human-engaged-reach" }),
}));

// The Overview's desktop-parity panels (sequence funnel, reply series, …) read
// through @/lib/api → global fetch rather than the modules mocked above.
// Answer them with a 404 — a state the page genuinely handles — so the test
// never reaches the real network.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ error: { code: "not_found", message: "" } }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
    ),
  );
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

function render(ui: ReactNode): { root: Root } {
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
  return { root };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function settleColdPanelImport(): Promise<void> {
  // AnalyticsOverview is a real next/dynamic boundary. On a cold module graph,
  // React can commit its fallback before Vitest has resolved and rendered the
  // imported module. Await Vitest's dynamic-import barrier rather than relying
  // on an arbitrary number of zero-delay timer turns.
  await act(async () => {
    await vi.dynamicImportSettled();
    await flush();
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await flush();
      });
    }
  }
  throw lastError;
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

const stats = {
  subscribers_total: 1234,
  subscribers_added_30d: 56,
  subscribers_unsubbed_30d: 7,
  campaigns_sent_30d: 8,
  opens_total_30d: 900,
  clicks_total_30d: 123,
  bounces_total_30d: 4,
};

describe("AnalyticsPage query freshness", () => {
  it("loads dashboard stats through a tenant-scoped query", async () => {
    primeAuth();
    mocks.dashboardStats.mockResolvedValueOnce(stats);

    const { root } = render(createElement(AnalyticsPage));

    try {
      await settleColdPanelImport();
      await waitFor(() => {
        expect(document.body.textContent).toContain("1,234");
        expect(document.body.textContent).toContain("Subscribers (total)");
      });
      expect(mocks.dashboardStats).toHaveBeenCalledWith(
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          range: "30d",
        }),
      );
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("shows query errors and retries with the same query", async () => {
    primeAuth();
    mocks.dashboardStats
      .mockRejectedValueOnce(new Error("stats unavailable"))
      .mockResolvedValueOnce(stats);

    const { root } = render(createElement(AnalyticsPage));

    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("stats unavailable");
      });

      const retry = Array.from(document.querySelectorAll("button")).find(
        (button): button is HTMLButtonElement =>
          button instanceof HTMLButtonElement &&
          button.textContent?.trim() === "Retry",
      );
      expect(retry).toBeTruthy();

      await act(async () => {
        retry?.click();
        await flush();
      });

      await waitFor(() => {
        expect(document.body.textContent).toContain("1,234");
      });
      expect(mocks.dashboardStats).toHaveBeenCalledTimes(2);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("re-fetches stats with the chosen range when the selector changes", async () => {
    primeAuth();
    mocks.dashboardStats.mockResolvedValue(stats);

    const { root } = render(createElement(AnalyticsPage));

    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("Subscribers (total)");
      });

      const select = document.querySelector(
        'select[aria-label="Date range"]',
      ) as HTMLSelectElement | null;
      expect(select).toBeTruthy();

      await act(async () => {
        select!.value = "7d";
        select!.dispatchEvent(new Event("change", { bubbles: true }));
        await flush();
      });

      await waitFor(() => {
        expect(mocks.dashboardStats).toHaveBeenCalledWith(
          expect.objectContaining({ range: "7d" }),
        );
      });
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("shows engagement data even with no enabled subscribers or recent sends", async () => {
    primeAuth();
    mocks.dashboardStats.mockResolvedValueOnce({
      ...stats,
      subscribers_total: 0,
      subscribers_added_30d: 0,
      subscribers_unsubbed_30d: 0,
      campaigns_sent_30d: 0,
      opens_total_30d: 9,
      clicks_total_30d: 2,
      bounces_total_30d: 1,
    });

    const { root } = render(createElement(AnalyticsPage));
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("Opens");
        expect(document.body.textContent).not.toContain("No analytics yet");
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("restores Reach from the URL and follows browser history", async () => {
    primeAuth();
    mocks.dashboardStats.mockResolvedValue(stats);
    const nextHistoryState = { __NA: true, key: "analytics" };
    window.history.replaceState(
      nextHistoryState,
      "",
      "/app/analytics?source=campaign&tab=reach#quality",
    );

    const { root } = render(createElement(AnalyticsPage));
    try {
      await waitFor(() => {
        const reachTab = Array.from(
          document.querySelectorAll<HTMLElement>('[role="tab"]'),
        ).find((candidate) => candidate.textContent === "Reach");
        expect(reachTab?.getAttribute("aria-selected")).toBe("true");
        expect(
          document.querySelector('[data-testid="human-engaged-reach"]'),
        ).toBeTruthy();
      });
      expect(
        document.querySelector('[role="tablist"]')?.getAttribute("aria-label"),
      ).toBe("Analytics report view");

      window.history.replaceState(
        window.history.state,
        "",
        "/app/analytics?source=campaign&tab=audience#quality",
      );
      act(() => {
        window.dispatchEvent(new PopStateEvent("popstate"));
      });

      await waitFor(() => {
        const audienceTab = Array.from(
          document.querySelectorAll<HTMLElement>('[role="tab"]'),
        ).find((candidate) => candidate.textContent === "Audience");
        expect(audienceTab?.getAttribute("aria-selected")).toBe("true");
        expect(
          document.querySelector('[data-testid="audience-intelligence"]'),
        ).toBeTruthy();
      });

      const reachTab = Array.from(
        document.querySelectorAll<HTMLElement>('[role="tab"]'),
      ).find((candidate) => candidate.textContent === "Reach");
      expect(reachTab).toBeTruthy();
      await act(async () => {
        reachTab?.click();
        await flush();
      });

      expect(new URLSearchParams(window.location.search).get("tab")).toBe(
        "reach",
      );
      expect(new URLSearchParams(window.location.search).get("source")).toBe(
        "campaign",
      );
      expect(window.location.hash).toBe("#quality");
      expect(window.history.state).toEqual(nextHistoryState);
    } finally {
      act(() => root.unmount());
    }
  });
});
