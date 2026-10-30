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
  listAudit: vi.fn(),
  getAuditStats: vi.fn(),
  getAuditCount: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    listAudit: mocks.listAudit,
    getAuditStats: mocks.getAuditStats,
    getAuditCount: mocks.getAuditCount,
  },
}));

vi.mock("../../lib/auditScopes", () => ({
  useAuditScopes: () => ({
    loading: false,
    scopes: new Set(["audit:read", "audit:read_pii"]),
    isAdmin: false,
    error: null,
    hasScope: (scope: string) =>
      scope === "audit:read" || scope === "audit:read_pii",
    refresh: vi.fn(),
  }),
}));

vi.mock("../../lib/store", () => ({
  useMe: () => ({ user: "user-1", tenant: "tenant-1" }),
}));

import { desktopRouteIdentityScope } from "../../lib/desktop-router";
import {
  clearAuditFilterSessionState,
  writePersistedAuditFilters,
} from "../../pages/audit/audit-page-utils";
import { useAuditPageController } from "../../pages/audit/useAuditPageController";

const AUDIT_STORAGE_SCOPE = desktopRouteIdentityScope("user-1", "tenant-1")!;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));
  for (const mock of Object.values(mocks)) mock.mockReset();
  clearAuditFilterSessionState();
  localStorage.clear();
  writePersistedAuditFilters(
    {
      actorType: "human",
      actorLabel: "alice",
      actionQuery: "campaign.delete",
      resourceType: "campaign",
      resourceId: "campaign-42",
      days: 0,
      category: "all",
    },
    AUDIT_STORAGE_SCOPE,
  );
  mocks.listAudit
    .mockResolvedValueOnce({
      data: {
        rows: [
          {
            id: "one",
            action: "campaign.delete",
            actorType: "human",
            at: "2026-07-16T10:00:00.000Z",
          },
        ],
        nextCursor: "cursor-2",
      },
    })
    .mockResolvedValueOnce({
      data: {
        rows: [
          {
            id: "two",
            action: "campaign.delete",
            actorType: "human",
            at: "2026-07-15T10:00:00.000Z",
          },
        ],
      },
    });
  mocks.getAuditStats.mockResolvedValue({
    data: { totalEvents: 2, byActorType: [], topActions: [], daily: [] },
  });
  mocks.getAuditCount.mockResolvedValue({
    data: { totalEstimate: 2, confidence: "exact" },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  clearAuditFilterSessionState();
  localStorage.clear();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function Probe(): ReactElement {
  const controller = useAuditPageController();
  return (
    <div>
      <h2
        ref={controller.filterFocusRef}
        tabIndex={-1}
        data-testid="filter-focus-target"
      >
        Refine evidence
      </h2>
      <span data-testid="rows">
        {controller.data.rows?.map((row) => row.id).join(",") ?? "loading"}
      </span>
      <span data-testid="total">{controller.data.totalCount ?? "none"}</span>
      <span data-testid="selected">{controller.selected?.id ?? "none"}</span>
      <span data-testid="selected-action">
        {controller.selected?.action ?? "none"}
      </span>
      <button
        type="button"
        data-testid="select-first"
        onClick={(event) =>
          controller.setSelected(
            controller.data.rows?.[0] ?? null,
            event.currentTarget,
          )
        }
      >
        Select first
      </button>
      {controller.selected?.actorLabel ? (
        <button
          type="button"
          data-testid="drawer-filter-actor"
          onClick={() => {
            controller.filterToActor(controller.selected!.actorLabel!);
            controller.setSelected(null);
          }}
        >
          Filter to actor
        </button>
      ) : null}
      {controller.data.rows?.[0]?.actorLabel ? (
        <button
          type="button"
          data-testid="row-filter-actor"
          onClick={() =>
            controller.filterToActor(controller.data.rows![0]!.actorLabel!)
          }
        >
          Filter row actor
        </button>
      ) : null}
      <button
        type="button"
        data-testid="refresh"
        onClick={() => void controller.data.load()}
      >
        Refresh
      </button>
      <button
        type="button"
        data-testid="load-more"
        onClick={() => void controller.data.onLoadMore()}
      >
        More
      </button>
    </div>
  );
}

describe("audit page controller interaction", () => {
  it("keeps current-session private filters across paging", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<Probe />));
    await act(async () => vi.advanceTimersByTimeAsync(220));

    const expectedFilters = {
      actorType: "human",
      actorLabel: "alice",
      action: "campaign.delete",
      resourceType: "campaign",
      resourceId: "campaign-42",
      since: undefined,
    };
    expect(mocks.listAudit).toHaveBeenNthCalledWith(1, expectedFilters, {
      signal: expect.any(AbortSignal),
    });
    expect(mocks.getAuditStats).toHaveBeenCalledWith(expectedFilters, {
      signal: expect.any(AbortSignal),
    });
    expect(mocks.getAuditCount).toHaveBeenCalledWith(expectedFilters, {
      signal: expect.any(AbortSignal),
    });
    expect(container.querySelector('[data-testid="rows"]')?.textContent).toBe(
      "one",
    );
    expect(container.querySelector('[data-testid="total"]')?.textContent).toBe(
      "2",
    );

    await act(async () => {
      container
        ?.querySelector<HTMLButtonElement>('[data-testid="load-more"]')
        ?.click();
    });
    expect(mocks.listAudit).toHaveBeenNthCalledWith(
      2,
      {
        ...expectedFilters,
        cursor: "cursor-2",
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(container.querySelector('[data-testid="rows"]')?.textContent).toBe(
      "one,two",
    );
  });

  it("closes a detail snapshot when an authoritative refresh removes its event", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<Probe />));
    await act(async () => vi.advanceTimersByTimeAsync(220));

    act(() => {
      container
        ?.querySelector<HTMLButtonElement>('[data-testid="select-first"]')
        ?.click();
    });
    expect(
      container.querySelector('[data-testid="selected"]')?.textContent,
    ).toBe("one");

    await act(async () => {
      container
        ?.querySelector<HTMLButtonElement>('[data-testid="refresh"]')
        ?.click();
    });

    expect(container.querySelector('[data-testid="rows"]')?.textContent).toBe(
      "two",
    );
    expect(
      container.querySelector('[data-testid="selected"]')?.textContent,
    ).toBe("none");
  });

  it("updates an open detail from the newest authoritative row object", async () => {
    mocks.listAudit
      .mockReset()
      .mockResolvedValueOnce({
        data: {
          rows: [
            {
              id: "one",
              action: "campaign.delete",
              actorType: "human",
              at: "2026-07-16T10:00:00.000Z",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          rows: [
            {
              id: "one",
              action: "campaign.delete.corrected",
              actorType: "human",
              at: "2026-07-16T10:00:00.000Z",
            },
          ],
        },
      });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<Probe />));
    await act(async () => vi.advanceTimersByTimeAsync(220));
    act(() => {
      container
        ?.querySelector<HTMLButtonElement>('[data-testid="select-first"]')
        ?.click();
    });

    await act(async () => {
      container
        ?.querySelector<HTMLButtonElement>('[data-testid="refresh"]')
        ?.click();
    });

    expect(
      container.querySelector('[data-testid="selected-action"]')?.textContent,
    ).toBe("campaign.delete.corrected");
  });

  it("moves focus to the stable filter heading when a drawer pivot removes its opener", async () => {
    mocks.listAudit.mockReset().mockResolvedValue({
      data: {
        rows: [
          {
            id: "focus-row",
            action: "campaign.delete",
            actorType: "human",
            actorLabel: "alice",
            at: "2026-07-16T10:00:00.000Z",
          },
        ],
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<Probe />));
    await act(async () => vi.advanceTimersByTimeAsync(220));

    const opener = container.querySelector<HTMLButtonElement>(
      '[data-testid="select-first"]',
    )!;
    act(() => {
      opener.focus();
      opener.click();
    });
    const pivot = container.querySelector<HTMLButtonElement>(
      '[data-testid="drawer-filter-actor"]',
    )!;
    act(() => {
      pivot.focus();
      pivot.click();
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));

    expect(
      container.querySelector('[data-testid="selected"]')?.textContent,
    ).toBe("none");
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="filter-focus-target"]'),
    );
  });

  it("moves focus to the stable filter heading when an inline row pivot removes itself", async () => {
    mocks.listAudit
      .mockReset()
      .mockResolvedValueOnce({
        data: {
          rows: [
            {
              id: "focus-row",
              action: "campaign.delete",
              actorType: "human",
              actorLabel: "alice",
              at: "2026-07-16T10:00:00.000Z",
            },
          ],
        },
      })
      .mockResolvedValueOnce({ data: { rows: [] } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<Probe />));
    await act(async () => vi.advanceTimersByTimeAsync(220));

    const pivot = container.querySelector<HTMLButtonElement>(
      '[data-testid="row-filter-actor"]',
    )!;
    act(() => {
      pivot.focus();
      pivot.click();
    });
    await act(async () => vi.advanceTimersByTimeAsync(220));

    expect(
      container.querySelector('[data-testid="row-filter-actor"]'),
    ).toBeNull();
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="filter-focus-target"]'),
    );
  });
});
