// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Analytics campaign-derived panels (desktop parity rows analytics-45 / 46 /
// 50 / 51). Asserted by consequence: the exact GETs each panel issues (and the
// ones it must NOT issue), the totals it draws from the five recent campaigns,
// where a campaign click goes (the analytics drill-down, not the editor), the
// benchmark verdict vs the explicit "withheld", and — for every read — that a
// refusal renders the server's own sentence with a Retry that re-asks, never a
// zero or a partial total.

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: mocks };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/app/analytics",
  useSearchParams: () => new URLSearchParams(),
}));

import { ApiError } from "@/lib/api";
import type { DashboardStats } from "@/lib/analytics-api";
import { EngagementTrendPanels } from "@/components/analytics/engagement-trend-panels";
import {
  CampaignPerformancePanel,
  RecentBounceMixPanel,
  RecentCampaignAudiencePanels,
} from "@/components/analytics/recent-campaign-panels";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SCOPE = { tenantId: TENANT, role: "viewer" };
const LIST_PATH = "/api/v1/campaigns?page=1&per_page=5";
const DENIAL = "Your role cannot read campaign reports in this workspace.";

const CAMPAIGNS = [
  { id: "c-1", name: "September launch", subject: "s", status: "sent" },
  { id: "c-2", name: "", subject: "Back in stock", status: "sent" },
  { id: "c-3", name: "Winback", subject: "s", status: "sent" },
];

function report(
  id: string,
  sent: number,
  uniqueOpens: number,
  uniqueClicks: number,
) {
  return {
    campaign_id: id,
    sent,
    delivered: sent,
    opens: uniqueOpens * 2,
    unique_opens: uniqueOpens,
    clicks: uniqueClicks * 2,
    unique_clicks: uniqueClicks,
    open_rate: 40,
    click_rate: 10,
  };
}

const BENCHMARK_OK = {
  campaign_id: "c-1",
  baseline_days: 90,
  baseline_sample_size: 12,
  minimum_sample_size: 5,
  baseline_available: true,
  metrics: [
    {
      name: "open_rate",
      value: 0.4,
      baseline: 0.3,
      delta: 0.1,
      delta_pct: 33.3,
      verdict: "above",
      available: true,
    },
    {
      name: "bounce_rate",
      value: 0.05,
      baseline: 0.02,
      delta: 0.03,
      delta_pct: 150,
      verdict: "below",
      available: true,
    },
    {
      name: "complaint_rate",
      value: 0,
      baseline: 0,
      delta: 0,
      delta_pct: null,
      verdict: "",
      available: false,
      reason: "baseline_zero",
    },
  ],
};

type Routes = Record<string, unknown | (() => unknown)>;
let routes: Routes;

function paths(): string[] {
  return mocks.get.mock.calls.map((call) => String(call[0]));
}

let root: Root | null = null;

async function flush() {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => flush());
    }
  }
  throw lastError;
}

async function render(element: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    root = createRoot(container);
    root.render(createElement(QueryClientProvider, { client }, element));
  });
  await act(async () => flush());
  return container;
}

function text(): string {
  return document.body.textContent ?? "";
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!match) throw new Error(`no ${label} button`);
  return match as HTMLButtonElement;
}

