// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  CampaignAttributionResponse,
  RevenueAttributionItem,
  RevenueTimeseriesResponse,
} from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  campaigns: vi.fn(),
  timeseries: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  revenueAttributionApi: {
    campaigns: mocks.campaigns,
    timeseries: mocks.timeseries,
  },
}));

vi.mock("../../components/InlineHelp", () => ({
  InlineHelp: () => null,
}));

vi.mock("../../components/common/Provenance", () => ({
  ComputedFrom: ({ n, m }: { n: number; m: number }) => (
    <span>
      top {n} of {m}
    </span>
  ),
}));

vi.mock("../../components/charts/LineChart", () => ({
  LineChart: ({
    data,
    xTickStride,
  }: {
    data: Array<{ date: string; count: number }>;
    xTickStride: number;
  }) => (
    <div data-testid="line-chart" data-stride={xTickStride}>
      {JSON.stringify(data)}
    </div>
  ),
}));

import { RevenueAttributionSection } from "../../components/analytics/RevenueAttributionSection";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.campaigns.mockResolvedValue({ data: attribution() });
  mocks.timeseries.mockResolvedValue({ data: timeseries() });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function campaign(
  id = "campaign-1",
  overrides: Partial<RevenueAttributionItem> = {},
): RevenueAttributionItem {
  return {
    campaign_id: id,
    campaign_name: id === "campaign-1" ? "Launch campaign" : `${id} campaign`,
    conversions: 4,
    revenue_cents: 12_500,
    emails_sent: 1000,
    revenue_per_send_cents: 12.5,
    ...overrides,
  };
}

function attribution(
  overrides: Partial<CampaignAttributionResponse> = {},
): CampaignAttributionResponse {
  return {
    items: [campaign()],
    total_revenue_cents: 12_500,
    unattributed_cents: 2500,
    unattributed_conversions: 1,
    currency: "USD",
    currencies: [{ currency: "USD", conversions: 5, revenue_cents: 15_000 }],
    total_campaigns: 1,
    days: 30,
    ...overrides,
  };
}

function timeseries(
  overrides: Partial<RevenueTimeseriesResponse> = {},
): RevenueTimeseriesResponse {
  return {
    points: [
      { date: "2026-07-15", revenue_cents: 5000, conversions: 2 },
      { date: "2026-07-16", revenue_cents: 7500, conversions: 2 },
    ],
    currency: "USD",
    currencies: [{ currency: "USD", conversions: 4, revenue_cents: 12_500 }],
    days: 30,
    ...overrides,
  };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function render(node: ReactElement): {
  rerender: (next: ReactElement) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return {
    rerender(next) {
      act(() => root?.render(next));
    },
  };
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

async function selectCampaign(value: string): Promise<void> {
  const select = document.querySelector<HTMLSelectElement>(
    'select[aria-label="Filter revenue timeseries by campaign"]',
  );
  if (!select) throw new Error("Missing campaign filter");
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => Promise.resolve());
    }
  }
  throw lastError;
}

