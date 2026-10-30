// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient } from "@tanstack/react-query";
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
  countCampaigns: vi.fn(),
  consumePendingDeepLinkTarget: vi.fn(),
  listCampaignFolders: vi.fn(),
  listCampaigns: vi.fn(),
  load: vi.fn(),
  onPendingDeepLinkTarget: vi.fn(),
  setBulkMoveOpen: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      countCampaigns: mocks.countCampaigns,
      listCampaignFolders: mocks.listCampaignFolders,
      listCampaigns: mocks.listCampaigns,
    },
    getABResults: vi.fn(),
    getABWeightHistory: vi.fn(),
  };
});

vi.mock("../../lib/deep-link", () => ({
  consumePendingDeepLinkTarget: mocks.consumePendingDeepLinkTarget,
  onPendingDeepLinkTarget: mocks.onPendingDeepLinkTarget,
}));

vi.mock("../../lib/event-bus", () => ({
  useEventSubscription: () => undefined,
}));

vi.mock("../../lib/template-handoff", () => ({
  consumePendingCampaignDraft: () => null,
  consumePendingTemplate: () => null,
}));

vi.mock("../../lib/use-query-invalidation-reload", () => ({
  useQueryInvalidationReload: () => undefined,
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError },
}));

vi.mock("../../components/campaigns/CampaignCalendar", () => ({
  CampaignCalendar: () => null,
}));

vi.mock("../../components/PendingSyncStatus", () => ({
  PendingSyncStatus: () => null,
}));

vi.mock("../../components/PresenceIndicator", () => ({
  PresenceIndicator: () => null,
}));

vi.mock("../../components/StatStrip", () => ({
  StatStrip: () => null,
}));

import type { Campaign } from "../../lib/api-client";
import { qk } from "../../lib/query-keys";
import { CampaignsTopPanels } from "../../pages/campaigns/CampaignsTopPanels";
import {
  CAMPAIGN_COMPLETE_CACHE_SCOPE,
  CAMPAIGN_RECONCILIATION_PAGE_SIZE,
} from "../../pages/campaigns/campaign-list-reconciliation";
import type { CampaignsController } from "../../pages/campaigns/useCampaignsController";
import { resolveCampaignSnapshotMutationAuthority } from "../../pages/campaigns/useCampaignsController";
import {
  type CampaignsData,
  useCampaignsData,
} from "../../pages/campaigns/useCampaignsData";
import {
  type CampaignsState,
  useCampaignsState,
} from "../../pages/campaigns/useCampaignsState";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function campaign(id: string): Campaign {
  return {
    id,
    name: `Campaign ${id}`,
    subject: `Subject ${id}`,
    status: "draft",
  } as Campaign;
}

function mockStableCampaignCount(total: number): void {
  mocks.countCampaigns.mockResolvedValue({
    data: { total, by_status: total === 0 ? {} : { draft: total } },
  });
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: { data: CampaignsData; state: CampaignsState } | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listCampaignFolders.mockResolvedValue({ data: { items: [] } });
  mocks.consumePendingDeepLinkTarget.mockReturnValue(null);
  mocks.onPendingDeepLinkTarget.mockReturnValue(() => undefined);
  mockStableCampaignCount(0);
  mocks.listCampaigns.mockResolvedValue({ data: [] });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  latest = null;
  document.body.replaceChildren();
});

function CampaignDataProbe({
  initialRows,
  queryClient,
  tenantId,
}: {
  initialRows: Campaign[] | null;
  queryClient: QueryClient;
  tenantId: string;
}): ReactElement {
  const state = useCampaignsState(() => initialRows);
  const data = useCampaignsData(state, {
    canSeedTenantCache: true,
    queryClient,
    role: "editor",
    tenantId,
  });
  latest = { data, state };
  return <div>{state.rows?.map((row) => row.id).join(",") ?? "none"}</div>;
}

function render(element: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

async function settle(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await act(async () => Promise.resolve());
  }
}