beforeEach(() => {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  window.history.replaceState(null, "", "/app/analytics");
  routes = {
    [LIST_PATH]: CAMPAIGNS,
  };
  mocks.get.mockReset();
  mocks.get.mockImplementation(async (path: string) => {
    if (path in routes) {
      const value = routes[path];
      return typeof value === "function" ? (value as () => unknown)() : value;
    }
    throw new ApiError("No fixture recorded for this route.", 404);
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

/* ------------------------------------------------------------------------- */

describe("campaign performance panel (analytics-46)", () => {
  beforeEach(() => {
    routes["/api/v1/campaigns/c-1/report"] = report("c-1", 1000, 400, 90);
    routes["/api/v1/campaigns/c-2/report"] = report("c-2", 500, 120, 30);
    routes["/api/v1/campaigns/c-3/report"] = report("c-3", 200, 50, 5);
    routes["/api/v1/campaigns/c-1/benchmark"] = BENCHMARK_OK;
  });

  it("reads the recent five, one report per campaign, and the LATEST campaign's benchmark only", async () => {
    await render(createElement(CampaignPerformancePanel, SCOPE));
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-testid="campaign-performance-row"]'),
      ).toHaveLength(3),
    );
    const requested = paths();
    expect(requested).toContain(LIST_PATH);
    expect(requested.filter((p) => p.endsWith("/report")).sort()).toEqual([
      "/api/v1/campaigns/c-1/report",
      "/api/v1/campaigns/c-2/report",
      "/api/v1/campaigns/c-3/report",
    ]);
    expect(requested.filter((p) => p.endsWith("/benchmark"))).toEqual([
      "/api/v1/campaigns/c-1/benchmark",
    ]);
    // No audience or bounce reads from this panel.
    expect(
      requested.filter((p) =>
        /\/(devices|geography|link-report|bounces)$/.test(p),
      ),
    ).toEqual([]);

    const rows = [
      ...document.querySelectorAll('[data-testid="campaign-performance-row"]'),
    ].map((row) => row.textContent);
    expect(rows[0]).toContain("September launch");
    expect(rows[0]).toContain("400 opens · 90 clicks");
    // Empty name falls back to the subject, like desktop.
    expect(rows[1]).toContain("Back in stock");
    expect(rows[1]).toContain("120 opens · 30 clicks");
  });

  it("links each campaign to its analytics drill-down, not the editor", async () => {
    await render(createElement(CampaignPerformancePanel, SCOPE));
    await waitFor(() =>
      expect(
        document.querySelector('a[aria-label="Open analytics for Winback"]'),
      ).not.toBeNull(),
    );
    const hrefs = [
      ...document.querySelectorAll<HTMLAnchorElement>(
        '[data-testid="campaign-performance-row"] a',
      ),
    ].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([
      "/app/campaigns/c-1/analytics",
      "/app/campaigns/c-2/analytics",
      "/app/campaigns/c-3/analytics",
    ]);
  });

  it("renders the server's verdicts for the latest campaign, and omits a metric the server withheld", async () => {
    await render(createElement(CampaignPerformancePanel, SCOPE));
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-testid="benchmark-verdict"]'),
      ).toHaveLength(2),
    );
    const verdicts = [
      ...document.querySelectorAll('[data-testid="benchmark-verdict"]'),
    ].map((v) => v.textContent);
    expect(verdicts[0]).toContain("open rate");
    expect(verdicts[0]).toContain("above baseline");
    expect(verdicts[0]).toContain("(+33.3%)");
    expect(verdicts[1]).toContain("bounce rate");
    expect(verdicts[1]).toContain("below baseline");
    expect(text()).not.toContain("complaint rate");
    expect(text()).toContain("90-day baseline of 12 prior campaigns");
  });

  it("withholds every verdict when the baseline is thinner than the minimum", async () => {
    routes["/api/v1/campaigns/c-1/benchmark"] = {
      ...BENCHMARK_OK,
      baseline_sample_size: 3,
      baseline_unavailable_reason: "insufficient_history",
    };
    await render(createElement(CampaignPerformancePanel, SCOPE));
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="benchmark-withheld"]'),
      ).not.toBeNull(),
    );
    expect(
      document.querySelector('[data-testid="benchmark-withheld"]')?.textContent,
    ).toContain("Benchmark withheld · 3/5 required prior campaigns");
    expect(text()).toContain("(insufficient history)");
    expect(
      document.querySelectorAll('[data-testid="benchmark-verdict"]'),
    ).toHaveLength(0);
    expect(text()).not.toContain("above baseline");
  });

  it("a refused report renders the server's sentence, and Retry re-asks for exactly that report", async () => {
    let denied = true;
    routes["/api/v1/campaigns/c-2/report"] = () => {
      if (denied) throw new ApiError(DENIAL, 403);
      return report("c-2", 500, 120, 30);
    };
    await render(createElement(CampaignPerformancePanel, SCOPE));
    await waitFor(() => expect(text()).toContain(DENIAL));
    expect(text()).toContain("1 of 3 campaign reports couldn't be loaded.");
    // The two reports that did load still render; the refused one is absent,
    // not drawn as zero.
    expect(
      document.querySelectorAll('[data-testid="campaign-performance-row"]'),
    ).toHaveLength(2);
    expect(text()).not.toContain("Back in stock");

    const before = paths().filter(
      (p) => p === "/api/v1/campaigns/c-2/report",
    ).length;
    denied = false;
    await act(async () => button("Retry").click());
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-testid="campaign-performance-row"]'),
      ).toHaveLength(3),
    );
    expect(
      paths().filter((p) => p === "/api/v1/campaigns/c-2/report").length,
    ).toBe(before + 1);
    expect(text()).not.toContain(DENIAL);
  });

  it("a refused campaign list renders the server's sentence and fetches no reports", async () => {
    routes[LIST_PATH] = () => {
      throw new ApiError(DENIAL, 403);
    };
    await render(createElement(CampaignPerformancePanel, SCOPE));
    await waitFor(() => expect(text()).toContain(DENIAL));
    expect(text()).toContain("Recent campaigns couldn't be loaded.");
    expect(paths().filter((p) => p.endsWith("/report"))).toEqual([]);
  });

  it("makes no request at all before the identity has resolved", async () => {
    await render(
      createElement(CampaignPerformancePanel, { tenantId: "anon", role: null }),
    );
    expect(paths()).toEqual([]);
  });
});

