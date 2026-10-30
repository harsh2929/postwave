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

const mocks = vi.hoisted(() => ({
  me: { user: "a@example.test", tenant: "tenant-a" },
  tab: "overview",
  api: {
    getDashboardStats: vi.fn(),
    listCampaigns: vi.fn(),
    getSubscriberTimeseries: vi.fn(),
    listSequences: vi.fn(),
    getRepliesSummary: vi.fn(),
    getRepliesTimeseries: vi.fn(),
    getRepliesTopSenders: vi.fn(),
    getCohorts: vi.fn(),
    getSequenceFunnel: vi.fn(),
    getCampaignReport: vi.fn(),
    getCampaignDevices: vi.fn(),
    getCampaignGeography: vi.fn(),
    getCampaignBounces: vi.fn(),
    getCampaignLinkReport: vi.fn(),
    getCampaignBenchmark: vi.fn(),
  },
  liveStops: [] as Array<ReturnType<typeof vi.fn>>,
}));

vi.mock("../../lib/api-client", () => ({ api: mocks.api }));
vi.mock("../../lib/store", () => ({ useMe: () => mocks.me }));
vi.mock("../../lib/desktop-router", () => ({
  desktopRouteIdentityScope: (user?: string, tenant?: string) =>
    user && tenant ? `${user}:${tenant}` : null,
  useDesktopRouteTab: () => [mocks.tab, vi.fn()],
}));
vi.mock("../../lib/sse", () => ({
  connectDashboardLive: () => {
    const stop = vi.fn();
    mocks.liveStops.push(stop);
    return stop;
  },
}));
vi.mock("../../components/analytics/AnalyticsPresentation", () => ({
  HIGHLIGHT_MS: 10,
  RANGE_INDEPENDENT_SSE_KEYS: [],
  campaignKey: (campaign: { id?: string }) => String(campaign.id ?? ""),
  metricKeyToCard: (key: string) => key,
  parseAnalyticsHash: () => ({}),
  rangeDays: (range: string) =>
    range === "7d" ? 7 : range === "90d" ? 90 : 30,
}));
vi.mock("../../components/analytics/grouped-series", () => ({
  groupedChartDimension: () => null,
}));
vi.mock("../../components/analytics/KpiConfigMenu", () => ({
  loadLayout: () => [],
  saveLayout: vi.fn(),
}));

import { useAnalyticsDashboardController } from "../../pages/analytics/useAnalyticsDashboardController";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: ReturnType<typeof useAnalyticsDashboardController> | null = null;

function Harness({ revision }: { revision: number }): ReactElement {
  latest = useAnalyticsDashboardController();
  return <div data-revision={revision}>{JSON.stringify(latest.stats)}</div>;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => Promise.resolve());
  }
}

function render(revision = 0): { rerender: (next: number) => void } {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Harness revision={revision} />));
  return {
    rerender(next) {
      act(() => root?.render(<Harness revision={next} />));
    },
  };
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.me = { user: "a@example.test", tenant: "tenant-a" };
  mocks.tab = "overview";
  mocks.liveStops.length = 0;
  mocks.api.getDashboardStats.mockResolvedValue({
    data: { subscribers_total: 10 },
  });
  mocks.api.listCampaigns.mockResolvedValue({ data: [] });
  mocks.api.getSubscriberTimeseries.mockResolvedValue({
    data: { range: "30d", points: [] },
  });
  mocks.api.listSequences.mockResolvedValue({ data: { items: [] } });
  mocks.api.getRepliesSummary.mockResolvedValue({ data: null });
  mocks.api.getRepliesTimeseries.mockResolvedValue({ data: null });
  mocks.api.getRepliesTopSenders.mockResolvedValue({ data: null });
  mocks.api.getCohorts.mockResolvedValue({ data: [] });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  latest = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