describe("campaign list snapshot ownership", () => {
  it("reconciles every bounded page before committing more than 100 campaigns", async () => {
    const firstPage = Array.from(
      { length: CAMPAIGN_RECONCILIATION_PAGE_SIZE },
      (_, index) => campaign(`campaign-${index + 1}`),
    );
    const secondPage = Array.from({ length: 37 }, (_, index) =>
      campaign(`campaign-${CAMPAIGN_RECONCILIATION_PAGE_SIZE + index + 1}`),
    );
    mocks.listCampaigns
      .mockResolvedValueOnce({ data: { items: firstPage } })
      .mockResolvedValueOnce({ data: { items: secondPage } })
      .mockResolvedValueOnce({ data: { items: firstPage } });
    mockStableCampaignCount(137);
    const queryClient = new QueryClient();

    render(
      <CampaignDataProbe
        initialRows={null}
        queryClient={queryClient}
        tenantId="tenant-1"
      />,
    );
    await settle();

    expect(mocks.listCampaigns).toHaveBeenCalledTimes(3);
    expect(mocks.listCampaigns.mock.calls[0][0]).toEqual({
      page: 1,
      perPage: CAMPAIGN_RECONCILIATION_PAGE_SIZE,
    });
    expect(mocks.listCampaigns.mock.calls[1][0]).toEqual({
      page: 2,
      perPage: CAMPAIGN_RECONCILIATION_PAGE_SIZE,
    });
    expect(mocks.listCampaigns.mock.calls[2][0]).toEqual({
      page: 1,
      perPage: CAMPAIGN_RECONCILIATION_PAGE_SIZE,
    });
    expect(latest?.state.rows).toHaveLength(137);
    expect(latest?.state.rows?.at(-1)?.id).toBe("campaign-137");
    expect(
      queryClient.getQueryData<Campaign[]>(
        qk.campaigns("tenant-1", "editor", CAMPAIGN_COMPLETE_CACHE_SCOPE),
      ),
    ).toHaveLength(137);
  });

  it("requests a terminal empty page for an exact page multiple", async () => {
    const firstPage = Array.from(
      { length: CAMPAIGN_RECONCILIATION_PAGE_SIZE },
      (_, index) => campaign(`first-${index + 1}`),
    );
    const secondPage = Array.from(
      { length: CAMPAIGN_RECONCILIATION_PAGE_SIZE },
      (_, index) => campaign(`second-${index + 1}`),
    );
    mocks.listCampaigns
      .mockResolvedValueOnce({ data: firstPage })
      .mockResolvedValueOnce({ data: secondPage })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: firstPage });
    mockStableCampaignCount(200);

    render(
      <CampaignDataProbe
        initialRows={null}
        queryClient={new QueryClient()}
        tenantId="tenant-1"
      />,
    );
    await settle(12);

    expect(mocks.listCampaigns).toHaveBeenCalledTimes(4);
    expect(mocks.listCampaigns.mock.calls[2][0]).toEqual({
      page: 3,
      perPage: CAMPAIGN_RECONCILIATION_PAGE_SIZE,
    });
    expect(latest?.state.rows).toHaveLength(200);
  });

  it("rejects top-page churn while later pages are being reconciled", async () => {
    const firstPage = Array.from(
      { length: CAMPAIGN_RECONCILIATION_PAGE_SIZE },
      (_, index) => campaign(`stable-${index + 1}`),
    );
    const changedAnchor = [campaign("new-top"), ...firstPage.slice(1)];
    mocks.listCampaigns
      .mockResolvedValueOnce({ data: firstPage })
      .mockResolvedValueOnce({ data: [campaign("later-page")] })
      .mockResolvedValueOnce({ data: changedAnchor });
    mockStableCampaignCount(101);

    render(
      <CampaignDataProbe
        initialRows={[campaign("retained")]}
        queryClient={new QueryClient()}
        tenantId="tenant-1"
      />,
    );
    await settle(12);

    expect(latest?.state.rows?.map((row) => row.id)).toEqual(["retained"]);
    expect(latest?.state.stale).toBe(true);
    expect(latest?.state.err).toContain(
      "first page changed while later pages were loading",
    );
  });

  it("rejects a count race instead of presenting a mixed snapshot as complete", async () => {
    mocks.countCampaigns
      .mockResolvedValueOnce({
        data: { total: 1, by_status: { draft: 1 } },
      })
      .mockResolvedValueOnce({
        data: { total: 2, by_status: { draft: 2 } },
      });
    mocks.listCampaigns.mockResolvedValueOnce({ data: [campaign("new")] });

    render(
      <CampaignDataProbe
        initialRows={[campaign("retained")]}
        queryClient={new QueryClient()}
        tenantId="tenant-1"
      />,
    );
    await settle();

    expect(latest?.state.rows?.map((row) => row.id)).toEqual(["retained"]);
    expect(latest?.state.stale).toBe(true);
    expect(latest?.state.err).toContain("workspace count changed from 1 to 2");
  });

  it("retains the last-good rows and marks their coverage stale on refresh failure", async () => {
    mocks.listCampaigns.mockResolvedValueOnce({
      error: { kind: "network", message: "gateway offline" },
    });
    render(
      <CampaignDataProbe
        initialRows={[campaign("retained")]}
        queryClient={new QueryClient()}
        tenantId="tenant-1"
      />,
    );

    await settle();

    expect(latest?.state.rows?.map((row) => row.id)).toEqual(["retained"]);
    expect(latest?.state.stale).toBe(true);
    expect(latest?.state.err).toContain(
      "Couldn't verify the complete campaign list on page 1",
    );
    expect(latest?.state.err).toContain("gateway offline");
    expect(latest?.state.loading).toBe(false);
    expect(latest?.state.refreshing).toBe(false);
  });

  it("rejects a later-page failure without committing its partial rows", async () => {
    const partialPage = Array.from(
      { length: CAMPAIGN_RECONCILIATION_PAGE_SIZE },
      (_, index) => campaign(`partial-${index + 1}`),
    );
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      qk.campaigns("tenant-1", "editor", CAMPAIGN_COMPLETE_CACHE_SCOPE),
      [campaign("retained")],
    );
    mocks.listCampaigns
      .mockResolvedValueOnce({ data: partialPage })
      .mockResolvedValueOnce({
        error: { kind: "network", message: "gateway offline" },
      });

    render(
      <CampaignDataProbe
        initialRows={[campaign("retained")]}
        queryClient={queryClient}
        tenantId="tenant-1"
      />,
    );
    await settle();

    expect(mocks.listCampaigns).toHaveBeenCalledTimes(2);
    expect(latest?.state.rows?.map((row) => row.id)).toEqual(["retained"]);
    expect(latest?.state.stale).toBe(true);
    expect(latest?.state.err).toContain(
      "Couldn't verify the complete campaign list on page 2",
    );
    expect(latest?.state.err).toContain("gateway offline");
    expect(
      queryClient
        .getQueryData<
          Campaign[]
        >(qk.campaigns("tenant-1", "editor", CAMPAIGN_COMPLETE_CACHE_SCOPE))
        ?.map((row) => row.id),
    ).toEqual(["retained"]);
  });

  it("rejects a repeated page without replacing the last-good snapshot", async () => {
    const repeated = Array.from(
      { length: CAMPAIGN_RECONCILIATION_PAGE_SIZE },
      (_, index) => campaign(`repeated-${index + 1}`),
    );
    mocks.listCampaigns
      .mockResolvedValueOnce({ data: repeated })
      .mockResolvedValueOnce({ data: repeated });

    render(
      <CampaignDataProbe
        initialRows={[campaign("retained")]}
        queryClient={new QueryClient()}
        tenantId="tenant-1"
      />,
    );
    await settle();

    expect(latest?.state.rows?.map((row) => row.id)).toEqual(["retained"]);
    expect(latest?.state.stale).toBe(true);
    expect(latest?.state.err).toContain("repeated an earlier page");
  });

  it("rejects an overlapping page because duplicate IDs make coverage ambiguous", async () => {
    const firstPage = Array.from(
      { length: CAMPAIGN_RECONCILIATION_PAGE_SIZE },
      (_, index) => campaign(`overlap-${index + 1}`),
    );
    mocks.listCampaigns
      .mockResolvedValueOnce({ data: firstPage })
      .mockResolvedValueOnce({
        data: [campaign("overlap-100"), campaign("new-row")],
      });

    render(
      <CampaignDataProbe
        initialRows={[campaign("retained")]}
        queryClient={new QueryClient()}
        tenantId="tenant-1"
      />,
    );
    await settle();

    expect(latest?.state.rows?.map((row) => row.id)).toEqual(["retained"]);
    expect(latest?.state.err).toContain(
      "Campaign overlap-100 appeared on more than one page",
    );
  });

  it("does not manufacture a verified empty collection on first-load failure", async () => {
    mocks.listCampaigns.mockResolvedValueOnce({
      error: { kind: "server", message: "service unavailable" },
    });
    render(
      <CampaignDataProbe
        initialRows={null}
        queryClient={new QueryClient()}
        tenantId="tenant-1"
      />,
    );

    await settle();

    expect(latest?.state.rows).toBeNull();
    expect(latest?.state.stale).toBe(false);
    expect(latest?.state.err).toContain(
      "Couldn't verify the complete campaign list on page 1",
    );
    expect(latest?.state.err).toContain("service unavailable");
  });

  it("lets only the latest overlapping refresh commit", async () => {
    const oldRequest = deferred<{ data: Campaign[] }>();
    const newRequest = deferred<{ data: Campaign[] }>();
    mocks.listCampaigns
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise);
    mockStableCampaignCount(1);
    render(
      <CampaignDataProbe
        initialRows={[campaign("retained")]}
        queryClient={new QueryClient()}
        tenantId="tenant-1"
      />,
    );
    await settle();
    expect(mocks.listCampaigns).toHaveBeenCalledTimes(1);

    let latestLoad!: Promise<Campaign[] | null>;
    act(() => {
      latestLoad = latest!.data.load();
    });
    await settle();
    expect(mocks.listCampaigns).toHaveBeenCalledTimes(2);
    expect(
      (mocks.listCampaigns.mock.calls[0][1] as { signal: AbortSignal }).signal
        .aborted,
    ).toBe(true);

    await act(async () => {
      newRequest.resolve({ data: [campaign("fresh")] });
      await latestLoad;
    });
    await act(async () => {
      oldRequest.resolve({ data: [campaign("obsolete")] });
      await Promise.resolve();
    });

    expect(latest?.state.rows?.map((row) => row.id)).toEqual(["fresh"]);
    expect(latest?.state.stale).toBe(false);
  });

  it("aborts an unmounted identity and never seeds its late response", async () => {
    const oldRequest = deferred<{ data: Campaign[] }>();
    const newRequest = deferred<{ data: Campaign[] }>();
    const queryClient = new QueryClient();
    mocks.listCampaigns
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise);
    mockStableCampaignCount(1);
    render(
      <CampaignDataProbe
        key="tenant-old"
        initialRows={null}
        queryClient={queryClient}
        tenantId="tenant-old"
      />,
    );
    await settle();

    act(() =>
      root?.render(
        <CampaignDataProbe
          key="tenant-new"
          initialRows={null}
          queryClient={queryClient}
          tenantId="tenant-new"
        />,
      ),
    );
    await settle();
    expect(mocks.listCampaigns).toHaveBeenCalledTimes(2);

    oldRequest.resolve({ data: [campaign("old-identity")] });
    await settle();
    expect(
      queryClient.getQueryData(
        qk.campaigns("tenant-old", "editor", CAMPAIGN_COMPLETE_CACHE_SCOPE),
      ),
    ).toBeUndefined();

    newRequest.resolve({ data: [campaign("new-identity")] });
    await settle();
    expect(
      queryClient
        .getQueryData<
          Campaign[]
        >(qk.campaigns("tenant-new", "editor", CAMPAIGN_COMPLETE_CACHE_SCOPE))
        ?.map((row) => row.id),
    ).toEqual(["new-identity"]);
  });

  it("aborts an old identity between pages and ignores its late partial response", async () => {
    const oldFirstPage = Array.from(
      { length: CAMPAIGN_RECONCILIATION_PAGE_SIZE },
      (_, index) => campaign(`old-${index + 1}`),
    );
    const oldSecondPage = deferred<{ data: Campaign[] }>();
    const newFirstPage = deferred<{ data: Campaign[] }>();
    const queryClient = new QueryClient();
    mocks.listCampaigns
      .mockResolvedValueOnce({ data: oldFirstPage })
      .mockReturnValueOnce(oldSecondPage.promise)
      .mockReturnValueOnce(newFirstPage.promise);
    mockStableCampaignCount(1);
    render(
      <CampaignDataProbe
        key="tenant-old"
        initialRows={null}
        queryClient={queryClient}
        tenantId="tenant-old"
      />,
    );
    await settle(16);
    expect(mocks.listCampaigns).toHaveBeenCalledTimes(2);

    act(() =>
      root?.render(
        <CampaignDataProbe
          key="tenant-new"
          initialRows={null}
          queryClient={queryClient}
          tenantId="tenant-new"
        />,
      ),
    );
    expect(
      (mocks.listCampaigns.mock.calls[1][1] as { signal: AbortSignal }).signal
        .aborted,
    ).toBe(true);

    oldSecondPage.resolve({ data: [campaign("old-late")] });
    newFirstPage.resolve({ data: [campaign("new-complete")] });
    await settle();

    expect(
      queryClient.getQueryData(
        qk.campaigns("tenant-old", "editor", CAMPAIGN_COMPLETE_CACHE_SCOPE),
      ),
    ).toBeUndefined();
    expect(
      queryClient
        .getQueryData<
          Campaign[]
        >(qk.campaigns("tenant-new", "editor", CAMPAIGN_COMPLETE_CACHE_SCOPE))
        ?.map((row) => row.id),
    ).toEqual(["new-complete"]);
  });

  it("refuses an external deep link that would replace an open campaign identity", async () => {
    const rows = [campaign("campaign-a"), campaign("campaign-b")];
    mocks.listCampaigns.mockResolvedValueOnce({ data: rows });
    mockStableCampaignCount(2);
    render(
      <CampaignDataProbe
        initialRows={null}
        queryClient={new QueryClient()}
        tenantId="tenant-1"
      />,
    );
    await settle();
    act(() => latest?.state.setSelected(rows[0] ?? null));

    const listener = mocks.onPendingDeepLinkTarget.mock.calls[0]?.[0] as
      | ((target: { section: string; id: string }) => void)
      | undefined;
    expect(listener).toBeTypeOf("function");
    act(() => listener?.({ section: "campaigns", id: "campaign-b" }));
    await settle();

    expect(latest?.state.selected?.id).toBe("campaign-a");
    expect(latest?.state.pendingDeepLinkId).toBeNull();
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining("Close the open campaign"),
    );
  });
});

