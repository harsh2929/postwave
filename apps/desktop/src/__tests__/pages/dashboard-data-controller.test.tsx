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
  Campaign,
  DashboardRange,
  DashboardStatsResponse,
} from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  getStats: vi.fn(),
  invalidation: { value: null as null | (() => void) },
  listAnomalies: vi.fn(),
  listCampaigns: vi.fn(),
  notifyAnomalies: vi.fn(),
  notifyMilestones: vi.fn(),
  setActiveSend: vi.fn(),
  setLiveSubs: vi.fn(),
  setQueryData: vi.fn(),
  snapshot: {
    value: null as null | ((stats: DashboardStatsResponse) => void),
  },
  status: {
    value: null as
      | null
      | ((status: "connecting" | "open" | "reconnecting" | "closed") => void),
  },
  toastError: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    getDashboardStats: mocks.getStats,
    listCampaigns: mocks.listCampaigns,
    listDashboardAnomalies: mocks.listAnomalies,
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ setQueryData: mocks.setQueryData }),
}));

vi.mock("../../lib/use-query-invalidation-reload", () => ({
  useQueryInvalidationReload: (_resource: string, reload: () => void) => {
    mocks.invalidation.value = reload;
  },
}));

vi.mock("../../lib/sse", () => ({
  connectDashboardLive: mocks.connect,
}));

vi.mock("../../lib/dashboard-notifier", () => ({
  notifyMilestoneCrossings: mocks.notifyMilestones,
  notifyNewAnomalies: mocks.notifyAnomalies,
}));

vi.mock("../../lib/store", () => ({
  setActiveSend: mocks.setActiveSend,
  setLiveSubs: mocks.setLiveSubs,
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError },
}));

import {
  type DashboardDataController,
  useDashboardData,
} from "../../pages/dashboard/useDashboardData";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: DashboardDataController | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-16T08:00:00.000Z"));
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
  vi.clearAllMocks();
  mocks.invalidation.value = null;
  mocks.snapshot.value = null;
  mocks.status.value = null;
  mocks.getStats.mockResolvedValue({ data: stats(100) });
  mocks.listCampaigns.mockResolvedValue({ data: { items: [campaign("one")] } });
  mocks.listAnomalies.mockResolvedValue({ data: { items: [] } });
  mocks.notifyAnomalies.mockResolvedValue(0);
  mocks.notifyMilestones.mockResolvedValue(0);
  mocks.connect.mockImplementation(
    (
      onSnapshot: (value: DashboardStatsResponse) => void,
      _onError: unknown,
      onStatus: (
        value: "connecting" | "open" | "reconnecting" | "closed",
      ) => void,
    ) => {
      mocks.snapshot.value = onSnapshot;
      mocks.status.value = onStatus;
      onStatus("connecting");
      return mocks.disconnect;
    },
  );
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  latest = null;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function stats(total: number, range?: DashboardRange): DashboardStatsResponse {
  return {
    subscribers_total: total,
    subscribers_added_30d: 5,
    emails_sent_30d: 100,
    ...(range ? { range } : {}),
  };
}