describe("RevenueAttributionSection", () => {
  it("loads the exact report fanout and renders honest totals and chart units", async () => {
    render(<RevenueAttributionSection days={30} />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Launch campaign"),
    );

    expect(mocks.campaigns).toHaveBeenCalledWith({ days: 30 });
    expect(mocks.timeseries).toHaveBeenCalledWith({ days: 30 });
    expect(document.body.textContent).toContain("Unattributed");
    expect(document.body.textContent).toContain("1 conversion");
    expect(document.body.textContent).toContain("campaigns only");
    const chart = document.querySelector('[data-testid="line-chart"]');
    expect(chart?.textContent).toContain('"count":50');
    expect(chart?.getAttribute("data-stride")).toBe("5");
  });

  it("renders refund-only and zero-net offsetting monetary activity", async () => {
    mocks.campaigns.mockResolvedValue({
      data: attribution({
        items: [
          campaign("campaign-1", {
            conversions: 1,
            revenue_cents: -2500,
          }),
        ],
        total_revenue_cents: -2500,
        currencies: [{ currency: "USD", conversions: 1, revenue_cents: -2500 }],
      }),
    });
    mocks.timeseries.mockResolvedValue({
      data: timeseries({
        points: [
          { date: "2026-07-15", revenue_cents: 5000, conversions: 1 },
          { date: "2026-07-16", revenue_cents: -5000, conversions: 1 },
        ],
      }),
    });
    render(<RevenueAttributionSection days={30} />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Launch campaign"),
    );

    expect(document.body.textContent).toContain(
      "Workspace conversion revenue (net)",
    );
    expect(document.body.textContent).toContain("-$25");
    const chart = document.querySelector('[data-testid="line-chart"]');
    expect(chart?.textContent).toContain('"count":-50');
  });

  it("passes the selected campaign UUID to the timeseries endpoint", async () => {
    render(<RevenueAttributionSection days={30} />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Launch campaign"),
    );
    await selectCampaign("campaign-1");

    await waitFor(() => expect(mocks.timeseries).toHaveBeenCalledTimes(2));
    expect(mocks.timeseries).toHaveBeenLastCalledWith({
      days: 30,
      campaignId: "campaign-1",
    });
  });

  it("resets a hidden campaign filter after refreshed attribution drops it", async () => {
    mocks.timeseries
      .mockResolvedValueOnce({ data: timeseries() })
      .mockResolvedValueOnce({
        error: { kind: "http", status: 503, message: "chart unavailable" },
      })
      .mockResolvedValue({ data: timeseries() });
    mocks.campaigns
      .mockResolvedValueOnce({ data: attribution() })
      .mockResolvedValueOnce({ data: attribution({ items: [] }) });
    render(<RevenueAttributionSection days={30} />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Launch campaign"),
    );
    await selectCampaign("campaign-1");
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "The service could not complete the request.",
      ),
    );
    expect(document.body.textContent).not.toContain("chart unavailable");
    act(() => button("Retry").click());

    await waitFor(() => expect(mocks.timeseries).toHaveBeenCalledTimes(4));
    expect(mocks.timeseries).toHaveBeenNthCalledWith(3, {
      days: 30,
      campaignId: "campaign-1",
    });
    expect(mocks.timeseries).toHaveBeenLastCalledWith({ days: 30 });
    expect(
      document.querySelector(
        'select[aria-label="Filter revenue timeseries by campaign"]',
      ),
    ).toBeNull();
  });

  it("ignores an old window after the keyed controller is replaced", async () => {
    const oldCampaigns = deferred<{ data: CampaignAttributionResponse }>();
    const oldTimeseries = deferred<{ data: RevenueTimeseriesResponse }>();
    mocks.campaigns
      .mockReset()
      .mockReturnValueOnce(oldCampaigns.promise)
      .mockResolvedValueOnce({
        data: attribution({ days: 7, items: [campaign("new-window")] }),
      });
    mocks.timeseries
      .mockReset()
      .mockReturnValueOnce(oldTimeseries.promise)
      .mockResolvedValueOnce({ data: timeseries({ days: 7 }) });
    const view = render(<RevenueAttributionSection days={30} />);
    view.rerender(<RevenueAttributionSection days={7} />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("new-window campaign"),
    );

    await act(async () => {
      oldCampaigns.resolve({
        data: attribution({ items: [campaign("stale")] }),
      });
      oldTimeseries.resolve({ data: timeseries() });
      await Promise.all([oldCampaigns.promise, oldTimeseries.promise]);
    });
    expect(document.body.textContent).toContain("new-window campaign");
    expect(document.body.textContent).not.toContain("stale campaign");
    expect(mocks.timeseries).toHaveBeenNthCalledWith(2, { days: 7 });
  });

  it("wires mixed-currency, rollup, and top-N provenance into the table", async () => {
    mocks.campaigns.mockResolvedValue({
      data: attribution({
        currency: undefined,
        currencies: [
          { currency: "USD", conversions: 4, revenue_cents: 12_500 },
          { currency: "EUR", conversions: 2, revenue_cents: 5000 },
        ],
        items: [
          campaign(),
          campaign("", {
            campaign_name: "(other campaigns)",
            revenue_per_send_cents: undefined,
          }),
        ],
        total_campaigns: 63,
      }),
    });
    render(<RevenueAttributionSection days={30} />);

    await waitFor(() =>
      expect(document.body.textContent).toContain("(other campaigns)"),
    );
    expect(document.body.textContent).toContain("top 1 of 63");
    expect(document.body.textContent).toContain("2 currencies were recorded");
    expect(document.body.textContent).toContain(
      "Amounts are not converted or summed across currencies",
    );
  });

  it("shows unattributed-only revenue without claiming the report is empty", async () => {
    mocks.campaigns.mockResolvedValue({
      data: attribution({
        items: [],
        total_revenue_cents: 0,
        unattributed_cents: 2500,
        unattributed_conversions: 2,
        total_campaigns: 0,
      }),
    });
    render(<RevenueAttributionSection days={30} />);

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "none could be attributed to a campaign",
      ),
    );
    expect(document.body.textContent).toContain("Unattributed");
    expect(document.body.textContent).toContain("2 conversions");
    expect(document.body.textContent).not.toContain(
      "No conversion revenue recorded",
    );
  });

  it("keeps endpoint failures independent and retries the full report fanout", async () => {
    mocks.campaigns
      .mockResolvedValueOnce({
        error: { kind: "http", status: 503, message: "table unavailable" },
      })
      .mockResolvedValueOnce({ data: attribution() });
    render(<RevenueAttributionSection days={30} />);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "The service could not complete the request.",
      ),
    );
    expect(document.body.textContent).not.toContain("table unavailable");
    expect(document.querySelector('[data-testid="line-chart"]')).not.toBeNull();
    act(() => button("Retry").click());

    await waitFor(() =>
      expect(document.body.textContent).toContain("Launch campaign"),
    );
    expect(mocks.campaigns).toHaveBeenCalledTimes(2);
    expect(mocks.timeseries).toHaveBeenCalledTimes(2);
  });
});
