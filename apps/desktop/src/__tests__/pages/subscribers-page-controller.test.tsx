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
  canWrite: true,
  canAdmin: true,
  tenant: "tenant-1",
  user: "operator-1",
  listSubscribers: vi.fn(),
  getDashboardStats: vi.fn(),
  getSubscriber: vi.fn(),
  updateSubscriber: vi.fn(),
  exportSubscribersCSV: vi.fn(),
  getSubscribersViewPrefs: vi.fn(),
  putSubscribersViewPrefs: vi.fn(),
  listSavedSegments: vi.fn(),
  previewSavedSegmentDetail: vi.fn(),
  patchSavedSegment: vi.fn(),
  createSavedSegment: vi.fn(),
  deleteSavedSegment: vi.fn(),
  setQueryData: vi.fn(),
  consumeDeepLink: vi.fn(),
  onDeepLink: vi.fn(),
  desktopRoute: { section: "subscribers" } as {
    section: string;
    resourceId?: string;
    tab?: string;
    query?: string;
    sort?: { field: string; direction: "asc" | "desc" };
    filters?: Array<{ key: string; value: string }>;
    overlay?: { name: string; resourceId?: string };
  },
  navigateDesktopRoute: vi.fn(),
  requestDesktopRouteNavigation: vi.fn(),
  requestDesktopRouteBackNavigation: vi.fn(),
  replaceOverlay: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  online: "online" as "online" | "connecting" | "offline",
  streamStatus: "open" as "connecting" | "open" | "reconnecting" | "closed",
  outbox: {
    all: [],
    recent: [],
  } as {
    all: Array<Record<string, unknown>>;
    recent: Array<Record<string, unknown>>;
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ setQueryData: mocks.setQueryData }),
}));

vi.mock("../../lib/auth", () => ({
  redact: (message: string) =>
    message.replace(/(token|password|code)=[^\s&]+/gi, "$1=***"),
}));

vi.mock("../../components/subscribers/SubscribersBrowsePanel", () => ({
  SUBSCRIBER_SORTABLE_COLUMNS: {},
}));

vi.mock("../../lib/api-client", () => ({
  isExactSubscriberVersion: (value: unknown) =>
    typeof value === "string" && /^"subscriber:[^"]+:v\d+"$/u.test(value),
  api: {
    listSubscribers: mocks.listSubscribers,
    getDashboardStats: mocks.getDashboardStats,
    getSubscriber: mocks.getSubscriber,
    updateSubscriber: mocks.updateSubscriber,
    exportSubscribersCSV: mocks.exportSubscribersCSV,
  },
  getSubscribersViewPrefs: mocks.getSubscribersViewPrefs,
  putSubscribersViewPrefs: mocks.putSubscribersViewPrefs,
  listSavedSegments: mocks.listSavedSegments,
  previewSavedSegmentDetail: mocks.previewSavedSegmentDetail,
  patchSavedSegment: mocks.patchSavedSegment,
  createSavedSegment: mocks.createSavedSegment,
  deleteSavedSegment: mocks.deleteSavedSegment,
}));

vi.mock("../../lib/store", () => ({
  useCanWrite: () => mocks.canWrite,
  useCanAdmin: () => mocks.canAdmin,
  useMe: () => ({
    user: mocks.user,
    tenant: mocks.tenant,
    role: "admin",
    effectiveRole: mocks.canWrite ? "admin" : "viewer",
  }),
  useRole: () => (mocks.canWrite ? "admin" : "viewer"),
  useRoleStatus: () => "resolved",
}));

vi.mock("../../lib/use-query-invalidation-reload", () => ({
  useQueryInvalidationReload: vi.fn(),
}));

vi.mock("../../lib/event-bus", () => ({
  useEventSubscription: vi.fn(),
  useEventBus: () => ({ status: mocks.streamStatus }),
}));

vi.mock("../../lib/online-manager", () => ({
  useOnline: () => mocks.online,
}));

vi.mock("../../lib/outbox", () => ({
  useOutbox: () => mocks.outbox,
}));

vi.mock("../../lib/deep-link", () => ({
  consumePendingDeepLinkTarget: mocks.consumeDeepLink,
  onPendingDeepLinkTarget: mocks.onDeepLink,
}));

vi.mock("../../lib/desktop-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/desktop-router")>();
  return {
    ...actual,
    desktopRouteIdentityScope: () => `${mocks.user}:${mocks.tenant}`,
    useDesktopRoute: () => mocks.desktopRoute,
    useDesktopRouteSnapshot: () => ({
      route: mocks.desktopRoute,
      canonicalUrl: actual.serializeDesktopRoute(
        mocks.desktopRoute as Parameters<
          typeof actual.serializeDesktopRoute
        >[0],
      ),
      revision: 0,
      source: "navigation" as const,
      restoreScrollTop: null,
    }),
    getDesktopRoute: () => mocks.desktopRoute,
    navigateDesktopRoute: mocks.navigateDesktopRoute,
    requestDesktopRouteNavigation: mocks.requestDesktopRouteNavigation,
    requestDesktopRouteBackNavigation: mocks.requestDesktopRouteBackNavigation,
    replaceDesktopRouteAfterExplicitOverlayClose: mocks.replaceOverlay,
  };
});

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
    info: mocks.toastInfo,
  },
}));

import { useSubscribersPageController } from "../../pages/subscribers/useSubscribersPageController";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