/* ------------------------------------------------------------------------- */

describe("audience panels (analytics-50)", () => {
  beforeEach(() => {
    routes["/api/v1/campaigns/c-1/devices"] = [
      { client: "Apple Mail", opens: 10, clicks: 2 },
      { client: "Gmail", opens: 5, clicks: 1 },
    ];
    routes["/api/v1/campaigns/c-2/devices"] = [
      { client: "Apple Mail", opens: 20, clicks: 3 },
      { client: "", opens: 5, clicks: 0 },
    ];
    routes["/api/v1/campaigns/c-3/devices"] = [];
    routes["/api/v1/campaigns/c-1/geography"] = [
      { country: "US", opens: 30, clicks: 4 },
    ];
    routes["/api/v1/campaigns/c-2/geography"] = [
      { country: "US", opens: 12, clicks: 1 },
      { country: "DE", opens: 9, clicks: 2 },
    ];
    routes["/api/v1/campaigns/c-3/geography"] = [];
    routes["/api/v1/campaigns/c-1/link-report"] = [
      {
        url: "https://example.com/pricing",
        clicks: 7,
        unique_clickers: 5,
        ctr: 0.02,
      },
      { url: "javascript:alert(1)", clicks: 1, unique_clickers: 1, ctr: 0 },
    ];
    routes["/api/v1/campaigns/c-2/link-report"] = [
      {
        url: "https://example.com/pricing",
        clicks: 4,
        unique_clickers: 3,
        ctr: 0.05,
      },
    ];
    routes["/api/v1/campaigns/c-3/link-report"] = [];
  });

  it("fetches devices, geography and link-report per recent campaign — and no reports", async () => {
    await render(createElement(RecentCampaignAudiencePanels, SCOPE));
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-testid="donut-slice"]').length,
      ).toBeGreaterThan(0),
    );
    const requested = paths();
    for (const resource of ["devices", "geography", "link-report"]) {
      expect(
        requested.filter((p) => p.endsWith(`/${resource}`)).sort(),
      ).toEqual([
        `/api/v1/campaigns/c-1/${resource}`,
        `/api/v1/campaigns/c-2/${resource}`,
        `/api/v1/campaigns/c-3/${resource}`,
      ]);
    }
    expect(
      requested.filter((p) => /\/(report|benchmark|bounces)$/.test(p)),
    ).toEqual([]);
  });

  it("sums the mail-client mix across campaigns, with the unnamed client as Unknown", async () => {
    await render(createElement(RecentCampaignAudiencePanels, SCOPE));
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-testid="donut-slice"]'),
      ).toHaveLength(3),
    );
    const slices = [
      ...document.querySelectorAll('[data-testid="donut-slice"]'),
    ].map((s) => s.textContent);
    // 10 + 20 = 30 of 40 opens.
    expect(slices[0]).toContain("Apple Mail");
    expect(slices[0]).toContain("30 · 75.0%");
    expect(slices.join("|")).toContain("Unknown");
    expect(text()).toContain("40opens");
  });

  it("ranks countries by summed opens", async () => {
    await render(createElement(RecentCampaignAudiencePanels, SCOPE));
    await waitFor(() => expect(text()).toContain("42 opens · 5 clicks"));
    const list = document.querySelector(
      '[aria-label="Top countries by opens"]',
    );
    const items = [...(list?.querySelectorAll("li") ?? [])].map(
      (li) => li.textContent,
    );
    expect(items[0]).toContain("US");
    expect(items[0]).toContain("42 opens · 5 clicks");
    expect(items[1]).toContain("DE");
    expect(items[1]).toContain("9 opens · 2 clicks");
  });

  it("opens an http(s) destination in a new tab, and never makes a javascript: destination a link", async () => {
    await render(createElement(RecentCampaignAudiencePanels, SCOPE));
    await waitFor(() =>
      expect(document.querySelector('[data-testid="top-link"]')).not.toBeNull(),
    );
    const link = document.querySelector<HTMLAnchorElement>(
      '[data-testid="top-link"]',
    );
    expect(link?.getAttribute("href")).toBe("https://example.com/pricing");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    // 7 + 4 clicks, 5 + 3 summed campaign-uniques.
    expect(text()).toContain("11 clicks · 8 campaign-unique");
    const inert = document.querySelector('[data-testid="top-link-inert"]');
    expect(inert?.textContent).toBe("javascript:alert(1)");
    expect(
      [...document.querySelectorAll("a")].some((a) =>
        (a.getAttribute("href") ?? "").startsWith("javascript:"),
      ),
    ).toBe(false);
  });

  it("one campaign's refused geography costs the country card its total — no partial sum — in the server's words", async () => {
    let denied = true;
    routes["/api/v1/campaigns/c-2/geography"] = () => {
      if (denied) throw new ApiError(DENIAL, 403);
      return [{ country: "US", opens: 12, clicks: 1 }];
    };
    await render(createElement(RecentCampaignAudiencePanels, SCOPE));
    await waitFor(() => expect(text()).toContain(DENIAL));
    expect(text()).toContain("The country breakdown couldn't be loaded.");
    // c-1's 30 US opens must not be presented as the recent-campaign total.
    expect(
      document.querySelector('[aria-label="Top countries by opens"]'),
    ).toBeNull();
    // The other cards are unaffected.
    expect(
      document.querySelectorAll('[data-testid="donut-slice"]'),
    ).toHaveLength(3);

    denied = false;
    await act(async () => button("Retry").click());
    await waitFor(() => expect(text()).toContain("US42 opens · 5 clicks"));
    expect(text()).not.toContain(DENIAL);
  });
});

