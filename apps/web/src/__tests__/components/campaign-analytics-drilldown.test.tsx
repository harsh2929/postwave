// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Campaign analytics drill-down (desktop parity row analytics-48). Web could
// read none of the eleven per-campaign analytics routes before this surface,
// so these tests assert the CONSEQUENCE of opening it: which GETs each tab
// issues (exact literal paths), what the answers render as — including the
// unit conversion that separates a genuine 8% open rate from an 800% one —
// and that one resource's refusal costs the reader that card and nothing
// else, in the server's own words.

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  whoami: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: mocks };
});
vi.mock("@/lib/auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-api")>();
  return { ...actual, whoami: mocks.whoami, whoamiFresh: mocks.whoami };
});

const CAMPAIGN_ID = "11111111-2222-4333-8444-555555555555";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => `/app/campaigns/${CAMPAIGN_ID}/analytics`,
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ id: CAMPAIGN_ID }),
}));

import { ApiError } from "@/lib/api";
import { CampaignAnalyticsClient } from "@/app/(dashboard)/app/campaigns/[id]/analytics/campaign-analytics-client";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const BASE = `/api/v1/campaigns/${CAMPAIGN_ID}`;
const PATHS = {
  campaign: BASE,
  report: `${BASE}/report`,
  timeseries: `${BASE}/timeseries`,
  anomalies: `${BASE}/anomalies`,
  goal: `${BASE}/goal-results`,
  locales: `${BASE}/locale-report`,
  links: `${BASE}/link-report`,
  geography: `${BASE}/geography`,
  devices: `${BASE}/devices`,
  bounces: `${BASE}/bounces`,
  engagement: `${BASE}/engagement`,
  benchmark: `${BASE}/benchmark`,
} as const;

/** Rates here are PERCENT-unit, the way analytics.pct() sends them. An
 *  8% open rate that renders as "800%" is the bug this fixture catches. */
const REPORT = {
  campaign_id: CAMPAIGN_ID,
  sent: 1000,
  delivered: 950,
  opens: 120,
  unique_opens: 76,
  clicks: 40,
  unique_clicks: 19,
  bounces: 50,
  complaints: 5,
  unsubscribes: 10,
  open_rate: 8,
  click_rate: 2,
  click_to_open_rate: 25,
  bounce_rate: 5,
  unsub_rate: 1,
  top_links: [{ url: "https://example.com/pricing", clicks: 30 }],
  human_opens: 90,
  human_unique_opens: 60,
  human_clicks: 30,
  human_unique_clicks: 15,
  bot_signatures_applied: ["apple-mpp"],
};

/** Benchmark metric value/baseline are FRACTIONS. */
const BENCHMARK = {
  campaign_id: CAMPAIGN_ID,
  baseline_days: 90,
  baseline_from: "2026-06-01T00:00:00Z",
  baseline_to: "2026-08-30T00:00:00Z",
  as_of: "2026-08-30T10:00:00Z",
  timezone: "UTC",
  baseline_selection: "same_list_type",
  baseline_sample_size: 12,
  minimum_sample_size: 5,
  baseline_available: true,
  this: {
    recipients: 1000,
    open_rate: 0.08,
    click_rate: 0.02,
    bounce_rate: 0.05,
    complaint_rate: 0.005,
    unsubscribe_rate: 0.01,
  },
  tenant_baseline: {
    recipients: 900,
    open_rate: 0.062,
    click_rate: 0.018,
    bounce_rate: 0.04,
    complaint_rate: 0.004,
    unsubscribe_rate: 0.009,
  },
  metrics: [
    {
      name: "open_rate",
      value: 0.08,
      baseline: 0.062,
      delta: 0.018,
      delta_pct: 29,
      percentile: 74,
      verdict: "above",
      available: true,
    },
  ],
};

/** Engagement rates are FRACTIONS. */
const ENGAGEMENT = {
  campaign_id: CAMPAIGN_ID,
  classification_filter: "all",
  delivered: 950,
  human_unique_opens: 60,
  human_open_rate: 0.063,
  raw_open_rate: 0.08,
  reply_count: 14,
  distinct_replyers: 11,
  reply_rate: 0.012,
  open_decoupled_conversions: 4,
  total_attributed_conversions: 9,
  bot_signatures_applied: ["apple-mpp"],
  ai_surfacing_score: 0.42,
  ai_surfacing_basis: ["human_open_rate", "reply_rate"],
  ai_surfacing_confidence_level: "ok",
  ai_surfacing_sample_opens: 60,
};