async function flushEffects(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => Promise.resolve());
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canWrite = true;
  mocks.canAdmin = true;
  mocks.tenant = "tenant-1";
  mocks.user = "operator-1";
  mocks.online = "online";
  mocks.streamStatus = "open";
  mocks.outbox = { all: [], recent: [] };
  sessionStorage.clear();
  mocks.consumeDeepLink.mockReturnValue(null);
  mocks.onDeepLink.mockReturnValue(() => undefined);
  mocks.desktopRoute = { section: "subscribers" };
  mocks.requestDesktopRouteNavigation.mockImplementation(async (route) => {
    mocks.desktopRoute = route;
    return "proceeded";
  });
  mocks.requestDesktopRouteBackNavigation.mockImplementation(async (route) => {
    mocks.desktopRoute = route;
    return "proceeded";
  });
  mocks.getSubscribersViewPrefs.mockResolvedValue({ data: {} });
  mocks.putSubscribersViewPrefs.mockResolvedValue({ data: {} });
  mocks.listSavedSegments.mockResolvedValue({ data: { items: [] } });
  mocks.patchSavedSegment.mockResolvedValue({ data: {} });
  mocks.createSavedSegment.mockResolvedValue({ data: {} });
  mocks.deleteSavedSegment.mockResolvedValue({ data: { ok: true } });
  mocks.previewSavedSegmentDetail.mockResolvedValue({
    data: {
      id: "saved-1",
      count: 1,
      workspace_total: 2,
      workspace_percentage: 50,
      generated_at: "2026-07-18T00:00:00.000Z",
    },
  });
  mocks.getDashboardStats.mockResolvedValue({
    data: { subscribers_added_30d: 7, subscribers_unsubbed_30d: 2 },
  });
  mocks.listSubscribers.mockImplementation(
    async (options: { status?: string }) => ({
      data: options.status
        ? {
            items: [
              {
                id: "subscriber-2",
                version: `"subscriber:subscriber-2:v1"`,
                email: "blocked@example.test",
                status: "blocklisted",
              },
            ],
            total: 1,
            page: 1,
            per_page: 50,
          }
        : {
            items: [
              {
                id: "subscriber-1",
                version: `"subscriber:subscriber-1:v1"`,
                email: "alice@example.test",
                status: "enabled",
              },
            ],
            total: 2,
            page: 1,
            per_page: 50,
          },
    }),
  );
  mocks.getSubscriber.mockResolvedValue({
    data: {
      id: "subscriber-42",
      version: `"subscriber:subscriber-42:v1"`,
      email: "deep-link@example.test",
      status: "enabled",
    },
  });
  mocks.updateSubscriber.mockResolvedValue({
    data: {
      id: "subscriber-1",
      version: `"subscriber:subscriber-1:v2"`,
      email: "alice@example.test",
      status: "disabled",
    },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  sessionStorage.clear();
  vi.clearAllMocks();
});

function Probe(): ReactElement {
  const controller = useSubscribersPageController();
  const first = controller.data.pageRows[0];
  return (
    <div>
      <span data-testid="rows">
        {controller.data.rows?.map((row) => row.id).join(",") ?? "loading"}
      </span>
      <span data-testid="first-status">{first?.status ?? "none"}</span>
      <span data-testid="first-email">{first?.email ?? "none"}</span>
      <span data-testid="subtitle">{controller.subtitle}</span>
      <span data-testid="selected-keys">
        {controller.state.selectedKeys.size}
      </span>
      <span data-testid="selected-detail">
        {controller.state.selected?.email ?? "none"}
      </span>
      <span data-testid="can-mutate">{String(controller.canMutate)}</span>
      <span data-testid="create-open">
        {String(controller.state.createOpen)}
      </span>
      <span data-testid="import-open">
        {String(controller.state.importOpen)}
      </span>
      <span data-testid="query">{controller.state.query}</span>
      <span data-testid="route-open-error">
        {controller.deepLinks.routeOpenError ?? "none"}
      </span>
      <span data-testid="stale">{String(controller.data.stale)}</span>
      <span data-testid="directory-loading">
        {String(controller.data.loading)}
      </span>
      <span data-testid="server-total">
        {controller.data.serverTotal ?? "none"}
      </span>
      <span data-testid="last-confirmed">
        {controller.data.lastConfirmedAt ? "confirmed" : "none"}
      </span>
      <span data-testid="refresh-error">{controller.data.error ?? "none"}</span>
      <span data-testid="status-consent-target">
        {controller.mutations.statusConsentTarget?.email ?? "none"}
      </span>
      <span data-testid="saved-error">
        {controller.saved.savedSegmentsError ?? "none"}
      </span>
      <span data-testid="saved-count">
        {controller.saved.savedSegments.length}
      </span>
      <span data-testid="active-saved">
        {controller.saved.activeSavedSegmentId ?? "none"}
      </span>
      <span data-testid="saved-columns">
        {controller.view.visibleColumnKeys.join(",")}
      </span>
      <span data-testid="save-draft">
        {[
          String(controller.saved.saveCurrentOpen),
          controller.saved.saveCurrentName,
          controller.saved.saveCurrentScope,
          controller.saved.saveCurrentServerError ?? "none",
        ].join("|")}
      </span>
      <button
        type="button"
        data-testid="select-first"
        disabled={!first}
        onClick={() => first && controller.selection.selectRow(first, {})}
      >
        Select
      </button>
      <button
        type="button"
        data-testid="open-first"
        disabled={!first}
        onClick={() => first && controller.deepLinks.openSubscriber(first)}
      >
        Open
      </button>
      <button
        type="button"
        data-testid="close-detail"
        onClick={controller.deepLinks.closeSubscriber}
      >
        Close detail
      </button>
      <button
        type="button"
        data-testid="retry-detail"
        onClick={controller.deepLinks.retryRouteOpen}
      >
        Retry detail
      </button>
      <button
        type="button"
        data-testid="apply-first-saved"
        disabled={!controller.saved.savedSegments[0]}
        onClick={() => {
          const firstSaved = controller.saved.savedSegments[0];
          if (firstSaved) void controller.saved.applySavedSegment(firstSaved);
        }}
      >
        Apply saved
      </button>
      <button
        type="button"
        data-testid="prepare-workspace-save"
        onClick={() => {
          controller.saved.openSaveCurrent();
          controller.saved.setSaveCurrentName("Reader view");
          controller.saved.setSaveCurrentScope("workspace");
        }}
      >
        Prepare save
      </button>
      <button
        type="button"
        data-testid="rename-save"
        onClick={() => controller.saved.setSaveCurrentName("Reader view 2")}
      >
        Rename save
      </button>
      <button
        type="button"
        data-testid="submit-save-twice"
        onClick={() => {
          void controller.saved.submitSaveCurrent();
          void controller.saved.submitSaveCurrent();
        }}
      >
        Submit save
      </button>
      <button
        type="button"
        data-testid="filter-unsubscribed"
        onClick={() => controller.changeFilter("unsubscribed")}
      >
        Unsubscribed
      </button>
      <button
        type="button"
        data-testid="type-query"
        onClick={() => controller.state.setQuery("blocked-query")}
      >
        Type query
      </button>
      <button
        type="button"
        data-testid="next-page"
        onClick={() =>
          void controller.state.requestViewChange((current) => ({
            ...current,
            page: current.page + 1,
          }))
        }
      >
        Next page
      </button>
      <button
        type="button"
        data-testid="review-enable-first"
        disabled={!first}
        onClick={() =>
          first &&
          controller.mutations.setRowStatus(
            { ...first, status: "disabled" },
            "subscribed",
          )
        }
      >
        Review enable
      </button>
      <button
        type="button"
        data-testid="disable-first"
        disabled={!first}
        onClick={() =>
          first && controller.mutations.setRowStatus(first, "disabled")
        }
      >
        Disable
      </button>
      <button
        type="button"
        data-testid="reload"
        onClick={controller.data.reload}
      >
        Reload
      </button>
      <button
        type="button"
        data-testid="customize-view"
        onClick={() => {
          controller.state.setQuery("reader");
          controller.state.setDebouncedQuery("reader");
          controller.state.setFilter("unconfirmed");
          controller.state.setShowArchived(true);
          controller.state.setSortColumn("email");
          controller.state.setSortOrder("asc");
          controller.state.setPage(4);
          controller.state.setSelectedKeys(new Set(["subscriber-1"]));
        }}
      >
        Customize
      </button>
      <button
        type="button"
        data-testid="reset-view"
        onClick={controller.resetView}
      >
        Reset view
      </button>
      <span data-testid="view-state">
        {[
          controller.state.query,
          controller.state.filter,
          String(controller.state.showArchived),
          controller.state.sortColumn,
          controller.state.sortOrder,
          String(controller.state.page),
          String(controller.state.selectedKeys.size),
        ].join("|")}
      </span>
    </div>
  );
}

