// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Reachability of the desktop-parity analytics components on the page users
// actually open (/app/analytics). Each component already has its own unit
// test; this file proves the PAGE mounts it — by the request the page issues
// and by what the page renders — so deleting a mount line goes red here.
//
//   analytics-39  SavedViewsMenu            header toolbar
//   analytics-41  AnalyticsExportMenu       header toolbar (replaces "Export CSV")
//   analytics-35  AnalyticsPresentation     Overview, after the KPI rollup; the
//                                           KPI tiles' deltas obey its toggle
//   analytics-45  EngagementTrendPanels     Overview
//   analytics-46/51 CampaignPerformancePanel + RecentBounceMixPanel  Overview
//   analytics-54  TopSequenceFunnelPanel    Overview
//   analytics-38/42 GroupedBreakdownCard    Overview
//   analytics-47  CampaignCompareCard       Overview
//   analytics-17  AnomalyHistoryCard        Overview (replaces RecentAnomaliesCard)
//   analytics-46  CampaignPerformancePanel  Campaign tab
//   analytics-50  RecentCampaignAudiencePanels  Audience tab
//
// Every client funnels through global fetch, so the transport is stubbed at
// that one point and answers by pathname; anything unrouted is a 404.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WHOAMI } from "./_harness";
import {
  importBeforeTests,
  waitFor as waitForDeadline,
  type WaitForOptions,
} from "./_wait";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  downloadTextFile: vi.fn(
    (_name: string, _body: string, _type?: string): void => undefined,
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/analytics",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
  whoamiFresh: vi.fn().mockResolvedValue(WHOAMI),
}));

vi.mock("@/lib/download", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/download")>()),
  downloadTextFile: mocks.downloadTextFile,
}));

// The pre-existing tab panels are not under test here; stub them so the tab
// assertions are about the newly mounted panels beside them.
vi.mock("@/components/mailchimp-parity/campaign-intelligence-panel", () => ({
  CampaignIntelligencePanel: () =>
    createElement("div", { "data-testid": "campaign-intelligence" }),
}));
vi.mock("@/components/mailchimp-parity/audience-intelligence-panel", () => ({
  AudienceIntelligencePanel: () =>
    createElement("div", { "data-testid": "audience-intelligence" }),
}));

import AnalyticsPage from "@/app/(dashboard)/app/analytics/page";

const SEQ = "5b1c2d3e-0000-4000-8000-000000000001";

const STATS = {
  subscribers_total: 1234,
  subscribers_added_30d: 56,
  subscribers_unsubbed_30d: 7,
  campaigns_sent_30d: 8,
  opens_total_30d: 900,
  clicks_total_30d: 123,
  bounces_total_30d: 4,
  unique_opens_30d: 400,
  unique_clicks_30d: 90,
  unique_bounces_30d: 4,
  unique_delivered_30d: 1000,
  unique_sent_30d: 1004,
  emails_sent_30d: 1004,
  active_sequences_count: 1,
  previous: {
    subscribers_added: 40,
    subscribers_unsubbed: 9,
    campaigns_sent: 6,
    opens_total: 700,
    clicks_total: 100,
    bounces_total: 6,
    unique_opens: 300,
    unique_clicks: 70,
    unique_bounces: 6,
    unique_delivered: 900,
    unique_sent: 906,
  },
  sparklines: {
    subscribers: [10, 12, 14],
    opens: [20, 30, 40],
    clicks: [2, 3, 4],
    bounces: [0, 1, 0],
  },
};

const CAMPAIGNS = [
  { id: "c-1", name: "September launch", subject: "s", status: "sent" },
  { id: "c-2", name: "Back in stock", subject: "s", status: "sent" },
  { id: "c-3", name: "Winback", subject: "s", status: "sent" },
];

function report(id: string, sent: number, opens: number, clicks: number) {
  return {
    campaign_id: id,
    sent,
    delivered: sent,
    opens: opens * 2,
    unique_opens: opens,
    clicks: clicks * 2,
    unique_clicks: clicks,
    open_rate: 40,
    click_rate: 10,
  };
}

function compareRow(id: string) {
  return {
    campaign_id: id,
    total_recipients: 1000,
    open_rate: 0.2,
    click_rate: 0.05,
    bounce_rate: 0.01,
    complaint_rate: 0.001,
    unsub_rate: 0.002,
  };
}