function topPanelsController(
  overrides: Partial<CampaignsState> = {},
): CampaignsController {
  const row = campaign("one");
  const state = {
    rows: [row],
    loading: false,
    refreshing: false,
    stale: true,
    lastConfirmedAt: new Date("2026-07-20T12:00:00Z"),
    err: "gateway offline",
    query: "",
    filter: "all",
    folderFilter: "",
    folders: [],
    newFolderName: "",
    viewMode: "list",
    selectedIds: new Set(["one"]),
    bulkBusy: false,
    setQuery: vi.fn(),
    setPage: vi.fn(),
    setFilter: vi.fn(),
    setFolderFilter: vi.fn(),
    setNewFolderName: vi.fn(),
    setViewMode: vi.fn(),
    setBulkMovePick: vi.fn(),
    setBulkMoveOpen: mocks.setBulkMoveOpen,
    ...overrides,
  };
  const authority = resolveCampaignSnapshotMutationAuthority({
    canMutate: true,
    canAdminMutate: true,
    roleStatus: "resolved",
    rowsAvailable: state.rows !== null,
    loading: state.loading,
    refreshing: state.refreshing,
    stale: state.stale,
    error: state.err,
  });
  return {
    canMutate: true,
    canAdminMutate: true,
    ...authority,
    state,
    view: {
      filtered: [row],
      sorted: [row],
      statCells: [],
    },
    creation: { openCreate: vi.fn() },
    data: { load: mocks.load },
    rowActions: { createFolder: vi.fn(), rescheduleFromCalendar: vi.fn() },
    bulkActions: {
      promptBulkTag: vi.fn(),
      bulkExportCsv: vi.fn(),
      promptBulkDelete: vi.fn(),
      clearSelection: vi.fn(),
    },
  } as unknown as CampaignsController;
}