const FIXTURES: Record<string, unknown> = {
  [PATHS.campaign]: { id: CAMPAIGN_ID, name: "Spring launch" },
  [PATHS.report]: REPORT,
  [PATHS.benchmark]: BENCHMARK,
  [PATHS.engagement]: ENGAGEMENT,
  [PATHS.timeseries]: {
    campaign_id: CAMPAIGN_ID,
    as_of: "2026-08-30T10:00:00Z",
    timezone: "UTC",
    granularity: "hour",
    truncated: false,
    buckets: [
      { hour: "2026-08-29T09:00:00Z", opens: 30, clicks: 8, unsubs: 1 },
      { hour: "2026-08-29T10:00:00Z", opens: 46, clicks: 12, unsubs: 2 },
      { hour: "2026-08-29T11:00:00Z", opens: 44, clicks: 20, unsubs: 7 },
    ],
  },
  [PATHS.goal]: {
    campaign_id: CAMPAIGN_ID,
    goal_event: "checkout_completed",
    goal_window_hours: 72,
    configured: true,
    conversion_count: 12,
    converted_recipients: 12,
    recipients: 950,
    conversion_rate: 0.0126,
    attributed_revenue_cents: 0,
    currency: "",
  },
  [PATHS.anomalies]: {
    campaign_id: CAMPAIGN_ID,
    anomalies: [
      {
        hour: "2026-08-29T11:00:00Z",
        metric: "unsubs",
        value: 7,
        mean: 1.5,
        z_score: 3.1,
        direction: "spike",
      },
    ],
  },
  // Bare arrays — the gateway sends no envelope for these three.
  [PATHS.links]: [
    {
      url: "https://example.com/pricing",
      clicks: 30,
      unique_clickers: 21,
      ctr: 0.022,
    },
    { url: "https://example.com/docs", clicks: 9, unique_clickers: 7, ctr: 0.007 },
  ],
  [PATHS.geography]: [
    { country: "United States", opens: 61, clicks: 14 },
    { country: "Germany", opens: 12, clicks: 3 },
  ],
  [PATHS.devices]: [
    { client: "Apple Mail", opens: 44, clicks: 9 },
    { client: "Gmail", opens: 20, clicks: 6 },
  ],
  [PATHS.locales]: {
    campaign_id: CAMPAIGN_ID,
    locales: [{ locale: "de-DE", sent: 200, opens: 30, clicks: 6 }],
  },
  [PATHS.bounces]: { hard: 30, soft: 15, spam_trap: 5, total: 50 },
};

function identity() {
  return {
    user_id: "usr_1",
    tenant_id: "tnt_1",
    email: "operator@example.com",
    role: "admin",
    effective_role: "admin",
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Acme",
    workspace_slug: "acme",
  };
}

const roots: Root[] = [];

function render(ui: ReactNode): void {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, networkMode: "always", gcTime: 0 },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
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

function requestedPaths(): string[] {
  return mocks.get.mock.calls.map((call) => String(call[0]));
}

function pageText(): string {
  return document.body.textContent ?? "";
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.includes(text) === true,
  );
  if (!found) throw new Error(`Button "${text}" not found`);
  return found;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await flush();
  });
}