describe("analytics dashboard identity and refresh boundaries", () => {
  it("masks an old identity immediately and rejects its late response", async () => {
    const tenantA = deferred<{ data: { subscribers_total: number } }>();
    mocks.api.getDashboardStats
      .mockReturnValueOnce(tenantA.promise)
      .mockResolvedValueOnce({ data: { subscribers_total: 22 } });
    const view = render();
    await flush();

    mocks.me = { user: "b@example.test", tenant: "tenant-b" };
    view.rerender(1);
    expect(latest?.stats).toBeNull();
    await flush();
    expect(latest?.stats).toMatchObject({ subscribers_total: 22 });

    tenantA.resolve({ data: { subscribers_total: 11 } });
    await flush();
    expect(latest?.stats).toMatchObject({ subscribers_total: 22 });
    expect(mocks.liveStops).toHaveLength(2);
    expect(mocks.liveStops[0]).toHaveBeenCalledTimes(1);
  });

  it("retains same-identity verified data and exposes a structured partial issue", async () => {
    render();
    await flush();
    const acceptedAt = latest?.lastUpdated;
    expect(latest?.stats).toMatchObject({ subscribers_total: 10 });

    mocks.api.getDashboardStats.mockResolvedValueOnce({
      error: {
        code: "stats_unavailable",
        message: 'database "tenant-a" failed for reflected=<script>',
        requestId: "req-safe-123",
        status: 500,
      },
    });
    await act(async () => {
      await latest?.load("30d");
    });

    expect(latest?.stats).toMatchObject({ subscribers_total: 10 });
    expect(latest?.lastUpdated).toBe(acceptedAt);
    expect(latest?.issues).toContainEqual({
      resource: "dashboard_stats",
      label: "Dashboard totals",
      message: "The service could not complete the request.",
      code: "stats_unavailable",
      requestId: "req-safe-123",
      retained: true,
      primary: true,
      severity: "error",
    });
    expect(latest?.err).toBe("The service could not complete the request.");
    expect(JSON.stringify(latest?.issues)).not.toContain("<script>");
  });

  it("drops retained dashboard data when the current identity loses read permission", async () => {
    render();
    await flush();
    expect(latest?.stats).toMatchObject({ subscribers_total: 10 });

    mocks.api.getDashboardStats.mockResolvedValueOnce({
      error: {
        code: "permission_denied",
        message: "reflected tenant detail that must not render",
        requestId: "req-denied-456",
        status: 403,
      },
    });
    await act(async () => {
      await latest?.load("30d");
    });

    expect(latest?.stats).toBeNull();
    expect(latest?.err).toBe(
      "Your current role does not have permission to read this data.",
    );
    expect(latest?.issues).toContainEqual({
      resource: "dashboard_stats",
      label: "Dashboard totals",
      message: "Your current role does not have permission to read this data.",
      code: "permission_denied",
      requestId: "req-denied-456",
      retained: false,
      primary: true,
      severity: "error",
    });
    expect(JSON.stringify(latest?.issues)).not.toContain("reflected tenant");
  });

  it("coalesces an in-flight refresh and exposes busy state", async () => {
    const request = deferred<{ data: { subscribers_total: number } }>();
    mocks.api.getDashboardStats.mockReturnValueOnce(request.promise);
    render();
    await flush();
    expect(latest?.refreshing).toBe(true);

    const first = latest!.load("30d");
    const second = latest!.load("30d");
    expect(first).toBe(second);
    expect(mocks.api.getDashboardStats).toHaveBeenCalledTimes(1);

    request.resolve({ data: { subscribers_total: 12 } });
    await act(async () => {
      await first;
    });
    expect(latest?.refreshing).toBe(false);
    expect(latest?.stats).toMatchObject({ subscribers_total: 12 });
  });

  it("loads only the per-campaign resources required by the active tab", async () => {
    mocks.api.listCampaigns.mockResolvedValue({
      data: [{ id: "campaign-1", name: "Launch" }],
    });
    mocks.api.getSubscriberTimeseries.mockResolvedValue({
      data: {
        range: "30d",
        points: [{ date: "2026-07-24", count: 10 }],
      },
    });
    mocks.api.getCohorts.mockResolvedValue({
      data: [
        {
          cohort_label: "2026-07",
          cohort_size: 10,
          weeks: [0.4],
        },
      ],
    });
    mocks.api.getCampaignReport.mockResolvedValue({ data: null });
    mocks.api.getCampaignBounces.mockResolvedValue({ data: null });
    mocks.api.getCampaignBenchmark.mockResolvedValue({
      error: { message: "Benchmark unavailable" },
    });
    mocks.api.getCampaignDevices.mockResolvedValue({ data: [] });
    mocks.api.getCampaignGeography.mockResolvedValue({ data: [] });
    mocks.api.getCampaignLinkReport.mockResolvedValue({ data: [] });

    const view = render();
    await flush();
    expect(mocks.api.getDashboardStats).toHaveBeenCalledTimes(1);
    expect(mocks.api.listCampaigns).toHaveBeenCalledTimes(2);
    expect(mocks.api.listCampaigns).toHaveBeenNthCalledWith(1, {
      page: 1,
      perPage: 5,
    });
    expect(mocks.api.listCampaigns).toHaveBeenNthCalledWith(2, {
      page: 1,
      perPage: 20,
    });
    expect(mocks.api.getSubscriberTimeseries).toHaveBeenCalledTimes(1);
    expect(mocks.api.listSequences).toHaveBeenCalledTimes(1);
    expect(mocks.api.getRepliesSummary).toHaveBeenCalledTimes(1);
    expect(mocks.api.getRepliesTimeseries).toHaveBeenCalledTimes(1);
    expect(mocks.api.getRepliesTopSenders).toHaveBeenCalledTimes(1);
    expect(mocks.api.getCohorts).toHaveBeenCalledTimes(1);
    expect(mocks.api.getCampaignReport).toHaveBeenCalledTimes(1);
    expect(mocks.api.getCampaignBounces).toHaveBeenCalledTimes(1);
    expect(mocks.api.getCampaignBenchmark).toHaveBeenCalledTimes(1);
    expect(mocks.api.getCampaignDevices).not.toHaveBeenCalled();
    expect(mocks.api.getCampaignGeography).not.toHaveBeenCalled();
    expect(mocks.api.getCampaignLinkReport).not.toHaveBeenCalled();

    mocks.tab = "audience";
    view.rerender(1);
    await flush();
    expect(mocks.api.getDashboardStats).toHaveBeenCalledTimes(2);
    expect(mocks.api.listCampaigns).toHaveBeenCalledTimes(3);
    expect(mocks.api.listCampaigns).toHaveBeenLastCalledWith({
      page: 1,
      perPage: 5,
    });
    expect(mocks.api.getSubscriberTimeseries).toHaveBeenCalledTimes(2);
    expect(mocks.api.listSequences).toHaveBeenCalledTimes(1);
    expect(mocks.api.getRepliesSummary).toHaveBeenCalledTimes(1);
    expect(mocks.api.getRepliesTimeseries).toHaveBeenCalledTimes(1);
    expect(mocks.api.getRepliesTopSenders).toHaveBeenCalledTimes(1);
    expect(mocks.api.getCohorts).toHaveBeenCalledTimes(2);
    expect(mocks.api.getCampaignReport).toHaveBeenCalledTimes(1);
    expect(mocks.api.getCampaignBounces).toHaveBeenCalledTimes(1);
    expect(mocks.api.getCampaignBenchmark).toHaveBeenCalledTimes(1);
    expect(mocks.api.getCampaignDevices).toHaveBeenCalledTimes(1);
    expect(mocks.api.getCampaignGeography).toHaveBeenCalledTimes(1);
    expect(mocks.api.getCampaignLinkReport).toHaveBeenCalledTimes(1);

    mocks.tab = "revenue";
    view.rerender(2);
    await flush();
    expect(mocks.api.getDashboardStats).toHaveBeenCalledTimes(3);
    expect(mocks.api.listCampaigns).toHaveBeenCalledTimes(3);
    expect(mocks.api.getSubscriberTimeseries).toHaveBeenCalledTimes(2);
    expect(mocks.api.listSequences).toHaveBeenCalledTimes(1);
    expect(mocks.api.getRepliesSummary).toHaveBeenCalledTimes(1);
    expect(mocks.api.getRepliesTimeseries).toHaveBeenCalledTimes(1);
    expect(mocks.api.getRepliesTopSenders).toHaveBeenCalledTimes(1);
    expect(mocks.api.getCohorts).toHaveBeenCalledTimes(2);
    expect(mocks.api.getCampaignDevices).toHaveBeenCalledTimes(1);
    expect(mocks.api.getCampaignReport).toHaveBeenCalledTimes(1);
    expect(latest?.series).toEqual([{ date: "2026-07-24", count: 10 }]);
    expect(latest?.cohorts).toEqual([
      {
        cohort_label: "2026-07",
        cohort_size: 10,
        weeks: [0.4],
      },
    ]);
    expect(latest?.allCampaigns).toEqual([
      { id: "campaign-1", name: "Launch" },
    ]);

    mocks.tab = "campaigns";
    view.rerender(3);
    await flush();
    expect(mocks.api.getDashboardStats).toHaveBeenCalledTimes(4);
    expect(mocks.api.listCampaigns).toHaveBeenCalledTimes(5);
    expect(mocks.api.getSubscriberTimeseries).toHaveBeenCalledTimes(2);
    expect(mocks.api.listSequences).toHaveBeenCalledTimes(1);
    expect(mocks.api.getRepliesSummary).toHaveBeenCalledTimes(1);
    expect(mocks.api.getRepliesTimeseries).toHaveBeenCalledTimes(1);
    expect(mocks.api.getRepliesTopSenders).toHaveBeenCalledTimes(1);
    expect(mocks.api.getCohorts).toHaveBeenCalledTimes(2);
    expect(mocks.api.getCampaignReport).toHaveBeenCalledTimes(2);
    expect(mocks.api.getCampaignBounces).toHaveBeenCalledTimes(1);
    expect(mocks.api.getCampaignBenchmark).toHaveBeenCalledTimes(2);

    mocks.tab = "predictive";
    view.rerender(4);
    await flush();
    mocks.tab = "reports";
    view.rerender(5);
    await flush();
    expect(mocks.api.getDashboardStats).toHaveBeenCalledTimes(6);
    expect(mocks.api.listCampaigns).toHaveBeenCalledTimes(5);
    expect(mocks.api.getSubscriberTimeseries).toHaveBeenCalledTimes(2);
    expect(mocks.api.listSequences).toHaveBeenCalledTimes(1);
    expect(mocks.api.getRepliesSummary).toHaveBeenCalledTimes(1);
    expect(mocks.api.getRepliesTimeseries).toHaveBeenCalledTimes(1);
    expect(mocks.api.getRepliesTopSenders).toHaveBeenCalledTimes(1);
    expect(mocks.api.getCohorts).toHaveBeenCalledTimes(2);
    expect(mocks.api.getCampaignReport).toHaveBeenCalledTimes(2);
    expect(mocks.api.getCampaignDevices).toHaveBeenCalledTimes(1);
  });
});