function campaign(id: string, status = "draft"): Campaign {
  return { id, name: `${id} campaign`, status };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function Probe({
  range,
  tenantId = "tenant-1",
}: {
  range: DashboardRange;
  tenantId?: string;
}): ReactElement {
  const controller = useDashboardData({
    hasIdentity: true,
    notificationScope: `identity-scope:${tenantId}`,
    range,
    role: "admin",
    tenantId,
  });
  latest = controller;
  return (
    <div>
      <span data-testid="total">
        {String(controller.stats?.subscribers_total ?? "null")}
      </span>
      <span data-testid="campaigns">
        {controller.campaigns?.map((item) => item.id).join(",") ?? "null"}
      </span>
      <span data-testid="campaigns-loading">
        {String(controller.campaignsLoading)}
      </span>
      <span data-testid="campaigns-error">
        {String(controller.campaignsError)}
      </span>
      <span data-testid="campaigns-stale">
        {String(controller.campaignsStale)}
      </span>
      <span data-testid="loading">{String(controller.loading)}</span>
      <span data-testid="load-state">{controller.loadState}</span>
      <span data-testid="resolved-range">
        {controller.resolvedRange ?? "null"}
      </span>
      <span data-testid="last-success">{controller.lastSuccessAt}</span>
      <span data-testid="last-event">{controller.lastEventAt}</span>
      <span data-testid="error">{controller.error ?? "none"}</span>
      <span data-testid="failure-kind">
        {controller.statsFailure?.kind ?? "none"}
      </span>
      <span data-testid="live">{controller.liveStatus}</span>
    </div>
  );
}

function AnonymousProbe(): ReactElement {
  const controller = useDashboardData({
    hasIdentity: false,
    notificationScope: null,
    range: "30d",
    role: null,
    tenantId: "anon",
  });
  latest = controller;
  return (
    <div>
      <span data-testid="anonymous-loading">{String(controller.loading)}</span>
      <span data-testid="anonymous-load-state">{controller.loadState}</span>
      <span data-testid="anonymous-resolved-range">
        {controller.resolvedRange ?? "null"}
      </span>
      <span data-testid="anonymous-last-success">
        {controller.lastSuccessAt}
      </span>
    </div>
  );
}

function renderController(range: DashboardRange = "30d"): {
  rerender: (nextRange: DashboardRange, tenantId?: string) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Probe range={range} />));
  return {
    rerender(nextRange, tenantId = "tenant-1") {
      act(() => root?.render(<Probe range={nextRange} tenantId={tenantId} />));
    },
  };
}

