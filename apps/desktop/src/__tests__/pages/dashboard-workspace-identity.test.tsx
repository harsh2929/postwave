// @vitest-environment happy-dom

import { act } from "react";
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
  connect: vi.fn(),
  disconnect: vi.fn(),
  getLayout: vi.fn(),
  getStats: vi.fn(),
  identity: {
    value: null as null | {
      user: string;
      tenant: string;
      role: "admin";
      effectiveRole: "admin";
    },
  },
  listAnomalies: vi.fn(),
  listCampaigns: vi.fn(),
  notifyAnomalies: vi.fn(),
  notifyMilestones: vi.fn(),
  putLayout: vi.fn(),
  setActiveSend: vi.fn(),
  setLiveSubs: vi.fn(),
  setQueryData: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    getDashboardLayout: mocks.getLayout,
    getDashboardStats: mocks.getStats,
    listCampaigns: mocks.listCampaigns,
    listDashboardAnomalies: mocks.listAnomalies,
    putDashboardLayout: mocks.putLayout,
  },
}));

vi.mock("../../lib/store", () => ({
  setActiveSend: mocks.setActiveSend,
  setLiveSubs: mocks.setLiveSubs,
  setSection: vi.fn(),
  useMe: () => mocks.identity.value,
  useRole: () => mocks.identity.value?.effectiveRole ?? null,
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ setQueryData: mocks.setQueryData }),
}));

vi.mock("../../lib/use-query-invalidation-reload", () => ({
  useQueryInvalidationReload: vi.fn(),
}));

vi.mock("../../lib/sse", () => ({
  connectDashboardLive: mocks.connect,
}));

vi.mock("../../lib/dashboard-notifier", () => ({
  notifyMilestoneCrossings: mocks.notifyMilestones,
  notifyNewAnomalies: mocks.notifyAnomalies,
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

vi.mock("../../components/dashboard/AnomalyHistoryCard", () => ({
  AnomalyHistoryCard: () => null,
}));
vi.mock("../../components/dashboard/AuditFeedCard", () => ({
  AuditFeedCard: () => null,
}));
vi.mock("../../components/dashboard/BenchmarksCard", () => ({
  BenchmarksCard: () => null,
}));
vi.mock("../../components/dashboard/CLVDashboard", () => ({
  CLVDashboard: () => null,
}));
vi.mock("../../components/dashboard/DashboardSectionList", () => ({
  DashboardSectionList: () => null,
}));
vi.mock("../../components/dashboard/DashboardStatGrid", () => ({
  DashboardStatGrid: () => null,
}));
vi.mock("../../components/dashboard/DashboardToolbar", () => ({
  DashboardToolbar: () => null,
}));
vi.mock("../../components/dashboard/ForecastStrip", () => ({
  ForecastStrip: () => null,
}));
vi.mock("../../components/dashboard/GoalsCard", () => ({
  GoalsCard: () => null,
}));
vi.mock("../../components/dashboard/InboxHealthCard", () => ({
  InboxHealthCard: () => null,
}));
vi.mock("../../components/dashboard/MailchimpParityCard", () => ({
  MailchimpParityCard: () => null,
}));
vi.mock("../../components/dashboard/RecentCampaignsCard", () => ({
  RecentCampaignsCard: () => null,
}));
vi.mock("../../components/dashboard/StaleIndicator", () => ({
  StaleIndicator: () => null,
}));
vi.mock("../../components/OnboardingChecklist", () => ({
  OnboardingChecklist: () => null,
}));

import { Dashboard } from "../../pages/Dashboard";
import { desktopRouteIdentityScope } from "../../lib/desktop-router";

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
  window.localStorage.clear();
  mocks.identity.value = null;
  mocks.connect.mockImplementation(() => mocks.disconnect);
  mocks.getLayout.mockResolvedValue({
    data: {
      userId: "user-1",
      tenantId: "tenant-1",
      order: ["subs", "opens", "clicks", "bounces"],
      updatedAt: "2026-07-16T08:00:00.000Z",
    },
  });
  mocks.getStats.mockResolvedValue({ data: { subscribers_total: 10 } });
  mocks.listCampaigns.mockResolvedValue({ data: { items: [] } });
  mocks.listAnomalies.mockResolvedValue({ data: { items: [] } });
  mocks.notifyAnomalies.mockResolvedValue(0);
  mocks.notifyMilestones.mockResolvedValue(0);
  mocks.putLayout.mockResolvedValue({ data: { ok: true } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  window.localStorage.clear();
  vi.clearAllMocks();
});

function renderDashboard(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Dashboard />));
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

describe("Dashboard workspace identity boundary", () => {
  it("starts no workspace reads before identity and remounts controllers for each tenant", async () => {
    renderDashboard();

    expect(mocks.getLayout).not.toHaveBeenCalled();
    expect(mocks.getStats).not.toHaveBeenCalled();
    expect(mocks.listCampaigns).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();

    mocks.identity.value = {
      user: "user-1",
      tenant: "tenant-1",
      role: "admin",
      effectiveRole: "admin",
    };
    act(() => root?.render(<Dashboard />));
    await waitFor(() => expect(mocks.getLayout).toHaveBeenCalledTimes(1));
    expect(mocks.getStats).toHaveBeenCalledTimes(1);
    expect(mocks.listCampaigns).toHaveBeenCalledTimes(1);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    const firstScope = desktopRouteIdentityScope("user-1", "tenant-1");
    expect(
      window.localStorage.getItem(`pw.dashboard.v2.range:${firstScope}`),
    ).toBe("30d");
    expect(
      window.localStorage.getItem("pw.dashboard.tenant-1.range"),
    ).toBeNull();

    mocks.identity.value = {
      user: "user-2",
      tenant: "tenant-2",
      role: "admin",
      effectiveRole: "admin",
    };
    act(() => root?.render(<Dashboard />));
    await waitFor(() => expect(mocks.getLayout).toHaveBeenCalledTimes(2));
    expect(mocks.getStats).toHaveBeenCalledTimes(2);
    expect(mocks.listCampaigns).toHaveBeenCalledTimes(2);
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    const secondScope = desktopRouteIdentityScope("user-2", "tenant-2");
    expect(
      window.localStorage.getItem(`pw.dashboard.v2.range:${secondScope}`),
    ).toBe("30d");
    expect(
      window.localStorage.getItem("pw.dashboard.tenant-2.range"),
    ).toBeNull();

    mocks.identity.value = {
      user: "user-3",
      tenant: "tenant-2",
      role: "admin",
      effectiveRole: "admin",
    };
    act(() => root?.render(<Dashboard />));
    await waitFor(() => expect(mocks.getLayout).toHaveBeenCalledTimes(3));
    expect(mocks.getStats).toHaveBeenCalledTimes(3);
    expect(mocks.disconnect).toHaveBeenCalledTimes(2);
    const thirdScope = desktopRouteIdentityScope("user-3", "tenant-2");
    expect(thirdScope).not.toBe(secondScope);
    expect(
      window.localStorage.getItem(`pw.dashboard.v2.range:${thirdScope}`),
    ).toBe("30d");
  });
});
