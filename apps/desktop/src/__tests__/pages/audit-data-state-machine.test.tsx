// @vitest-environment happy-dom

import { act, type ReactElement, useEffect, useRef } from "react";
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
  api: mocks,
}));

import type { AuditRow } from "../../lib/api-client";
import type { DayRange } from "../../components/audit/AuditFilters";
import type { AuditFilterArgs } from "../../pages/audit/audit-page-types";
import {
  type AuditDataState,
  useAuditData,
} from "../../pages/audit/useAuditData";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function row(id: number, action: string): AuditRow {
  return {
    id,
    action,
    actorType: "human",
    actorLabel: "ada@example.com",
    at: "2026-08-12T10:00:00.000Z",
  };
}

function listResult(rows: AuditRow[]) {
  return { data: { rows } };
}

function statsResult(totalEvents: number) {
  return {
    data: {
      totalEvents,
      byActorType: [],
      topActions: [],
      daily: [],
    },
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: AuditDataState | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers();
  latest = null;
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getAuditCount.mockResolvedValue({
    data: { totalEstimate: 1, confidence: "exact" },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function Probe({
  filters,
  rollingDays,
}: {
  filters: AuditFilterArgs;
  rollingDays?: DayRange;
}): ReactElement {
  const requestId = useRef(0);
  useEffect(() => {
    requestId.current += 1;
  }, [filters]);
  latest = useAuditData({
    filterArgs: filters,
    filterReqIdRef: requestId,
    rollingDays,
  });
  return <output>{latest.phase}</output>;
}

function mount(filters: AuditFilterArgs, rollingDays?: DayRange): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Probe filters={filters} rollingDays={rollingDays} />));
}

async function startDebouncedLoad(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(221);
    await Promise.resolve();
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Audit data remote-resource state machine", () => {
  it("lands in a truthful hard-error state when initial requests throw", async () => {
    mocks.listAudit.mockRejectedValue(new Error("list transport failed"));
    mocks.getAuditStats.mockRejectedValue(new Error("stats transport failed"));

    mount({ actorType: "human" });
    await startDebouncedLoad();
    await settle();

    expect(latest?.phase).toBe("hard-error");
    expect(latest?.loading).toBe(false);
    expect(latest?.rows).toBeNull();
    expect(latest?.error).toBe("list transport failed");
    // A companion summary that never shared a committed list generation is
    // not presented as an additional fact about the failed evidence window.
    expect(latest?.statsError).toBeNull();
  });

  it("preserves the last good rows and marks them stale when refresh fails", async () => {
    mocks.listAudit.mockResolvedValueOnce(
      listResult([row(1, "campaign.sent")]),
    );
    mocks.getAuditStats.mockResolvedValueOnce(statsResult(1));
    mount({ actorType: "human" });
    await startDebouncedLoad();
    await settle();
    expect(latest?.phase).toBe("ready");

    const refreshList = deferred<ReturnType<typeof listResult>>();
    const refreshStats = deferred<ReturnType<typeof statsResult>>();
    mocks.listAudit.mockReturnValueOnce(refreshList.promise);
    mocks.getAuditStats.mockReturnValueOnce(refreshStats.promise);

    let refreshPromise!: Promise<void>;
    await act(async () => {
      refreshPromise = latest!.load();
      await Promise.resolve();
    });
    expect(latest?.phase).toBe("refreshing");
    expect(latest?.rows?.[0]?.action).toBe("campaign.sent");

    await act(async () => {
      refreshList.reject(new Error("refresh offline"));
      refreshStats.reject(new Error("stats offline"));
      await refreshPromise;
    });

    expect(latest?.phase).toBe("stale-error");
    expect(latest?.stale).toBe(true);
    expect(latest?.rows?.[0]?.action).toBe("campaign.sent");
    expect(latest?.error).toBe("refresh offline");
  });

  it("aborts query A and ignores its late response after query B starts", async () => {
    const alphaList = deferred<ReturnType<typeof listResult>>();
    const alphaStats = deferred<ReturnType<typeof statsResult>>();
    const betaList = deferred<ReturnType<typeof listResult>>();
    const betaStats = deferred<ReturnType<typeof statsResult>>();
    let alphaSignal: AbortSignal | undefined;
    mocks.listAudit
      .mockImplementationOnce(
        (_filters: AuditFilterArgs, options?: { signal?: AbortSignal }) => {
          alphaSignal = options?.signal;
          return alphaList.promise;
        },
      )
      .mockReturnValueOnce(betaList.promise);
    mocks.getAuditStats
      .mockReturnValueOnce(alphaStats.promise)
      .mockReturnValueOnce(betaStats.promise);

    mount({ actorLabel: "alpha@example.com" });
    await startDebouncedLoad();
    expect(alphaSignal?.aborted).toBe(false);

    act(() =>
      root?.render(<Probe filters={{ actorLabel: "beta@example.com" }} />),
    );
    expect(alphaSignal?.aborted).toBe(true);
    await startDebouncedLoad();

    await act(async () => {
      betaList.resolve(listResult([row(2, "beta.changed")]));
      betaStats.resolve(statsResult(1));
      await Promise.resolve();
    });
    await settle();
    expect(latest?.rows?.[0]?.action).toBe("beta.changed");

    await act(async () => {
      alphaList.resolve(listResult([row(1, "alpha.changed")]));
      alphaStats.resolve(statsResult(1));
      await Promise.resolve();
    });
    await settle();
    expect(latest?.rows?.[0]?.action).toBe("beta.changed");
  });

  it("hides query A's rows and freshness synchronously while query B is debounced", async () => {
    mocks.listAudit.mockResolvedValueOnce(listResult([row(1, "alpha.ready")]));
    mocks.getAuditStats.mockResolvedValueOnce(statsResult(1));
    mount({ actorLabel: "alpha@example.com" });
    await startDebouncedLoad();
    await settle();

    expect(latest?.rows?.[0]?.action).toBe("alpha.ready");
    expect(latest?.lastRefreshedAt).not.toBeNull();

    const betaList = deferred<ReturnType<typeof listResult>>();
    const betaStats = deferred<ReturnType<typeof statsResult>>();
    mocks.listAudit.mockReturnValueOnce(betaList.promise);
    mocks.getAuditStats.mockReturnValueOnce(betaStats.promise);

    act(() =>
      root?.render(
        <Probe filters={{ actorLabel: "beta@example.com" }} />,
      ),
    );

    expect(latest?.phase).toBe("initial-loading");
    expect(latest?.rows).toBeNull();
    expect(latest?.stats).toBeNull();
    expect(latest?.totalCount).toBeNull();
    expect(latest?.lastRefreshedAt).toBeNull();
    expect(latest?.refreshAgeLabel).toBe("not yet");
  });

  it("recomputes a rolling UTC-day window after midnight", async () => {
    vi.setSystemTime(new Date("2026-08-13T23:59:58.000Z"));
    mocks.listAudit.mockResolvedValue(listResult([row(5, "window.ready")]));
    mocks.getAuditStats.mockResolvedValue(statsResult(1));

    mount({}, 7);
    await startDebouncedLoad();
    await settle();

    expect(mocks.listAudit).toHaveBeenNthCalledWith(
      1,
      { since: "2026-08-06T00:00:00.000Z" },
      { signal: expect.any(AbortSignal) },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(221);
    });
    await settle();

    expect(mocks.listAudit).toHaveBeenNthCalledWith(
      2,
      { since: "2026-08-07T00:00:00.000Z" },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("keeps usable list evidence when optional statistics fail", async () => {
    mocks.listAudit.mockResolvedValue(listResult([row(3, "list.updated")]));
    mocks.getAuditStats.mockResolvedValue({
      error: { message: "statistics unavailable" },
    });

    mount({ resourceType: "list" });
    await startDebouncedLoad();
    await settle();

    expect(latest?.phase).toBe("ready");
    expect(latest?.rows).toHaveLength(1);
    expect(latest?.stats).toBeNull();
    expect(latest?.statsError).toBe("statistics unavailable");
  });

  it("commits authoritative rows without waiting for optional statistics", async () => {
    const hangingStats = deferred<ReturnType<typeof statsResult>>();
    mocks.listAudit.mockResolvedValue(listResult([row(4, "list.ready")]));
    mocks.getAuditStats.mockReturnValue(hangingStats.promise);

    mount({ resourceType: "list" });
    await startDebouncedLoad();
    await settle();

    expect(latest?.phase).toBe("ready");
    expect(latest?.rows?.[0]?.action).toBe("list.ready");
    expect(latest?.loadingStats).toBe(true);
  });

  it("refreshes list and exact count in the same manual snapshot", async () => {
    mocks.listAudit
      .mockResolvedValueOnce(listResult([row(1, "first")]))
      .mockResolvedValueOnce(listResult([row(1, "first"), row(2, "second")]));
    mocks.getAuditStats.mockResolvedValue(statsResult(2));
    mocks.getAuditCount
      .mockResolvedValueOnce({
        data: { totalEstimate: 1, confidence: "exact" },
      })
      .mockResolvedValueOnce({
        data: { totalEstimate: 2, confidence: "exact" },
      });

    mount({ actorType: "human" });
    await startDebouncedLoad();
    await settle();
    expect(latest?.totalCount).toBe(1);

    await act(async () => {
      await latest!.load();
    });
    await settle();

    expect(latest?.rows).toHaveLength(2);
    expect(latest?.totalCount).toBe(2);
    expect(mocks.getAuditCount).toHaveBeenCalledTimes(2);
  });

  it("never appends an older cursor page after a full snapshot refresh", async () => {
    const page = deferred<ReturnType<typeof listResult>>();
    mocks.listAudit
      .mockResolvedValueOnce({
        data: { rows: [row(1, "initial")], nextCursor: "cursor-2" },
      })
      .mockReturnValueOnce(page.promise)
      .mockResolvedValueOnce(listResult([row(3, "refreshed")]));
    mocks.getAuditStats.mockResolvedValue(statsResult(1));

    mount({ actorType: "human" });
    await startDebouncedLoad();
    await settle();

    let pagePromise!: Promise<void>;
    await act(async () => {
      pagePromise = latest!.onLoadMore();
      await Promise.resolve();
    });
    expect(latest?.loadingMore).toBe(true);

    await act(async () => {
      await latest!.load();
    });
    expect(latest?.rows?.map((entry) => entry.action)).toEqual(["refreshed"]);
    expect(latest?.loadingMore).toBe(false);

    await act(async () => {
      page.resolve(listResult([row(2, "old-page")]));
      await pagePromise;
    });

    expect(latest?.rows?.map((entry) => entry.action)).toEqual(["refreshed"]);
    expect(latest?.loadingMore).toBe(false);
  });
});