function renderProbe(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Probe />));
}

function textByTestId(testId: string): string | null {
  return (
    container?.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null
  );
}

describe("subscribers page controller interaction", () => {
  it("routes enable through consent review while preserving non-enable status edits", async () => {
    renderProbe();
    await flushEffects();

    act(() =>
      container
        ?.querySelector<HTMLButtonElement>(
          '[data-testid="review-enable-first"]',
        )
        ?.click(),
    );
    expect(textByTestId("status-consent-target")).toBe("alice@example.test");
    expect(mocks.updateSubscriber).not.toHaveBeenCalled();

    act(() =>
      container
        ?.querySelector<HTMLButtonElement>('[data-testid="disable-first"]')
        ?.click(),
    );
    await flushEffects();
    expect(mocks.updateSubscriber).toHaveBeenCalledWith(
      "subscriber-1",
      { status: "disabled" },
      { version: `"subscriber:subscriber-1:v1"` },
    );
  });

  it("loads the server page, preserves selection semantics, and maps status filters", async () => {
    renderProbe();
    await flushEffects();

    expect(mocks.listSubscribers).toHaveBeenNthCalledWith(
      1,
      {
        page: 1,
        perPage: 50,
        sort: "updated_at",
        order: "desc",
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(textByTestId("rows")).toBe("subscriber-1");
    expect(textByTestId("subtitle")).toBe("2 contacts in this workspace.");
    expect(textByTestId("can-mutate")).toBe("true");

    act(() => {
      (
        container?.querySelector(
          '[data-testid="select-first"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(textByTestId("selected-keys")).toBe("1");

    act(() => {
      (
        container?.querySelector(
          '[data-testid="filter-unsubscribed"]',
        ) as HTMLButtonElement
      ).click();
    });
    await flushEffects();

    expect(mocks.listSubscribers).toHaveBeenLastCalledWith(
      {
        status: "blocklisted",
        page: 1,
        perPage: 50,
        sort: "updated_at",
        order: "desc",
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(textByTestId("rows")).toBe("subscriber-2");
    expect(textByTestId("selected-keys")).toBe("0");
    expect(textByTestId("subtitle")).toBe("1 contact matching this view.");
  });

  it("keeps a cancelled filter atomic and lets the same action be retried", async () => {
    renderProbe();
    await flushEffects();
    act(() =>
      container
        ?.querySelector<HTMLButtonElement>('[data-testid="select-first"]')
        ?.click(),
    );
    mocks.requestDesktopRouteNavigation.mockResolvedValueOnce("cancelled");

    act(() =>
      container
        ?.querySelector<HTMLButtonElement>(
          '[data-testid="filter-unsubscribed"]',
        )
        ?.click(),
    );
    await flushEffects();

    expect(textByTestId("view-state")).toBe("|all|false|updated_at|desc|1|1");
    expect(mocks.listSubscribers).toHaveBeenCalledTimes(1);

    act(() =>
      container
        ?.querySelector<HTMLButtonElement>(
          '[data-testid="filter-unsubscribed"]',
        )
        ?.click(),
    );
    await flushEffects();
    expect(textByTestId("view-state")).toBe(
      "|unsubscribed|false|updated_at|desc|1|0",
    );
  });

  it("does not apply or fetch a query/page change when lifecycle review cancels", async () => {
    vi.useFakeTimers();
    try {
      renderProbe();
      await flushEffects();
      mocks.requestDesktopRouteNavigation.mockResolvedValueOnce("cancelled");
      act(() =>
        container
          ?.querySelector<HTMLButtonElement>('[data-testid="type-query"]')
          ?.click(),
      );
      act(() => {
        vi.advanceTimersByTime(300);
      });
      await flushEffects();

      expect(textByTestId("query")).toBe("");
      expect(
        mocks.listSubscribers.mock.calls.some(
          ([options]) => options.query === "blocked-query",
        ),
      ).toBe(false);

      mocks.requestDesktopRouteNavigation.mockResolvedValueOnce("cancelled");
      act(() =>
        container
          ?.querySelector<HTMLButtonElement>('[data-testid="next-page"]')
          ?.click(),
      );
      await flushEffects();
      expect(textByTestId("view-state")).toBe("|all|false|updated_at|desc|1|0");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves an id deep link outside the loaded page and blocks viewer onboarding writes", async () => {
    mocks.canWrite = false;
    mocks.canAdmin = false;
    mocks.consumeDeepLink.mockReturnValue({
      section: "subscribers",
      id: "subscriber-42",
    });
    mocks.desktopRoute = {
      section: "subscribers",
      overlay: { name: "create" },
    };

    renderProbe();
    await flushEffects();

    expect(mocks.getSubscriber).toHaveBeenCalledWith("subscriber-42", {
      signal: expect.any(AbortSignal),
    });
    expect(textByTestId("selected-detail")).toBe("deep-link@example.test");
    expect(textByTestId("can-mutate")).toBe("false");
    expect(textByTestId("create-open")).toBe("false");
    expect(mocks.toastError).toHaveBeenCalledWith(
      "A write role is required to start this subscriber task.",
    );
    expect(mocks.requestDesktopRouteNavigation).toHaveBeenCalledWith(
      { section: "subscribers", overlay: undefined },
      { replace: true, source: "navigation" },
    );
  });

  it("resolves an email deep link atomically without replacing the directory query", async () => {
    mocks.consumeDeepLink.mockReturnValue({
      section: "subscribers",
      id: "deep-link@example.test",
    });

    renderProbe();
    await flushEffects();

    expect(mocks.getSubscriber).toHaveBeenCalledWith("deep-link@example.test", {
      signal: expect.any(AbortSignal),
    });
    expect(textByTestId("selected-detail")).toBe("deep-link@example.test");
    expect(textByTestId("query")).toBe("");
    expect(mocks.listSubscribers).toHaveBeenCalledTimes(1);
    expect(mocks.requestDesktopRouteNavigation).toHaveBeenCalledWith(
      {
        section: "subscribers",
        overlay: {
          name: "subscriber-detail",
          resourceId: "deep-link@example.test",
        },
      },
      { replace: true, source: "deep-link" },
    );
  });

  it("does not misreport a transient deep-link failure as a missing subscriber", async () => {
    mocks.consumeDeepLink.mockReturnValue({
      section: "subscribers",
      id: "subscriber-transient",
    });
    mocks.getSubscriber.mockResolvedValue({
      error: {
        kind: "http",
        status: 503,
        message: "subscriber gateway unavailable",
      },
    });

    renderProbe();
    await flushEffects();

    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't open the subscriber. Check your connection and try again.",
    );
    expect(mocks.toastError).not.toHaveBeenCalledWith(
      "Subscriber not found — it may have been deleted.",
    );
    expect(textByTestId("route-open-error")).toContain(
      "temporarily unavailable",
    );

    mocks.getSubscriber.mockResolvedValueOnce({
      data: {
        id: "subscriber-transient",
        version: '"subscriber:subscriber-transient:v1"',
        email: "recovered@example.test",
        status: "enabled",
      },
    });
    act(() =>
      container
        ?.querySelector<HTMLButtonElement>('[data-testid="retry-detail"]')
        ?.click(),
    );
    await flushEffects();
    expect(mocks.getSubscriber).toHaveBeenCalledTimes(2);
    expect(textByTestId("selected-detail")).toBe("recovered@example.test");
    expect(textByTestId("route-open-error")).toBe("none");
  });

  it("opens atomically and closes a locally pushed detail with one Back plus origin focus restoration", async () => {
    renderProbe();
    await flushEffects();
    mocks.requestDesktopRouteNavigation.mockClear();
    const open = container?.querySelector<HTMLButtonElement>(
      '[data-testid="open-first"]',
    );
    open?.focus();
    act(() => open?.click());
    await flushEffects();
    expect(textByTestId("selected-detail")).toBe("alice@example.test");
    expect(mocks.requestDesktopRouteNavigation).toHaveBeenCalledWith(
      {
        section: "subscribers",
        overlay: {
          name: "subscriber-detail",
          resourceId: "subscriber-1",
        },
      },
      { source: "navigation" },
    );
    expect(mocks.desktopRoute.overlay?.resourceId).toBe("subscriber-1");

    const close = container?.querySelector<HTMLButtonElement>(
      '[data-testid="close-detail"]',
    );
    close?.focus();
    act(() => close?.click());
    await flushEffects();
    expect(mocks.requestDesktopRouteBackNavigation).toHaveBeenCalledTimes(1);
    expect(mocks.requestDesktopRouteBackNavigation).toHaveBeenCalledWith({
      section: "subscribers",
    });
    act(() => root?.render(<Probe />));
    await flushEffects();
    expect(textByTestId("selected-detail")).toBe("none");
    expect(mocks.getSubscriber).not.toHaveBeenCalled();
    await act(
      async () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    expect(document.activeElement).toBe(open);
  });

  it("falls back from a rejected local Back and leaves close retryable after a cancelled replacement", async () => {
    renderProbe();
    await flushEffects();
    act(() =>
      container
        ?.querySelector<HTMLButtonElement>('[data-testid="open-first"]')
        ?.click(),
    );
    await flushEffects();
    expect(textByTestId("selected-detail")).toBe("alice@example.test");

    mocks.requestDesktopRouteBackNavigation.mockClear();
    mocks.requestDesktopRouteNavigation.mockClear();
    mocks.requestDesktopRouteBackNavigation.mockResolvedValueOnce("failed");
    mocks.requestDesktopRouteNavigation.mockResolvedValueOnce("cancelled");

    act(() =>
      container
        ?.querySelector<HTMLButtonElement>('[data-testid="close-detail"]')
        ?.click(),
    );
    await flushEffects();

    expect(mocks.requestDesktopRouteBackNavigation).toHaveBeenCalledTimes(1);
    expect(mocks.requestDesktopRouteNavigation).toHaveBeenCalledWith(
      { section: "subscribers" },
      { replace: true, source: "navigation" },
    );
    expect(mocks.desktopRoute.overlay?.resourceId).toBe("subscriber-1");
    expect(textByTestId("selected-detail")).toBe("alice@example.test");

    act(() =>
      container
        ?.querySelector<HTMLButtonElement>('[data-testid="close-detail"]')
        ?.click(),
    );
    await flushEffects();

    expect(mocks.requestDesktopRouteBackNavigation).toHaveBeenCalledTimes(2);
    expect(mocks.desktopRoute).toEqual({ section: "subscribers" });
    act(() => root?.render(<Probe />));
    await flushEffects();
    expect(textByTestId("selected-detail")).toBe("none");
  });

  it("keeps a cancelled open unchanged and allows an immediate retry", async () => {
    renderProbe();
    await flushEffects();
    mocks.requestDesktopRouteNavigation.mockResolvedValueOnce("cancelled");

    act(() =>
      container
        ?.querySelector<HTMLButtonElement>('[data-testid="open-first"]')
        ?.click(),
    );
    await flushEffects();
    expect(textByTestId("selected-detail")).toBe("none");
    expect(mocks.desktopRoute).toEqual({ section: "subscribers" });

    act(() =>
      container
        ?.querySelector<HTMLButtonElement>('[data-testid="open-first"]')
        ?.click(),
    );
    await flushEffects();
    expect(textByTestId("selected-detail")).toBe("alice@example.test");
  });

  it("closes a direct detail deep link by replacement without an inert Back", async () => {
    mocks.desktopRoute = {
      section: "subscribers",
      overlay: {
        name: "subscriber-detail",
        resourceId: "subscriber-1",
      },
    };
    renderProbe();
    await flushEffects();
    mocks.requestDesktopRouteNavigation.mockClear();
    mocks.requestDesktopRouteNavigation.mockResolvedValueOnce("cancelled");

    act(() =>
      container
        ?.querySelector<HTMLButtonElement>('[data-testid="close-detail"]')
        ?.click(),
    );
    await flushEffects();

    expect(mocks.requestDesktopRouteBackNavigation).not.toHaveBeenCalled();
    expect(textByTestId("selected-detail")).toBe("alice@example.test");
    expect(mocks.desktopRoute.overlay?.resourceId).toBe("subscriber-1");

    act(() =>
      container
        ?.querySelector<HTMLButtonElement>('[data-testid="close-detail"]')
        ?.click(),
    );
    await flushEffects();
    expect(mocks.requestDesktopRouteNavigation).toHaveBeenCalledWith(
      { section: "subscribers" },
      { replace: true, source: "navigation" },
    );
    expect(mocks.requestDesktopRouteNavigation).toHaveBeenCalledTimes(2);
  });

  it("restores a routed detail from the loaded page without a duplicate lookup", async () => {
    mocks.desktopRoute = {
      section: "subscribers",
      overlay: {
        name: "subscriber-detail",
        resourceId: "subscriber-1",
      },
    };
    renderProbe();
    await flushEffects();

    expect(textByTestId("selected-detail")).toBe("alice@example.test");
    expect(mocks.getSubscriber).not.toHaveBeenCalled();
    expect(textByTestId("query")).toBe("");
  });

  it("aborts an unresolved deep-link lookup when the Subscribers route closes", async () => {
    const pending = deferred<{
      data: {
        id: string;
        email: string;
      };
    }>();
    mocks.consumeDeepLink.mockReturnValue({
      section: "subscribers",
      id: "subscriber-slow",
    });
    mocks.getSubscriber.mockReturnValue(pending.promise);

    renderProbe();
    await flushEffects();
    expect(mocks.getSubscriber).toHaveBeenCalledTimes(1);
    const signal = mocks.getSubscriber.mock.calls[0]?.[1]?.signal as
      | AbortSignal
      | undefined;
    expect(signal?.aborted).toBe(false);

    act(() => root?.unmount());
    root = null;
    expect(signal?.aborted).toBe(true);

    pending.resolve({
      data: { id: "subscriber-slow", email: "slow@example.test" },
    });
    await flushEffects();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("opens a routed subscriber import without consuming it early", async () => {
    mocks.desktopRoute = {
      section: "subscribers",
      overlay: { name: "import" },
    };
    renderProbe();
    await flushEffects();
    expect(textByTestId("import-open")).toBe("true");
    expect(mocks.requestDesktopRouteNavigation).not.toHaveBeenCalled();
    expect(mocks.replaceOverlay).not.toHaveBeenCalled();
  });

  it("retains only the same view's last-confirmed rows when a refresh fails", async () => {
    renderProbe();
    await flushEffects();

    expect(textByTestId("rows")).toBe("subscriber-1");
    expect(textByTestId("stale")).toBe("false");

    mocks.listSubscribers.mockResolvedValueOnce({
      error: {
        kind: "http",
        status: 503,
        message: "token=secret upstream unavailable",
      },
    });
    act(() => {
      (
        container?.querySelector('[data-testid="reload"]') as HTMLButtonElement
      ).click();
    });
    await flushEffects();

    expect(textByTestId("rows")).toBe("subscriber-1");
    expect(textByTestId("stale")).toBe("true");
    expect(textByTestId("refresh-error")).toBe(
      "token=*** upstream unavailable",
    );

    act(() => {
      (
        container?.querySelector('[data-testid="reload"]') as HTMLButtonElement
      ).click();
    });
    await flushEffects();

    expect(textByTestId("rows")).toBe("subscriber-1");
    expect(textByTestId("stale")).toBe("false");
    expect(textByTestId("refresh-error")).toBe("none");
  });

  it("does not let a stale live refresh overwrite an in-flight optimistic edit", async () => {
    renderProbe();
    await flushEffects();
    const staleRefresh = deferred<{
      data: {
        items: Array<Record<string, unknown>>;
        total: number;
        page: number;
        per_page: number;
      };
    }>();
    const mutation = deferred<{
      data: Record<string, unknown>;
    }>();
    mocks.listSubscribers
      .mockReturnValueOnce(staleRefresh.promise)
      .mockResolvedValueOnce({
        data: {
          items: [
            {
              id: "subscriber-1",
              version: '"subscriber:subscriber-1:v2"',
              email: "alice@example.test",
              status: "disabled",
            },
          ],
          total: 2,
          page: 1,
          per_page: 50,
        },
      });
    mocks.updateSubscriber.mockReturnValueOnce(mutation.promise);

    act(() =>
      container
        ?.querySelector<HTMLButtonElement>('[data-testid="reload"]')
        ?.click(),
    );
    act(() =>
      container
        ?.querySelector<HTMLButtonElement>('[data-testid="disable-first"]')
        ?.click(),
    );
    expect(textByTestId("first-status")).toBe("disabled");

    mutation.resolve({
      data: {
        id: "subscriber-1",
        version: '"subscriber:subscriber-1:v2"',
        email: "alice@example.test",
        status: "disabled",
      },
    });
    await flushEffects();
    staleRefresh.resolve({
      data: {
        items: [
          {
            id: "subscriber-1",
            version: '"subscriber:subscriber-1:v1"',
            email: "alice@example.test",
            status: "enabled",
          },
        ],
        total: 2,
        page: 1,
        per_page: 50,
      },
    });
    await flushEffects();

    expect(textByTestId("first-status")).toBe("disabled");
    expect(mocks.listSubscribers).toHaveBeenCalledTimes(3);
  });

  it("reapplies an unresolved offline journal patch after an authoritative refresh", async () => {
    mocks.outbox = {
      all: [
        {
          id: "queue-1",
          method: "PATCH",
          path: "/api/v1/subscribers/subscriber-1",
          body: { status: "disabled", tags: ["pending"] },
          idempotencyKey: "idem-1",
          queuedAt: "2026-07-19T00:00:00.000Z",
          attempts: 0,
          status: "pending",
          resource: "subscribers",
        },
      ],
      recent: [],
    };
    renderProbe();
    await flushEffects();

    expect(textByTestId("first-status")).toBe("disabled");
    expect(mocks.updateSubscriber).not.toHaveBeenCalled();
  });

  it("hides old-workspace rows before the replacement workspace request settles", async () => {
    renderProbe();
    await flushEffects();
    expect(textByTestId("first-email")).toBe("alice@example.test");
    expect(textByTestId("server-total")).toBe("2");
    expect(textByTestId("last-confirmed")).toBe("confirmed");

    const nextWorkspace = deferred<{
      data: {
        items: Array<Record<string, unknown>>;
        total: number;
        page: number;
        per_page: number;
      };
    }>();
    mocks.listSubscribers.mockReturnValueOnce(nextWorkspace.promise);
    mocks.tenant = "tenant-2";
    act(() => root?.render(<Probe />));

    expect(textByTestId("rows")).toBe("loading");
    expect(textByTestId("first-email")).toBe("none");
    expect(textByTestId("directory-loading")).toBe("true");
    expect(textByTestId("server-total")).toBe("none");
    expect(textByTestId("last-confirmed")).toBe("none");

    nextWorkspace.resolve({
      data: {
        items: [
          {
            id: "subscriber-tenant-2",
            version: '"subscriber:subscriber-tenant-2:v1"',
            email: "tenant-two@example.test",
            status: "enabled",
          },
        ],
        total: 1,
        page: 1,
        per_page: 50,
      },
    });
    await flushEffects();
    expect(textByTestId("first-email")).toBe("tenant-two@example.test");
  });

  it("fences a late optimistic mutation response to its originating workspace", async () => {
    renderProbe();
    await flushEffects();
    const oldWorkspaceMutation = deferred<{
      data: Record<string, unknown>;
    }>();
    mocks.updateSubscriber.mockReturnValueOnce(oldWorkspaceMutation.promise);

    act(() =>
      container
        ?.querySelector<HTMLButtonElement>('[data-testid="disable-first"]')
        ?.click(),
    );
    expect(textByTestId("first-status")).toBe("disabled");

    mocks.listSubscribers.mockResolvedValueOnce({
      data: {
        items: [
          {
            id: "subscriber-tenant-2",
            version: '"subscriber:subscriber-tenant-2:v1"',
            email: "tenant-two@example.test",
            status: "enabled",
          },
        ],
        total: 1,
        page: 1,
        per_page: 50,
      },
    });
    mocks.tenant = "tenant-2";
    act(() => root?.render(<Probe />));
    await flushEffects();
    expect(textByTestId("first-email")).toBe("tenant-two@example.test");
    expect(textByTestId("first-status")).toBe("enabled");

    oldWorkspaceMutation.resolve({
      data: {
        id: "subscriber-1",
        version: '"subscriber:subscriber-1:v2"',
        email: "alice@example.test",
        status: "disabled",
      },
    });
    await flushEffects();

    expect(textByTestId("first-email")).toBe("tenant-two@example.test");
    expect(textByTestId("first-status")).toBe("enabled");
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("resets every applied directory dimension, including sort direction", async () => {
    renderProbe();
    await flushEffects();

    act(() => {
      (
        container?.querySelector(
          '[data-testid="customize-view"]',
        ) as HTMLButtonElement
      ).click();
    });
    await flushEffects();
    expect(textByTestId("view-state")).toBe(
      "reader|unconfirmed|true|email|asc|1|0",
    );

    act(() => {
      (
        container?.querySelector(
          '[data-testid="reset-view"]',
        ) as HTMLButtonElement
      ).click();
    });
    await flushEffects();
    expect(textByTestId("view-state")).toBe("|all|false|updated_at|desc|1|0");
  });

  it("preserves a Back/Forward-restored query and page beyond the debounce window", async () => {
    vi.useFakeTimers();
    try {
      mocks.listSubscribers.mockResolvedValue({
        data: {
          items: [
            {
              id: "subscriber-restored",
              email: "restored@example.test",
              status: "enabled",
            },
          ],
          total: 500,
          page: 4,
          per_page: 50,
        },
      });
      renderProbe();
      await flushEffects();
      act(() =>
        container
          ?.querySelector<HTMLButtonElement>('[data-testid="type-query"]')
          ?.click(),
      );
      await flushEffects();

      mocks.desktopRoute = {
        section: "subscribers",
        query: "blocked-query",
        filters: [{ key: "page", value: "4" }],
      };
      act(() => root?.render(<Probe />));
      await flushEffects();
      act(() => {
        vi.advanceTimersByTime(350);
      });
      await flushEffects();

      expect(textByTestId("view-state")).toBe(
        "blocked-query|all|false|updated_at|desc|4|0",
      );
      expect(mocks.listSubscribers).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: "blocked-query", page: 4 }),
        { signal: expect.any(AbortSignal) },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores an authoritative saved Directory snapshot after route approval", async () => {
    const savedSegment = {
      id: "saved-1",
      tenant_id: "tenant-1",
      name: "Reviewed readers",
      description: "",
      predicate_json: {
        filters: { status: "unsubscribed", q: "reviewed" },
        snapshot: {
          version: 3,
          resource_scope: "subscriber_directory",
          workspace_scope: "current",
          applied_query: "reviewed",
          status: "unsubscribed",
          include_archived: true,
          sort: { column: "email", order: "asc" },
          columns: ["email", "status"],
          reset: { page: 1, selection: "clear" },
        },
      },
      is_pinned: false,
      visibility_scope: "personal",
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    };
    mocks.listSavedSegments.mockResolvedValue({
      data: { items: [savedSegment], total_items: 1, max_items: 200 },
    });
    mocks.patchSavedSegment.mockResolvedValue({ data: savedSegment });
    renderProbe();
    await flushEffects();

    act(() => {
      (
        container?.querySelector(
          '[data-testid="apply-first-saved"]',
        ) as HTMLButtonElement
      ).click();
    });
    await flushEffects();

    expect(mocks.requestDesktopRouteNavigation).toHaveBeenCalled();
    expect(textByTestId("view-state")).toBe(
      "reviewed|unsubscribed|true|email|asc|1|0",
    );
    expect(textByTestId("saved-columns")).toBe("email,status");
    expect(textByTestId("active-saved")).toBe("saved-1");
    expect(mocks.patchSavedSegment).toHaveBeenCalledWith("saved-1", {
      touch: true,
    });
  });

  it("does not commit columns, selection, recency, or active saved ID when saved-view navigation cancels", async () => {
    mocks.listSavedSegments.mockResolvedValue({
      data: {
        items: [
          {
            id: "saved-cancelled",
            tenant_id: "tenant-1",
            name: "Cancelled readers",
            description: "",
            predicate_json: {
              snapshot: {
                version: 3,
                resource_scope: "subscriber_directory",
                workspace_scope: "current",
                applied_query: "reviewed",
                status: "unsubscribed",
                include_archived: true,
                sort: { column: "email", order: "asc" },
                columns: ["email", "status"],
                reset: { page: 1, selection: "clear" },
              },
            },
            is_pinned: false,
            visibility_scope: "personal",
            created_at: "2026-07-01T00:00:00.000Z",
            updated_at: "2026-07-01T00:00:00.000Z",
          },
        ],
      },
    });
    renderProbe();
    await flushEffects();
    const columnsBefore = textByTestId("saved-columns");
    act(() =>
      container
        ?.querySelector<HTMLButtonElement>('[data-testid="select-first"]')
        ?.click(),
    );
    mocks.requestDesktopRouteNavigation.mockResolvedValueOnce("cancelled");

    act(() =>
      container
        ?.querySelector<HTMLButtonElement>('[data-testid="apply-first-saved"]')
        ?.click(),
    );
    await flushEffects();

    expect(textByTestId("view-state")).toBe("|all|false|updated_at|desc|1|1");
    expect(textByTestId("saved-columns")).toBe(columnsBefore);
    expect(textByTestId("active-saved")).toBe("none");
    expect(mocks.patchSavedSegment).not.toHaveBeenCalled();
  });

  it("rehydrates a URL-owned saved view and its exact columns without touching recency", async () => {
    const savedSegment = {
      id: "saved-route",
      tenant_id: "tenant-1",
      name: "Route-owned readers",
      description: "",
      predicate_json: {
        filters: { status: "unsubscribed", q: "reviewed" },
        snapshot: {
          version: 3,
          resource_scope: "subscriber_directory",
          workspace_scope: "current",
          applied_query: "reviewed",
          status: "unsubscribed",
          include_archived: true,
          sort: { column: "updated_at", order: "desc" },
          columns: ["email", "status"],
          reset: { page: 1, selection: "clear" },
        },
      },
      is_pinned: false,
      visibility_scope: "personal",
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    };
    mocks.desktopRoute = {
      section: "subscribers",
      query: "reviewed",
      filters: [
        { key: "status", value: "unsubscribed" },
        { key: "archived", value: "true" },
        { key: "saved-view", value: "saved-route" },
      ],
    };
    mocks.listSavedSegments.mockResolvedValue({
      data: { items: [savedSegment], total_items: 1, max_items: 200 },
    });
    renderProbe();
    await flushEffects();

    expect(textByTestId("active-saved")).toBe("saved-route");
    expect(textByTestId("saved-columns")).toBe("email,status");
    expect(textByTestId("query")).toBe("reviewed");
    expect(mocks.patchSavedSegment).not.toHaveBeenCalled();
  });

  it("rejects a damaged v3 snapshot instead of applying compatibility filters", async () => {
    mocks.listSavedSegments.mockResolvedValue({
      data: {
        items: [
          {
            id: "saved-damaged",
            tenant_id: "tenant-1",
            name: "Damaged view",
            description: "",
            predicate_json: {
              filters: { status: "unsubscribed", q: "must-not-apply" },
              snapshot: {
                version: 3,
                resource_scope: "subscriber_directory",
                workspace_scope: "current",
                applied_query: "incomplete",
                include_archived: true,
                sort: { column: "email", order: "asc" },
                columns: ["email"],
                reset: { page: 1, selection: "clear" },
              },
            },
            is_pinned: false,
            visibility_scope: "personal",
            created_at: "2026-07-01T00:00:00.000Z",
            updated_at: "2026-07-01T00:00:00.000Z",
          },
        ],
      },
    });
    renderProbe();
    await flushEffects();

    act(() => {
      (
        container?.querySelector(
          '[data-testid="apply-first-saved"]',
        ) as HTMLButtonElement
      ).click();
    });
    await flushEffects();

    expect(textByTestId("view-state")).toBe("|all|false|updated_at|desc|1|0");
    expect(mocks.patchSavedSegment).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining(
        "complete, supported subscriber-directory snapshot",
      ),
    );
  });

  it("captures the complete applied view, owns same-tick submit, and retains a failed draft for retry", async () => {
    const first = deferred<{
      error: { kind: "http"; status: number; code: string; message: string };
    }>();
    mocks.createSavedSegment
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ data: { id: "saved-2" } });
    renderProbe();
    await flushEffects();
    act(() => {
      (
        container?.querySelector(
          '[data-testid="customize-view"]',
        ) as HTMLButtonElement
      ).click();
    });
    await flushEffects();
    act(() => {
      (
        container?.querySelector(
          '[data-testid="prepare-workspace-save"]',
        ) as HTMLButtonElement
      ).click();
    });
    act(() => {
      (
        container?.querySelector(
          '[data-testid="submit-save-twice"]',
        ) as HTMLButtonElement
      ).click();
    });

    expect(mocks.createSavedSegment).toHaveBeenCalledTimes(1);
    expect(mocks.createSavedSegment).toHaveBeenCalledWith({
      name: "Reader view",
      visibility_scope: "workspace",
      predicate_json: {
        filters: { status: "unconfirmed", q: "reader" },
        snapshot: expect.objectContaining({
          version: 3,
          resource_scope: "subscriber_directory",
          workspace_scope: "current",
          applied_query: "reader",
          status: "unconfirmed",
          include_archived: true,
          sort: { column: "email", order: "asc" },
          columns: expect.arrayContaining(["email"]),
          reset: { page: 1, selection: "clear" },
        }),
      },
    });

    first.resolve({
      error: {
        kind: "http",
        status: 409,
        code: "name_taken",
        message: "raw duplicate detail",
      },
    });
    await flushEffects();
    expect(textByTestId("save-draft")).toContain(
      "true|Reader view|workspace|A saved segment with this name already exists.",
    );

    act(() => {
      (
        container?.querySelector(
          '[data-testid="rename-save"]',
        ) as HTMLButtonElement
      ).click();
    });
    act(() => {
      (
        container?.querySelector(
          '[data-testid="submit-save-twice"]',
        ) as HTMLButtonElement
      ).click();
    });
    await flushEffects();
    expect(mocks.createSavedSegment).toHaveBeenCalledTimes(2);
    expect(textByTestId("save-draft")).toBe("false||personal|none");
  });
});