function reply(url: URL): { status: number; body: unknown } {
  const path = url.pathname;
  const perCampaign = /^\/api\/v1\/campaigns\/(c-\d)\/([a-z-]+)$/.exec(path);
  if (perCampaign) {
    const [, id, resource] = perCampaign;
    switch (resource) {
      case "report":
        return { status: 200, body: report(id!, 1000, 400, 90) };
      case "bounces":
        return {
          status: 200,
          body: { hard: 4, soft: 10, spam_trap: 1, total: 15 },
        };
      case "devices":
        return {
          status: 200,
          body: [{ client: "Apple Mail", opens: 10, clicks: 2 }],
        };
      case "geography":
        return { status: 200, body: [{ country: "US", opens: 30, clicks: 4 }] };
      case "link-report":
        return {
          status: 200,
          body: [
            {
              url: "https://example.com/pricing",
              clicks: 7,
              unique_clickers: 5,
              ctr: 0.02,
            },
          ],
        };
      default:
        break;
    }
  }
  switch (path) {
    case "/api/v1/dashboard/stats":
      return { status: 200, body: STATS };
    case "/api/v1/campaigns":
      return { status: 200, body: CAMPAIGNS };
    case "/api/v1/replies/timeseries":
      return {
        status: 200,
        body: {
          points: [{ date: "2026-09-10", replies: 3 }],
          window_days: 30,
        },
      };
    case "/api/v1/voice/sequences":
      return { status: 200, body: { items: [{ id: SEQ, name: "Onboarding" }] } };
    case `/api/v1/voice/sequences/${SEQ}/funnel`:
      return {
        status: 200,
        body: {
          sequence_id: SEQ,
          steps: [
            {
              position: 0,
              reached: 1000,
              opened: 400,
              clicked: 100,
              open_rate: 0.4,
              click_rate: 0.1,
              dropoff_pct: 0,
            },
          ],
        },
      };
    case "/api/v1/analytics/campaigns/compare":
      return {
        status: 200,
        body: (url.searchParams.get("ids") ?? "")
          .split(",")
          .filter(Boolean)
          .map(compareRow),
      };
    case "/api/v1/analytics/timeseries":
      return {
        status: 200,
        body: {
          series: [
            {
              key: "c-1",
              label: "September launch",
              points: [
                { date: "2026-09-01", value: 5 },
                { date: "2026-09-02", value: 9 },
              ],
            },
          ],
        },
      };
    case "/api/v1/dashboard/anomalies":
      return {
        status: 200,
        body: {
          items: [
            {
              id: "a1",
              metric: "bounces",
              dayBucket: "2026-09-10T00:00:00Z",
              value: 140,
              mean: 20.4,
              zScore: 4.1,
              rangeUsed: "30d",
              detectedAt: "2026-09-10T06:00:00Z",
            },
          ],
        },
      };
    default:
      return {
        status: 404,
        body: { error: { code: "not_found", message: "" } },
      };
  }
}

let transport: ReturnType<typeof vi.fn>;

function requests(): URL[] {
  return transport.mock.calls.map(([input]) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    return new URL(raw, "http://localhost");
  });
}

function requested(pathname: string): URL[] {
  return requests().filter((url) => url.pathname === pathname);
}

let root: Root | null = null;

async function flush(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

// The page's panels are next/dynamic chunks, so each turn between attempts
// also lets vitest settle any dynamic import still in flight.
function waitFor(
  assertion: () => void,
  options: Omit<WaitForOptions, "step"> = {},
): Promise<void> {
  return waitForDeadline(assertion, {
    ...options,
    step: async () => {
      await vi.dynamicImportSettled();
      await flush();
    },
  });
}

async function renderPage(): Promise<HTMLElement> {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AnalyticsPage),
      ),
    );
  });
  // Wait for the page's lazy panels to finish importing, under a deadline.
  // An act() that awaited vi.dynamicImportSettled() directly had no bound: on
  // a cold, loaded run the first test timed out inside it, the scope closed
  // during the next test's act() calls, and React then stopped flushing, so
  // every later test in the file rendered nothing. This wait absorbs the
  // whole cold import, so it may use all the time its test has left rather
  // than the default budget; the test's own timeout still caps it.
  let importsSettled = false;
  void vi.dynamicImportSettled().then(() => {
    importsSettled = true;
  });
  await waitFor(
    () => {
      if (!importsSettled) {
        throw new Error("the analytics page's lazy panels are still importing");
      }
    },
    { timeoutMs: 10_000 },
  );
  return container;
}

function text(): string {
  return document.body.textContent ?? "";
}

function buttonNamed(name: string): HTMLButtonElement {
  const match = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === name,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`no "${name}" button`);
  }
  return match;
}

function activePanel(): HTMLElement {
  const panel = document.querySelector<HTMLElement>(
    '[role="tabpanel"][data-state="active"]',
  );
  if (!panel) throw new Error("no active tab panel");
  return panel;
}