async function openTab(label: string): Promise<void> {
  await click(button(label));
  await act(async () => {
    await flush();
  });
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.whoami.mockResolvedValue(identity());
  mocks.get.mockImplementation(async (path: string) => {
    if (path in FIXTURES) return FIXTURES[path];
    throw new ApiError("No fixture recorded for this route.", 404);
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("campaign analytics drill-down (analytics-48)", () => {
  it("reads the overview's six resources and renders percent-unit report rates as themselves", async () => {
    render(createElement(CampaignAnalyticsClient));
    await waitFor(() => expect(pageText()).toContain("Spring launch"));
    await waitFor(() => expect(pageText()).toContain("checkout_completed"));

    // The overview's six GETs, at their literal mounted paths.
    for (const path of [
      PATHS.report,
      PATHS.benchmark,
      PATHS.engagement,
      PATHS.timeseries,
      PATHS.goal,
      PATHS.anomalies,
    ]) {
      expect(requestedPaths()).toContain(path);
    }
    // …and nothing belonging to another tab.
    for (const path of [
      PATHS.links,
      PATHS.geography,
      PATHS.devices,
      PATHS.locales,
      PATHS.bounces,
    ]) {
      expect(requestedPaths()).not.toContain(path);
    }

    const text = pageText();
    // open_rate 8 is PERCENT-unit: 8.0%, not 800%.
    expect(text).toContain("8.0%");
    expect(text).not.toContain("800%");
    expect(text).toContain("1,000"); // sent
    expect(text).toContain("25%"); // click-to-open

    // Benchmark: fraction-unit value/baseline, a stated verdict, signed delta.
    expect(text).toContain("6.2%");
    expect(text).toContain("+29.0%");
    expect(text).toContain("above");
    expect(text).not.toContain("Baseline verdicts are withheld");

    // Trust signals: bot-stripped human rate plus what was stripped.
    expect(text).toContain("Human open rate");
    expect(text).toContain("6.3%");
    expect(text).toContain("1.7pp bot inflation");
    expect(text).toContain("apple-mpp");
    // The AI-surfacing number never appears without being called an estimate.
    expect(text).toContain("AI-surfacing estimate");
    expect(text).toContain("42%");

    // Anomaly, goal, funnel.
    expect(text).toContain("spike");
    expect(text).toContain("+3.10σ");
    expect(text).toContain("within 3d");
    expect(text).toContain("1.3%"); // conversion_rate is a FRACTION
    // The goal response carried no currency, so the attributed amount is
    // named unavailable rather than summed into a currency-less number.
    expect(text).toContain("Goal revenue");
    expect(text).toContain("Unavailable");
    expect(text).toContain("No currency-qualified monetary conversion was recorded");
    expect(text).toContain("Funnel");
    expect(text).toContain("95%"); // delivered / sent
  });

  it("reads the audience tab's four resources, parsing the bare-array routes", async () => {
    render(createElement(CampaignAnalyticsClient));
    await waitFor(() => expect(pageText()).toContain("Spring launch"));

    await openTab("Audience & links");
    await waitFor(() => expect(pageText()).toContain("example.com/pricing"));

    for (const path of [
      PATHS.links,
      PATHS.geography,
      PATHS.devices,
      PATHS.locales,
    ]) {
      expect(requestedPaths()).toContain(path);
    }
    expect(requestedPaths()).not.toContain(PATHS.bounces);

    const text = pageText();
    // link-report / geography / devices answer with bare arrays; a reader that
    // expected an envelope would render three empty cards here.
    expect(text).toContain("30 clicks · 21 unique · 2.2% CTR");
    expect(text).toContain("United States");
    expect(text).toContain("61 opens · 14 clicks");
    expect(text).toContain("Apple Mail");
    expect(text).toContain("de-DE");
    expect(text).toContain("15% open rate"); // 30 opens / 200 sent
  });

  it("reads the delivery tab's bounce classification and splits it by class", async () => {
    render(createElement(CampaignAnalyticsClient));
    await waitFor(() => expect(pageText()).toContain("Spring launch"));

    await openTab("Delivery");
    await waitFor(() => expect(pageText()).toContain("Bounce mix"));

    expect(requestedPaths()).toContain(PATHS.bounces);

    const text = pageText();
    expect(text).toContain("50 bounce events classified.");
    expect(text).toContain("30 · 60%"); // hard
    expect(text).toContain("15 · 30%"); // soft
    expect(text).toContain("5 · 10%"); // spam trap
    // Delivery totals reuse the percent-unit report rates.
    expect(text).toContain("Bounce rate");
    expect(text).toContain("5.0%");
  });

  it("isolates one resource's refusal, renders the server's own sentence, and retries only that route", async () => {
    const DENIAL = "Your role does not permit reading campaign geography.";
    mocks.get.mockImplementation(async (path: string) => {
      if (path === PATHS.geography) throw new ApiError(DENIAL, 403);
      if (path in FIXTURES) return FIXTURES[path];
      throw new ApiError("No fixture recorded for this route.", 404);
    });

    render(createElement(CampaignAnalyticsClient));
    await waitFor(() => expect(pageText()).toContain("Spring launch"));
    await openTab("Audience & links");
    await waitFor(() => expect(pageText()).toContain(DENIAL));

    // The refusal is the server's sentence, not an invented one.
    expect(pageText()).toContain("Couldn't load the geography report");
    expect(pageText()).toContain(DENIAL);
    // …and it cost only the geography card: its neighbours still rendered.
    expect(pageText()).toContain("Apple Mail");
    expect(pageText()).toContain("example.com/pricing");
    expect(pageText()).toContain("de-DE");

    const before = requestedPaths().filter(
      (path) => path === PATHS.geography,
    ).length;
    await click(button("Retry the geography report"));
    await waitFor(() =>
      expect(
        requestedPaths().filter((path) => path === PATHS.geography).length,
      ).toBe(before + 1),
    );
    // Retrying one card must not re-read its neighbours.
    expect(requestedPaths().filter((path) => path === PATHS.devices)).toHaveLength(
      1,
    );
  });

  it("withholds benchmark verdicts when the baseline is thinner than the server's own minimum", async () => {
    mocks.get.mockImplementation(async (path: string) => {
      if (path === PATHS.benchmark) {
        return {
          ...BENCHMARK,
          baseline_sample_size: 3,
          baseline_available: true,
          baseline_unavailable_reason: "insufficient_sample",
        };
      }
      if (path in FIXTURES) return FIXTURES[path];
      throw new ApiError("No fixture recorded for this route.", 404);
    });

    render(createElement(CampaignAnalyticsClient));
    await waitFor(() =>
      expect(pageText()).toContain("Baseline verdicts are withheld"),
    );

    const text = pageText();
    expect(text).toContain("Reason: insufficient sample.");
    expect(text).toContain("withheld");
    // The descriptive rates stay; only the judgement is withheld.
    expect(text).toContain("6.2%");
    expect(text).not.toContain(">above<");
  });
});