function text(testId: string): string | null {
  return (
    document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null
  );
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

async function renderLoaded(): Promise<void> {
  renderController();
  await waitFor(() => expect(text("load-state")).toBe("ready"));
}

describe("dashboard data controller", () => {
  it("does not start authenticated reads or SSE before identity resolves", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<AnonymousProbe />));

    expect(mocks.getStats).not.toHaveBeenCalled();
    expect(mocks.listCampaigns).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(text("anonymous-loading")).toBe("true");
    expect(text("anonymous-load-state")).toBe("initial");
    expect(text("anonymous-resolved-range")).toBe("null");
    expect(text("anonymous-last-success")).toBe("0");
  });

  it("keeps same-context full loads single-flight with exact request options", async () => {
    const pendingStats = deferred<{ data: DashboardStatsResponse }>();
    const pendingCampaigns = deferred<{ data: { items: Campaign[] } }>();
    mocks.getStats.mockReset().mockReturnValueOnce(pendingStats.promise);
    mocks.listCampaigns
      .mockReset()
      .mockReturnValueOnce(pendingCampaigns.promise);
    renderController();
    act(() => void latest?.load());

    expect(mocks.getStats).toHaveBeenCalledTimes(1);
    expect(mocks.listCampaigns).toHaveBeenCalledTimes(1);
    expect(text("loading")).toBe("true");
    expect(text("load-state")).toBe("initial");

    await act(async () => {
      pendingStats.resolve({ data: stats(200) });
      pendingCampaigns.resolve({ data: { items: [campaign("new")] } });
      await Promise.all([pendingStats.promise, pendingCampaigns.promise]);
    });
    expect(text("total")).toBe("200");
    expect(text("campaigns")).toBe("new");
    expect(text("loading")).toBe("false");
    expect(text("load-state")).toBe("ready");
    expect(text("resolved-range")).toBe("30d");
    expect(text("last-success")).toBe(String(Date.now()));
    expect(mocks.getStats).toHaveBeenCalledWith({
      range: "30d",
      compare: true,
      sparklines: true,
    });
  });

  it("settles a thrown stats branch without blocking verified campaigns", async () => {
    mocks.getStats.mockRejectedValueOnce(
      new Error("upstream secret stats transport detail"),
    );
    mocks.listCampaigns.mockResolvedValueOnce({
      data: { items: [campaign("verified-campaign")] },
    });
    renderController();

    await waitFor(() => expect(text("loading")).toBe("false"));
    expect(text("total")).toBe("null");
    expect(text("campaigns")).toBe("verified-campaign");
    expect(text("campaigns-error")).toBe("false");
    expect(text("failure-kind")).toBe("generic");
    expect(document.body.textContent).not.toContain("upstream secret");
  });

  it("classifies denied stats safely without reflecting server detail", async () => {
    mocks.getStats.mockResolvedValueOnce({
      error: {
        kind: "http",
        status: 403,
        message: "private authorization policy name",
      },
    });
    renderController();

    await waitFor(() => expect(text("failure-kind")).toBe("access"));
    expect(text("error")).toBe(
      "Your current access can't read dashboard metrics.",
    );
    expect(document.body.textContent).not.toContain("authorization policy");
  });

  it("classifies a failed refresh offline from trusted browser state", async () => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    mocks.getStats.mockResolvedValueOnce({
      error: { kind: "network", message: "private gateway address" },
    });
    renderController();

    await waitFor(() => expect(text("failure-kind")).toBe("offline"));
    expect(text("error")).toContain("You're offline");
    expect(document.body.textContent).not.toContain("private gateway");
  });

  it("makes a thrown initial campaign branch independently retryable", async () => {
    mocks.listCampaigns.mockRejectedValueOnce(
      new Error("private campaigns adapter detail"),
    );
    renderController();

    await waitFor(() => expect(text("campaigns-loading")).toBe("false"));
    expect(text("total")).toBe("100");
    expect(text("campaigns")).toBe("null");
    expect(text("campaigns-error")).toBe("true");
    expect(text("campaigns-stale")).toBe("false");
    expect(document.body.textContent).not.toContain("private campaigns");

    mocks.listCampaigns.mockResolvedValueOnce({
      data: { items: [campaign("recovered")] },
    });
    await act(async () => latest?.refreshCampaigns());
    expect(text("campaigns")).toBe("recovered");
    expect(text("campaigns-error")).toBe("false");
  });

  it.each([
    ["non-string status", { ...campaign("bad-status"), status: 42 }],
    ["object name", { ...campaign("bad-name"), name: { private: true } }],
    ["out-of-contract rate", { ...campaign("bad-rate"), open_rate: 42 }],
    ["structurally empty row", {}],
  ])(
    "rejects a %s campaign row before it reaches rendering",
    async (_label, row) => {
      mocks.listCampaigns.mockResolvedValueOnce({
        data: { items: [row] },
      });
      renderController();

      await waitFor(() => expect(text("campaigns-loading")).toBe("false"));
      expect(text("campaigns")).toBe("null");
      expect(text("campaigns-error")).toBe("true");
      expect(text("campaigns-stale")).toBe("false");
      expect(mocks.setActiveSend).toHaveBeenLastCalledWith(null);
    },
  );

  it("retains verified campaign rows and marks them stale on refresh failure", async () => {
    await renderLoaded();
    mocks.listCampaigns.mockRejectedValueOnce(
      new Error("sensitive refresh failure"),
    );

    await act(async () => latest?.refreshCampaigns());
    expect(text("campaigns")).toBe("one");
    expect(text("campaigns-loading")).toBe("false");
    expect(text("campaigns-error")).toBe("true");
    expect(text("campaigns-stale")).toBe("true");
    expect(document.body.textContent).not.toContain("sensitive refresh");
  });

  it("preserves same-range data while an invalidation refresh is pending", async () => {
    await renderLoaded();
    const refreshStats = deferred<{ data: DashboardStatsResponse }>();
    const refreshCampaigns = deferred<{ data: { items: Campaign[] } }>();
    mocks.getStats.mockReturnValueOnce(refreshStats.promise);
    mocks.listCampaigns.mockReturnValueOnce(refreshCampaigns.promise);
    const initialSuccessAt = text("last-success");

    act(() => mocks.invalidation.value?.());
    expect(text("total")).toBe("100");
    expect(text("resolved-range")).toBe("30d");
    expect(text("load-state")).toBe("refresh");
    expect(text("loading")).toBe("true");
    expect(text("last-success")).toBe(initialSuccessAt);

    vi.setSystemTime(new Date("2026-07-16T08:00:03.000Z"));
    await act(async () => {
      refreshStats.resolve({ data: stats(300, "30d") });
      refreshCampaigns.resolve({ data: { items: [campaign("fresh")] } });
      await Promise.all([refreshStats.promise, refreshCampaigns.promise]);
    });

    expect(text("total")).toBe("300");
    expect(text("campaigns")).toBe("fresh");
    expect(text("load-state")).toBe("ready");
    expect(text("last-success")).toBe(String(Date.now()));
    expect(mocks.getStats).toHaveBeenCalledTimes(2);
    expect(mocks.setQueryData).toHaveBeenCalled();
  });

  it("retains same-range stats and exposes a manual refresh failure", async () => {
    await renderLoaded();
    const initialSuccessAt = text("last-success");
    const refreshStats = deferred<{
      error: { kind: "http"; status: number; message: string };
    }>();
    const refreshCampaigns = deferred<{ data: { items: Campaign[] } }>();
    mocks.getStats.mockReturnValueOnce(refreshStats.promise);
    mocks.listCampaigns.mockReturnValueOnce(refreshCampaigns.promise);

    let refreshPromise!: Promise<void>;
    mocks.setLiveSubs.mockClear();
    act(() => {
      void (refreshPromise = latest!.load());
    });
    expect(text("total")).toBe("100");
    expect(text("load-state")).toBe("refresh");
    expect(text("loading")).toBe("true");

    await act(async () => {
      refreshStats.resolve({
        error: { kind: "http", status: 503, message: "stats unavailable" },
      });
      refreshCampaigns.resolve({ data: { items: [campaign("current")] } });
      await refreshPromise;
    });

    expect(text("total")).toBe("100");
    expect(text("campaigns")).toBe("current");
    expect(text("resolved-range")).toBe("30d");
    expect(text("load-state")).toBe("ready");
    expect(text("loading")).toBe("false");
    expect(text("error")).toBe(
      "The metrics service couldn't complete this request.",
    );
    expect(text("failure-kind")).toBe("service");
    expect(document.body.textContent).not.toContain("stats unavailable");
    expect(text("last-success")).toBe(initialSuccessAt);
    expect(mocks.setLiveSubs).toHaveBeenLastCalledWith(null);
  });

  it("marks polling as refresh without clearing data or full-load state", async () => {
    await renderLoaded();
    const refreshStats = deferred<{ data: DashboardStatsResponse }>();
    mocks.getStats.mockReturnValueOnce(refreshStats.promise);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(text("total")).toBe("100");
    expect(text("load-state")).toBe("refresh");
    expect(text("loading")).toBe("false");

    vi.setSystemTime(new Date("2026-07-16T08:00:05.000Z"));
    await act(async () => {
      refreshStats.resolve({ data: stats(105, "30d") });
      await refreshStats.promise;
    });
    expect(text("total")).toBe("105");
    expect(text("load-state")).toBe("ready");
    expect(text("last-success")).toBe(String(Date.now()));
    expect(mocks.listCampaigns).toHaveBeenCalledTimes(1);
  });

  it("pauses polling while the network interface is offline and refreshes on reconnect", async () => {
    await renderLoaded();
    const disconnectedSnapshot = mocks.snapshot.value;
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    await act(() => window.dispatchEvent(new Event("offline")));
    await act(() => vi.advanceTimersByTime(15_000));
    expect(mocks.getStats).toHaveBeenCalledTimes(1);
    expect(text("total")).toBe("100");
    expect(text("failure-kind")).toBe("offline");
    expect(text("loading")).toBe("false");
    expect(mocks.setLiveSubs).toHaveBeenLastCalledWith(null);
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    act(() => {
      disconnectedSnapshot?.({ range: "30d", subscribers_total: 999 });
    });
    expect(text("total")).toBe("100");
    expect(text("failure-kind")).toBe("offline");

    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(mocks.getStats).toHaveBeenCalledTimes(1);

    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.getStats).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(text("failure-kind")).toBe("none"));
    expect(text("total")).toBe("100");
    expect(mocks.connect).toHaveBeenCalledTimes(2);
  });

  it("polls campaigns every 30s, pauses while hidden, and verifies once on return", async () => {
    mocks.listCampaigns.mockResolvedValue({
      data: { items: [campaign("visible-send", "sending")] },
    });
    await renderLoaded();
    expect(mocks.listCampaigns).toHaveBeenCalledTimes(1);
    expect(mocks.connect).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(29_999);
      await Promise.resolve();
    });
    expect(mocks.listCampaigns).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.listCampaigns).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.setActiveSend).toHaveBeenLastCalledWith(null);
    expect(text("campaigns-stale")).toBe("true");
    await act(async () => {
      vi.advanceTimersByTime(90_000);
      await Promise.resolve();
    });
    expect(mocks.listCampaigns).toHaveBeenCalledTimes(2);
    expect(mocks.connect).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.listCampaigns).toHaveBeenCalledTimes(3);
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(text("campaigns-stale")).toBe("false");

    await act(async () => {
      vi.advanceTimersByTime(29_999);
      await Promise.resolve();
    });
    expect(mocks.listCampaigns).toHaveBeenCalledTimes(3);
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.listCampaigns).toHaveBeenCalledTimes(4);
  });

  it("clears a stale active-send signal on offline or campaign verification failure", async () => {
    mocks.listCampaigns.mockResolvedValueOnce({
      data: { items: [campaign("live-send", "sending")] },
    });
    await renderLoaded();
    await waitFor(() =>
      expect(mocks.setActiveSend).toHaveBeenLastCalledWith(
        expect.objectContaining({ campaignId: "live-send" }),
      ),
    );

    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(mocks.setActiveSend).toHaveBeenLastCalledWith(null);

    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });
    mocks.listCampaigns.mockResolvedValueOnce({
      data: { items: [campaign("live-send", "sending")] },
    });
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(mocks.setActiveSend).toHaveBeenLastCalledWith(
        expect.objectContaining({ campaignId: "live-send" }),
      ),
    );

    mocks.listCampaigns.mockRejectedValueOnce(
      new Error("campaign poll failed"),
    );
    await act(async () => latest?.refreshCampaigns());
    expect(mocks.setActiveSend).toHaveBeenLastCalledWith(null);
    expect(text("campaigns-stale")).toBe("true");
  });

  it("cancels stale anomaly enrichment when retained stats become unavailable", async () => {
    const anomalies = deferred<{ data: { items: Array<{ id: string }> } }>();
    mocks.getStats.mockResolvedValueOnce({
      data: { ...stats(100), anomalies: { bounces: true } },
    });
    mocks.listAnomalies.mockReturnValueOnce(anomalies.promise);
    await renderLoaded();
    expect(mocks.listAnomalies).toHaveBeenCalledTimes(1);

    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    await act(async () => {
      anomalies.resolve({ data: { items: [{ id: "stale-anomaly" }] } });
      await anomalies.promise;
    });

    expect(mocks.notifyAnomalies).not.toHaveBeenCalled();
  });

  it.each(["7d", "90d"] as const)(
    "uses range-correct 5s polling and no SSE for %s",
    async (selectedRange) => {
      mocks.getStats.mockResolvedValue({
        data: stats(selectedRange === "7d" ? 7 : 90, selectedRange),
      });
      renderController(selectedRange);
      await waitFor(() => expect(text("load-state")).toBe("ready"));

      expect(mocks.connect).not.toHaveBeenCalled();
      expect(text("live")).toBe("closed");
      await act(async () => {
        vi.advanceTimersByTime(5_000);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mocks.getStats).toHaveBeenCalledTimes(2);
      expect(mocks.getStats).toHaveBeenLastCalledWith({
        range: selectedRange,
        compare: true,
        sparklines: true,
      });
    },
  );

  it.each(["7d", "90d"] as const)(
    "rejects a %s response without explicit matching range provenance",
    async (selectedRange) => {
      mocks.getStats.mockResolvedValueOnce({ data: stats(22) });
      renderController(selectedRange);

      await waitFor(() => expect(text("failure-kind")).toBe("invalid"));
      expect(text("total")).toBe("null");
      expect(text("resolved-range")).toBe("null");
      expect(text("last-success")).toBe("0");
      expect(mocks.setLiveSubs).toHaveBeenLastCalledWith(null);
    },
  );

  it("gates prior-range stats until the selected range resolves", async () => {
    const rendered = renderController();
    await waitFor(() => expect(text("load-state")).toBe("ready"));
    const rangeStats = deferred<{ data: DashboardStatsResponse }>();
    const rangeCampaigns = deferred<{ data: { items: Campaign[] } }>();
    mocks.getStats.mockReturnValueOnce(rangeStats.promise);
    mocks.listCampaigns.mockReturnValueOnce(rangeCampaigns.promise);

    mocks.setLiveSubs.mockClear();
    rendered.rerender("7d");
    expect(text("total")).toBe("null");
    expect(text("resolved-range")).toBe("30d");
    expect(text("load-state")).toBe("range");
    expect(text("loading")).toBe("true");
    expect(text("live")).toBe("closed");
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.setLiveSubs).toHaveBeenLastCalledWith(null);

    act(() => mocks.snapshot.value?.({ range: "30d", subscribers_total: 999 }));
    expect(text("total")).toBe("null");
    expect(text("last-success")).toBe("0");

    vi.setSystemTime(new Date("2026-07-16T08:00:07.000Z"));
    await act(async () => {
      rangeStats.resolve({ data: stats(7, "7d") });
      rangeCampaigns.resolve({ data: { items: [campaign("seven-day")] } });
      await Promise.all([rangeStats.promise, rangeCampaigns.promise]);
    });
    expect(text("total")).toBe("7");
    expect(text("resolved-range")).toBe("7d");
    expect(text("load-state")).toBe("ready");
    expect(text("last-success")).toBe(String(Date.now()));
    expect(mocks.getStats).toHaveBeenLastCalledWith({
      range: "7d",
      compare: true,
      sparklines: true,
    });
  });

  it("does not fall back to prior-range metrics when a range load fails", async () => {
    const rendered = renderController();
    await waitFor(() => expect(text("load-state")).toBe("ready"));
    mocks.getStats.mockResolvedValueOnce({
      error: { kind: "http", status: 503, message: "range unavailable" },
    });
    mocks.listCampaigns.mockResolvedValueOnce({ data: { items: [] } });

    rendered.rerender("90d");
    await waitFor(() => expect(text("load-state")).toBe("ready"));

    expect(text("total")).toBe("null");
    expect(text("resolved-range")).toBe("30d");
    expect(text("error")).toBe(
      "The metrics service couldn't complete this request.",
    );
    expect(text("failure-kind")).toBe("service");
    expect(text("last-success")).toBe("0");
    expect(text("error")).not.toContain("range unavailable");
  });

  it("merges live snapshots and clears both global status slices on unmount", async () => {
    mocks.listCampaigns.mockResolvedValue({
      data: { items: [campaign("sending", "sending")] },
    });
    await renderLoaded();
    vi.setSystemTime(new Date("2026-07-16T08:00:11.000Z"));
    act(() => {
      mocks.status.value?.("open");
      mocks.snapshot.value?.({ range: "30d", subscribers_total: 250 });
    });

    expect(text("live")).toBe("open");
    expect(text("total")).toBe("250");
    expect(text("resolved-range")).toBe("30d");
    expect(text("last-success")).toBe(String(Date.now()));
    expect(mocks.setActiveSend).toHaveBeenCalledWith({
      campaignId: "sending",
      name: "sending campaign",
      openRate: null,
      clickRate: null,
    });
    act(() => root?.unmount());
    root = null;
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.setLiveSubs).toHaveBeenLastCalledWith(null);
    expect(mocks.setActiveSend).toHaveBeenLastCalledWith(null);

    act(() => mocks.snapshot.value?.({ subscribers_total: 999 }));
    expect(mocks.setLiveSubs).not.toHaveBeenCalledWith(
      expect.objectContaining({ total: 999 }),
    );
  });

  it("never publishes malformed subscriber counters into the global shell", async () => {
    await renderLoaded();
    const initialSuccessAt = text("last-success");
    const initialEventAt = text("last-event");
    mocks.setLiveSubs.mockClear();
    act(() => {
      mocks.snapshot.value?.({
        range: "30d",
        subscribers_total: Number.NaN,
        subscribers_added_30d: Number.POSITIVE_INFINITY,
      });
    });

    expect(text("total")).toBe("100");
    expect(text("last-success")).toBe(initialSuccessAt);
    expect(text("last-event")).toBe(initialEventAt);
    expect(mocks.setLiveSubs).not.toHaveBeenCalled();
  });

  it("rejects malformed HTTP stats without advancing freshness", async () => {
    await renderLoaded();
    const initialSuccessAt = text("last-success");
    mocks.getStats.mockResolvedValueOnce({
      data: {
        range: "30d",
        subscribers_total: Number.POSITIVE_INFINITY,
      },
    });
    mocks.listCampaigns.mockResolvedValueOnce({ data: { items: [] } });

    await act(async () => latest?.load());
    expect(text("total")).toBe("100");
    expect(text("failure-kind")).toBe("invalid");
    expect(text("last-success")).toBe(initialSuccessAt);
    expect(mocks.setLiveSubs).toHaveBeenLastCalledWith(null);
  });

  it.each([
    ["fractional count", { subscribers_total: 1.5 }],
    ["fractional unique count", { unique_clicks_30d: 1.5 }],
    [
      "unsafe previous unique count",
      { previous: { unique_sent: Number.MAX_SAFE_INTEGER + 1 } },
    ],
    [
      "unknown inbox-health state",
      { inbox_health: { score: 92, state: "private upstream policy" } },
    ],
  ])("rejects a %s as unverified stats", async (_label, invalidFields) => {
    mocks.getStats.mockResolvedValueOnce({
      data: { ...stats(100, "30d"), ...invalidFields },
    });
    renderController();

    await waitFor(() => expect(text("failure-kind")).toBe("invalid"));
    expect(text("total")).toBe("null");
    expect(text("last-success")).toBe("0");
  });

  it("rejects a structurally empty stats envelope even when a side surface is shaped", async () => {
    mocks.getStats.mockResolvedValueOnce({
      data: { range: "30d", inbox_health: null },
    });
    renderController();

    await waitFor(() => expect(text("failure-kind")).toBe("invalid"));
    expect(text("total")).toBe("null");
    expect(text("last-success")).toBe("0");
  });

  it.each([
    ["null", null],
    ["structurally empty", {}],
  ])(
    "rejects a %s audit row before it reaches rendering",
    async (_label, row) => {
      mocks.getStats.mockResolvedValueOnce({
        data: {
          ...stats(100, "30d"),
          recent_audit: [row],
        },
      });
      renderController();

      await waitFor(() => expect(text("failure-kind")).toBe("invalid"));
      expect(text("total")).toBe("null");
      expect(text("last-success")).toBe("0");
    },
  );

  it("rejects a sparkline longer than the selected reporting window", async () => {
    mocks.getStats.mockResolvedValueOnce({
      data: {
        ...stats(100, "30d"),
        sparklines: { subscribers: Array.from({ length: 31 }, () => 1) },
      },
    });
    renderController();

    await waitFor(() => expect(text("failure-kind")).toBe("invalid"));
    expect(text("total")).toBe("null");
    expect(text("last-success")).toBe("0");
  });

  it("ignores live snapshots for a different range without changing receipt state", async () => {
    await renderLoaded();
    const initialSuccessAt = text("last-success");
    const initialEventAt = text("last-event");
    act(() => {
      mocks.status.value?.("open");
      mocks.snapshot.value?.({ range: "7d", subscribers_total: 777 });
    });

    expect(text("live")).toBe("open");
    expect(text("total")).toBe("100");
    expect(text("last-success")).toBe(initialSuccessAt);
    expect(text("last-event")).toBe(initialEventAt);
  });

  it("drops superseded workspace responses and resets provenance", async () => {
    const oldStats = deferred<{ data: DashboardStatsResponse }>();
    const oldCampaigns = deferred<{ data: { items: Campaign[] } }>();
    const newStats = deferred<{ data: DashboardStatsResponse }>();
    const newCampaigns = deferred<{ data: { items: Campaign[] } }>();
    mocks.getStats
      .mockReset()
      .mockReturnValueOnce(oldStats.promise)
      .mockReturnValueOnce(newStats.promise);
    mocks.listCampaigns
      .mockReset()
      .mockReturnValueOnce(oldCampaigns.promise)
      .mockReturnValueOnce(newCampaigns.promise);

    const rendered = renderController();
    const oldTenantSnapshot = mocks.snapshot.value;
    rendered.rerender("30d", "tenant-2");
    expect(text("total")).toBe("null");
    expect(text("campaigns")).toBe("null");
    expect(text("resolved-range")).toBe("null");
    expect(text("last-success")).toBe("0");
    expect(text("load-state")).toBe("initial");
    act(() => {
      oldTenantSnapshot?.({ range: "30d", subscribers_total: 999 });
    });
    expect(text("total")).toBe("null");
    expect(text("last-success")).toBe("0");

    await act(async () => {
      oldStats.resolve({ data: stats(1, "30d") });
      oldCampaigns.resolve({ data: { items: [campaign("old-tenant")] } });
      await Promise.all([oldStats.promise, oldCampaigns.promise]);
    });
    expect(text("total")).toBe("null");
    expect(text("campaigns")).toBe("null");
    expect(text("load-state")).toBe("initial");

    vi.setSystemTime(new Date("2026-07-16T08:00:13.000Z"));
    await act(async () => {
      newStats.resolve({ data: stats(2, "30d") });
      newCampaigns.resolve({ data: { items: [campaign("new-tenant")] } });
      await Promise.all([newStats.promise, newCampaigns.promise]);
    });
    expect(text("total")).toBe("2");
    expect(text("campaigns")).toBe("new-tenant");
    expect(text("resolved-range")).toBe("30d");
    expect(text("last-success")).toBe(String(Date.now()));
    expect(text("load-state")).toBe("ready");
  });

  it("reports empty stats and a campaign failure without fabricating data", async () => {
    mocks.getStats.mockResolvedValue({ data: undefined });
    mocks.listCampaigns.mockResolvedValue({
      error: {
        kind: "http",
        status: 503,
        code: "campaigns_down",
        message: "campaign service unavailable",
      },
    });
    renderController();

    await waitFor(() => expect(text("failure-kind")).toBe("invalid"));
    expect(text("total")).toBe("null");
    expect(text("campaigns")).toBe("null");
    expect(text("load-state")).toBe("ready");
    expect(text("resolved-range")).toBe("null");
    expect(text("last-success")).toBe("0");
    expect(text("campaigns-loading")).toBe("false");
    expect(text("campaigns-error")).toBe("true");
    expect(text("campaigns-stale")).toBe("false");
    expect(document.body.textContent).not.toContain(
      "campaign service unavailable",
    );
    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});