function kpiDeltaCount(): number {
  return [
    ...document.querySelectorAll<HTMLElement>('[data-testid="analytics-kpi"]'),
  ].filter((tile) =>
    (tile.textContent ?? "").includes("versus the previous period"),
  ).length;
}

async function waitForOverview(): Promise<void> {
  await waitFor(() => {
    expect(text()).toContain("Subscribers (total)");
  });
}

// The page's lazy panels (its next/dynamic chunks, less the two mocked above)
// are cold work for vitest's transform pipeline: on a loaded host the first
// test spent about 6 s importing them. Pay that before any test's 5 s clock
// starts. A panel missing from this list still loads, on its test's clock.
importBeforeTests(
  () => import("@/app/(dashboard)/app/analytics/_overview"),
  () => import("@/components/analytics/saved-views-menu"),
  () => import("@/components/analytics/human-engaged-reach-panel"),
  () => import("@/components/analytics/recent-campaign-panels"),
  () => import("@/components/analytics/lifecycle-revenue-panel"),
);

beforeEach(() => {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  vi.stubGlobal("EventSource", undefined);
  transport = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const { status, body } = reply(new URL(raw, "http://localhost"));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", transport);
  window.history.replaceState(null, "", "/app/analytics");
  try {
    window.localStorage.clear();
  } catch {
    /* storage unavailable */
  }
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  mocks.downloadTextFile.mockClear();
  window.history.replaceState(null, "", "/");
});

describe("analytics page header mounts", () => {
  it("analytics-39: the saved-views menu is in the header and opens its panel", async () => {
    await renderPage();
    await waitForOverview();
    await waitFor(() => expect(buttonNamed("Views").disabled).toBe(false));

    await act(async () => {
      buttonNamed("Views").click();
      await flush();
    });

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain("Saved views");
    expect(dialog?.textContent).toContain("Save current view");
  });

  it("analytics-41: the export menu replaces the bare CSV button and still exports the stats CSV", async () => {
    await renderPage();
    await waitForOverview();

    expect(
      [...document.querySelectorAll("button")].some(
        (b) => b.textContent?.trim() === "Export CSV",
      ),
    ).toBe(false);
    const trigger = buttonNamed("Export");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");

    await act(async () => {
      trigger.click();
      await flush();
    });
    const menu = document.querySelector<HTMLElement>(
      '[role="menu"][aria-label="Export analytics"]',
    );
    expect(menu).toBeTruthy();
    const items = [
      ...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
    ];
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("CSV snapshot"),
      expect.stringContaining("Print / PDF"),
    ]);
    expect(items[0]?.disabled).toBe(false);

    await act(async () => {
      items[0]?.click();
      await flush();
    });
    expect(mocks.downloadTextFile).toHaveBeenCalledTimes(1);
    expect(mocks.downloadTextFile.mock.calls[0]?.[0]).toBe("analytics-30d.csv");
    expect(mocks.downloadTextFile.mock.calls[0]?.[1]).toContain("1234");
  });
});