/* ------------------------------------------------------------------------- */

describe("bounce-type mix (analytics-51)", () => {
  beforeEach(() => {
    routes["/api/v1/campaigns/c-1/bounces"] = {
      hard: 4,
      soft: 10,
      spam_trap: 1,
      total: 15,
    };
    routes["/api/v1/campaigns/c-2/bounces"] = {
      hard: 2,
      soft: 3,
      spam_trap: 0,
      total: 6,
    };
    routes["/api/v1/campaigns/c-3/bounces"] = {
      hard: 0,
      soft: 0,
      spam_trap: 0,
      total: 2,
    };
  });

  it("fetches bounces per recent campaign and draws the summed hard / soft / spam-trap mix", async () => {
    await render(createElement(RecentBounceMixPanel, SCOPE));
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-testid="donut-slice"]'),
      ).toHaveLength(3),
    );
    expect(
      paths()
        .filter((p) => p.endsWith("/bounces"))
        .sort(),
    ).toEqual([
      "/api/v1/campaigns/c-1/bounces",
      "/api/v1/campaigns/c-2/bounces",
      "/api/v1/campaigns/c-3/bounces",
    ]);
    const slices = [
      ...document.querySelectorAll('[data-testid="donut-slice"]'),
    ].map((s) => s.textContent);
    expect(slices[0]).toContain("Hard");
    expect(slices[0]).toContain("6 · 30.0%");
    expect(slices[1]).toContain("Soft");
    expect(slices[1]).toContain("13 · 65.0%");
    expect(slices[2]).toContain("Spam trap");
    expect(slices[2]).toContain("1 · 5.0%");
    // Total 23 exceeds the typed 20: the gap is said, not hidden.
    expect(text()).toContain("3 of 23 bounces carry no type.");
    expect(text()).toContain("not limited to the selected range");
  });

  it("a refused bounce read renders the server's sentence and no mix", async () => {
    routes["/api/v1/campaigns/c-3/bounces"] = () => {
      throw new ApiError(DENIAL, 403);
    };
    await render(createElement(RecentBounceMixPanel, SCOPE));
    await waitFor(() => expect(text()).toContain(DENIAL));
    expect(text()).toContain("The bounce breakdown couldn't be loaded.");
    expect(
      document.querySelectorAll('[data-testid="donut-slice"]'),
    ).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------- */

function stats(overrides: Partial<DashboardStats> = {}): DashboardStats {
  return {
    subscribers_total: 100,
    subscribers_added_30d: 10,
    subscribers_unsubbed_30d: 1,
    campaigns_sent_30d: 3,
    opens_total_30d: 500,
    clicks_total_30d: 700,
    bounces_total_30d: 40,
    emails_sent_30d: 2000,
    unique_sent_30d: 1000,
    unique_delivered_30d: 960,
    unique_opens_30d: 400,
    unique_clicks_30d: 100,
    sparklines: {
      opens: [1, 2, 3, 4, 5, 6, 7],
      clicks: [0, 1, 0, 2, 1, 0, 3],
    },
    ...overrides,
  } as DashboardStats;
}

describe("engagement velocity + funnel (analytics-45)", () => {
  function repliesPath(days: number) {
    return `/api/v1/replies/timeseries?days=${days}`;
  }

  beforeEach(() => {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    routes[repliesPath(7)] = {
      window_days: 7,
      points: [
        { date: yesterday, replies: 9 },
        { date: today, replies: 4 },
      ],
    };
    routes[repliesPath(90)] = { window_days: 90, points: [] };
  });

  it("asks for replies over the selected range and draws opens, clicks and replies", async () => {
    await render(
      createElement(EngagementTrendPanels, {
        stats: stats(),
        range: "7d",
        ...SCOPE,
      }),
    );
    await waitFor(() => expect(paths()).toContain(repliesPath(7)));
    expect(paths().filter((p) => p.startsWith("/api/v1/replies/"))).toEqual([
      repliesPath(7),
    ]);
    const legend = [
      ...document.querySelectorAll('[data-testid="velocity-legend"]'),
    ].map((li) => li.textContent);
    expect(legend[0]).toContain("Opens28");
    expect(legend[1]).toContain("Clicks7");
    // Replies line totals the returned points (9 + 4).
    expect(legend).toHaveLength(3);
    await waitFor(() =>
      expect(
        [...document.querySelectorAll('[data-testid="velocity-legend"]')][2]
          ?.textContent,
      ).toContain("Replies13"),
    );
    expect(document.querySelector('path[data-series="opens"]')).not.toBeNull();
    expect(
      document.querySelector('path[data-series="replies"]')?.getAttribute("d"),
    ).toMatch(/^M[\d.]+,[\d.]+ L640\.0,/);
  });

  it("follows the range: 90d asks for 90 days", async () => {
    await render(
      createElement(EngagementTrendPanels, {
        stats: stats(),
        range: "90d",
        ...SCOPE,
      }),
    );
    await waitFor(() => expect(paths()).toContain(repliesPath(90)));
    expect(text()).toContain("last 90 days");
  });

  it("uses unique recipients instead of repeat event totals and states the step conversion", async () => {
    await render(
      createElement(EngagementTrendPanels, {
        stats: stats(),
        range: "7d",
        ...SCOPE,
      }),
    );
    const steps = [
      ...document.querySelectorAll('[data-testid="funnel-step"]'),
    ].map((li) => [li.getAttribute("data-step"), li.textContent]);
    expect(steps.map(([step]) => step)).toEqual([
      "Sent",
      "Delivered",
      "Opened",
      "Clicked",
    ]);
    // 2,000 sent events, 500 opens and 700 clicks must not replace unique counts.
    expect(steps[0]?.[1]).toContain("1,000");
    expect(steps[1]?.[1]).toContain("960 · 96.0% of sent");
    expect(steps[2]?.[1]).toContain("400 · 41.7% of delivered");
    expect(steps[3]?.[1]).toContain("100 · 25.0% of opened");
  });

  it("withholds the funnel when unique-recipient counts are missing", async () => {
    await render(
      createElement(EngagementTrendPanels, {
        stats: stats({ unique_sent_30d: undefined }),
        range: "7d",
        ...SCOPE,
      }),
    );
    expect(
      document.querySelectorAll('[data-testid="funnel-step"]'),
    ).toHaveLength(0);
    expect(text()).toContain(
      "Unique-recipient counts are unavailable for this window",
    );
  });

  it("a refused replies read drops the replies line and says so in the server's words", async () => {
    routes[repliesPath(7)] = () => {
      throw new ApiError(DENIAL, 403);
    };
    await render(
      createElement(EngagementTrendPanels, {
        stats: stats(),
        range: "7d",
        ...SCOPE,
      }),
    );
    await waitFor(() => expect(text()).toContain(DENIAL));
    expect(text()).toContain("Replies couldn't be loaded");
    expect(document.querySelector('path[data-series="replies"]')).toBeNull();
    expect(
      [...document.querySelectorAll('[data-testid="velocity-legend"]')][2]
        ?.textContent,
    ).toContain("Replies—");
    // Opens/clicks still draw.
    expect(document.querySelector('path[data-series="opens"]')).not.toBeNull();
  });
});