describe("campaign list failure and permission presentation", () => {
  it("labels a healthy list as complete workspace coverage", () => {
    render(
      <CampaignsTopPanels
        controller={topPanelsController({
          stale: false,
          err: null,
          lastConfirmedAt: new Date("2026-07-20T12:00:00Z"),
        })}
      />,
    );

    expect(document.body.textContent).toContain(
      "1 campaign · complete workspace snapshot",
    );
    expect(document.body.textContent).not.toContain("first 100");
  });

  it("labels retained rows as revalidating before a refresh outcome is known", () => {
    render(
      <CampaignsTopPanels
        controller={topPanelsController({
          stale: false,
          refreshing: true,
          err: null,
        })}
      />,
    );

    expect(document.body.textContent).toContain(
      "complete last-confirmed snapshot · revalidating",
    );
    expect(document.body.textContent).not.toContain(
      "complete workspace snapshot",
    );
  });

  it("keeps retained-snapshot bulk mutations native-disabled while export and clear remain available", () => {
    render(<CampaignsTopPanels controller={topPanelsController()} />);

    expect(document.body.textContent).toContain(
      "Showing last-confirmed campaigns",
    );
    expect(document.body.textContent).toContain(
      "1 campaign · complete last-confirmed snapshot",
    );
    expect(document.body.textContent).toContain(
      "may no longer reflect current coverage or metrics",
    );
    expect(document.body.textContent).toContain("gateway offline");
    expect(document.body.textContent).toContain(
      "Refresh campaigns successfully before changing this retained snapshot.",
    );
    const buttons = (label: string): HTMLButtonElement =>
      Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === label,
      ) as HTMLButtonElement;
    const move = buttons("Move to folder");
    for (const label of ["Move to folder", "Tag", "Delete"]) {
      const control = buttons(label);
      expect(control.disabled).toBe(true);
      expect(control.getAttribute("aria-describedby")).toBe(
        "campaign-bulk-write-guidance",
      );
    }
    expect(buttons("Export CSV").disabled).toBe(false);
    expect(buttons("Clear").disabled).toBe(false);
    const folder = document.querySelector(
      '[aria-label="New folder name"]',
    ) as HTMLInputElement;
    expect(folder.disabled).toBe(true);
    expect(folder.getAttribute("aria-describedby")).toBe(
      "campaign-new-folder-unavailable",
    );
    act(() => move.click());
    expect(mocks.setBulkMoveOpen).not.toHaveBeenCalled();
  });

  it("labels a first-load failure unavailable instead of empty", () => {
    render(
      <CampaignsTopPanels
        controller={topPanelsController({
          rows: null,
          loading: false,
          stale: false,
          lastConfirmedAt: null,
          err: "service unavailable",
          selectedIds: new Set(),
        })}
      />,
    );

    expect(document.body.textContent).toContain("Campaigns are unavailable");
    expect(document.body.textContent).toContain(
      "No verified campaign snapshot is available.",
    );
    expect(document.body.textContent).not.toContain("Ship campaigns that land");
  });
});