describe("analytics overview mounts", () => {
  it("analytics-35: rates vs prior period renders after the KPIs, and its toggle hides the KPI tiles' deltas", async () => {
    await renderPage();
    await waitForOverview();
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-testid="analytics-rate-tile"]'),
      ).toHaveLength(5),
    );
    expect(text()).toContain("Rates vs prior period");

    // Compare is on by default: every KPI tile with a prior figure shows it.
    await waitFor(() => expect(kpiDeltaCount()).toBeGreaterThan(0));

    const toggle = [
      ...document.querySelectorAll<HTMLLabelElement>("label"),
    ].find((label) => label.textContent?.includes("Compare with prior period"));
    const checkbox = toggle?.querySelector<HTMLInputElement>("input");
    expect(checkbox?.checked).toBe(true);

    await act(async () => {
      checkbox?.click();
      await flush();
    });

    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get("compare")).toBe(
        "off",
      );
      expect(kpiDeltaCount()).toBe(0);
    });
    // The tiles themselves are still there — only the comparison is hidden.
    expect(
      document.querySelectorAll('[data-testid="analytics-kpi"]').length,
    ).toBeGreaterThan(0);
  });

  it("analytics-43: the mounted charts carry their share/export action menu", async () => {
    await renderPage();
    await waitForOverview();
    await waitFor(() => {
      const menus = [
        ...document.querySelectorAll<HTMLButtonElement>(
          'button[aria-label^="More actions for "]',
        ),
      ].map((button) => button.getAttribute("aria-label"));
      expect(menus).toEqual(
        expect.arrayContaining([
          "More actions for Rates vs prior period",
          "More actions for Engagement velocity",
        ]),
      );
    });
  });

  it("analytics-45: engagement velocity and funnel render and the page asks for the reply series", async () => {
    await renderPage();
    await waitForOverview();
    await waitFor(() => {
      expect(text()).toContain("Engagement velocity");
      expect(text()).toContain("Engagement funnel");
    });
    await waitFor(() =>
      expect(
        requested("/api/v1/replies/timeseries").map((u) =>
          u.searchParams.get("days"),
        ),
      ).toContain("30"),
    );
  });

  it("analytics-46/51: campaign performance and the bounce-type mix read the recent campaigns on the Overview", async () => {
    await renderPage();
    await waitForOverview();
    await waitFor(() => {
      expect(text()).toContain("Campaign performance");
      expect(text()).toContain("Bounce types");
    });
    await waitFor(() => {
      expect(
        requested("/api/v1/campaigns").some(
          (u) =>
            u.searchParams.get("page") === "1" &&
            u.searchParams.get("per_page") === "5",
        ),
      ).toBe(true);
      expect(requested("/api/v1/campaigns/c-1/report")).toHaveLength(1);
      expect(requested("/api/v1/campaigns/c-1/bounces")).toHaveLength(1);
    });
  });

  it("analytics-54: the top sequence funnel reads the first sequence's funnel", async () => {
    await renderPage();
    await waitForOverview();
    await waitFor(() => {
      expect(text()).toContain("Top sequence funnel");
      expect(requested("/api/v1/voice/sequences")).toHaveLength(1);
      expect(requested(`/api/v1/voice/sequences/${SEQ}/funnel`)).toHaveLength(
        1,
      );
    });
  });

  it("analytics-38: the grouped breakdown renders, and a ?group_by link issues the grouped read", async () => {
    window.history.replaceState(
      null,
      "",
      "/app/analytics?group_by=campaign",
    );
    await renderPage();
    await waitForOverview();
    await waitFor(() => {
      expect(text()).toContain("Opens by campaign");
      const grouped = requested("/api/v1/analytics/timeseries");
      expect(grouped.length).toBeGreaterThan(0);
      expect(grouped[0]?.searchParams.get("group_by")).toBe("campaign");
    });
  });

  it("analytics-47: the compare card preselects delivered campaigns and requests their comparison", async () => {
    await renderPage();
    await waitForOverview();
    await waitFor(() => {
      expect(text()).toContain("Compare campaigns");
      const compare = requested("/api/v1/analytics/campaigns/compare");
      expect(compare.length).toBeGreaterThan(0);
      expect(
        (compare[0]?.searchParams.get("ids") ?? "").split(",").length,
      ).toBeGreaterThanOrEqual(2);
    });
  });

  it("analytics-17: the anomaly history card replaces the old list and offers Explain", async () => {
    await renderPage();
    await waitForOverview();
    await waitFor(() => {
      expect(requested("/api/v1/dashboard/anomalies").length).toBeGreaterThan(
        0,
      );
      expect(text()).toContain("Recent anomalies");
      expect(
        document.querySelector(
          '[aria-label^="Ask AI to explain the"][aria-label$="anomaly"]',
        ),
      ).toBeTruthy();
    });
  });
});

describe("analytics tab mounts", () => {
  it("analytics-46: the Campaign tab leads with campaign performance", async () => {
    window.history.replaceState(null, "", "/app/analytics?tab=campaign");
    await renderPage();
    await waitFor(() => {
      const panel = activePanel();
      expect(panel.textContent).toContain("Campaign performance");
      expect(
        panel.querySelector('[data-testid="campaign-intelligence"]'),
      ).toBeTruthy();
      expect(requested("/api/v1/campaigns/c-1/report")).toHaveLength(1);
    });
  });

  it("analytics-50: the Audience tab reads mail-client, country and link mix across recent campaigns", async () => {
    window.history.replaceState(null, "", "/app/analytics?tab=audience");
    await renderPage();
    await waitFor(() => {
      const panel = activePanel();
      expect(panel.textContent).toContain("Mail clients");
      expect(panel.textContent).toContain("Top countries");
      expect(panel.textContent).toContain("Top links");
      expect(
        panel.querySelector('[data-testid="audience-intelligence"]'),
      ).toBeTruthy();
      expect(requested("/api/v1/campaigns/c-1/devices")).toHaveLength(1);
      expect(requested("/api/v1/campaigns/c-1/geography")).toHaveLength(1);
      expect(requested("/api/v1/campaigns/c-1/link-report")).toHaveLength(1);
    });
  });
});
