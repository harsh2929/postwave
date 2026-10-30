// @vitest-environment happy-dom

import axe from "axe-core";
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
  MCPExecution,
  MCPExecutionsResponse,
  MCPStats,
  MCPToolQuota,
  MCPTrendPoint,
} from "../../lib/api-client";
import { navigateDesktopRoute } from "../../lib/desktop-router";

const mocks = vi.hoisted(() => ({
  contextEpoch: "epoch-1" as string | null,
  effectiveRole: "admin" as "admin" | "editor" | "viewer",
  tenantId: "tenant-1",
  userId: "user-1",
  buildCsvUrl: vi.fn(),
  buildStreamUrl: vi.fn(),
  downloadUrlToFile: vi.fn(),
  getCatalog: vi.fn(),
  getStats: vi.fn(),
  getTrend: vi.fn(),
  invalidateStreamCredential: vi.fn(),
  listExecutions: vi.fn(),
  listQuotas: vi.fn(),
  setSection: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    buildMCPCsvUrl: mocks.buildCsvUrl,
    getMCPCatalog: mocks.getCatalog,
    getMCPStats: mocks.getStats,
    getMCPTrend: mocks.getTrend,
    listMCPExecutions: mocks.listExecutions,
    listMCPQuotas: mocks.listQuotas,
  },
  buildStreamUrl: mocks.buildStreamUrl,
  invalidateStreamCredential: mocks.invalidateStreamCredential,
}));

vi.mock("../../lib/store", () => ({
  setSection: mocks.setSection,
  useMe: () => ({
    user: mocks.userId,
    tenant: mocks.tenantId,
    role: mocks.effectiveRole,
    effectiveRole: mocks.effectiveRole,
  }),
}));

vi.mock("../../lib/context-epoch", () => ({
  onContextEpochObserved: () => () => undefined,
  readContextEpoch: () => mocks.contextEpoch,
}));

vi.mock("../../lib/file-transfer", () => ({
  downloadUrlToFile: mocks.downloadUrlToFile,
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

vi.mock("../../components/mcp/McpConnectionSetup", () => ({
  McpConnectionSetup: () => <div>MCP connection setup</div>,
}));

import { MCP } from "../../pages/MCP";

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let dateNow: ReturnType<typeof vi.spyOn> | null = null;

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  readonly url: string;
  readonly options: EventSourceInit | undefined;
  closed = false;

  constructor(url: string | URL, options?: EventSourceInit) {
    this.url = String(url);
    this.options = options;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener as (event: MessageEvent) => void);
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data }));
    }
  }
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
  }
  mocks.contextEpoch = "epoch-1";
  mocks.effectiveRole = "admin";
  mocks.tenantId = "tenant-1";
  mocks.userId = "user-1";
  dateNow = vi
    .spyOn(Date, "now")
    .mockReturnValue(Date.parse("2026-07-16T08:00:00.000Z"));
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  mocks.getCatalog.mockResolvedValue({ data: [] });
  mocks.getStats.mockResolvedValue({ data: stats() });
  mocks.getTrend.mockResolvedValue({
    data: {
      tenantId: "tenant-1",
      windowHours: 168,
      points: trendPoints(),
    },
  });
  mocks.listQuotas.mockResolvedValue({ data: quotaEnvelope([quota()]) });
  mocks.listExecutions.mockResolvedValue({
    data: executionPage([execution()], 100),
  });
  mocks.buildCsvUrl.mockReturnValue("/api/v1/mcp/executions.csv?window=7d");
  mocks.downloadUrlToFile.mockResolvedValue({
    ok: true,
    status: "download_started",
    transferId: "test-transfer",
    collision: false,
  });
  mocks.buildStreamUrl.mockImplementation((path: string) =>
    Promise.resolve(`https://api.example.test${path}?stream_token=short-lived`),
  );
  navigateDesktopRoute({ section: "mcp" }, { replace: true });
});

afterEach(() => {
  if (root) {
    const currentRoot = root;
    act(() => currentRoot.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  dateNow?.mockRestore();
  dateNow = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function execution(overrides: Partial<MCPExecution> = {}): MCPExecution {
  return {
    id: 100,
    tenantId: "tenant-1",
    apiKeyId: "key-1",
    apiKeyPrefix: "pw_live_12",
    method: "GET",
    path: "/api/v1/subscribers",
    toolName: "subscribers_list",
    statusCode: 200,
    latencyMs: 24,
    userAgent: "postwave-mcp-server/1.0",
    remoteIp: "203.0.113.10",
    costMicros: 10,
    calledAt: "2026-07-16T07:59:00.000Z",
    ...overrides,
  };
}

function executionPage(
  rows: MCPExecution[],
  nextBeforeId?: number,
): MCPExecutionsResponse {
  return {
    tenantId: "tenant-1",
    rows,
    detailPolicy: "minimized_v1",
    evidenceClass: "best_effort_observability",
    ...(nextBeforeId === undefined ? {} : { nextBeforeId }),
  };
}

function stats(overrides: Partial<MCPStats> = {}): MCPStats {
  return {
    tenantId: "tenant-1",
    windowHours: 168,
    totalCalls: 12,
    successfulCalls: 11,
    successRate: 11 / 12,
    averageLatencyMs: 30,
    p95LatencyMs: 80,
    lastCallAt: "2026-07-16T07:59:00.000Z",
    topTools: [{ toolName: "subscribers_list", calls: 8 }],
    topApiKeys: [{ apiKeyId: "key-1", apiKeyPrefix: "pw_live_12", calls: 12 }],
    statusBreakdown: [
      { class: 2, calls: 11 },
      { class: 5, calls: 1 },
    ],
    totalCostMicros: 120,
    ...overrides,
  };
}

function trendPoint(overrides: Partial<MCPTrendPoint> = {}): MCPTrendPoint {
  return {
    bucket: "2026-07-16T07:00:00.000Z",
    calls: 12,
    ...overrides,
  };
}

function trendPoints(): MCPTrendPoint[] {
  const start = Date.parse("2026-07-09T08:00:00.000Z");
  return Array.from({ length: 169 }, (_, index) =>
    trendPoint({
      bucket: new Date(start + index * 60 * 60 * 1_000).toISOString(),
      calls: index === 168 ? 12 : 0,
    }),
  );
}

function quota(overrides: Partial<MCPToolQuota> = {}): MCPToolQuota {
  return {
    toolName: "subscribers_list",
    dailyLimit: 100,
    estimatedCostMicros: 10,
    usedToday: 12,
    ...overrides,
  };
}

function quotaEnvelope(quotas: MCPToolQuota[]) {
  return {
    tenantId: "tenant-1",
    quotas,
    enforcementMode: "advisory_unverified" as const,
    authoritative: false as const,
    releaseHold: "mcp_quota_enforcement_release_held" as const,
  };
}

function render(node: ReactElement = <MCP />): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function setInput(placeholder: string, value: string): void {
  const input = document.querySelector<HTMLInputElement>(
    `input[placeholder="${placeholder}"]`,
  );
  if (!input) throw new Error(`Missing input: ${placeholder}`);
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
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
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

async function openHistory(): Promise<void> {
  render();
  act(() => button("History").click());
  await waitFor(() => {
    expect(document.body.textContent).toContain("subscribers_list");
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("MCP History", () => {
  it("mounts no telemetry owner until a complete admin identity is observed", async () => {
    mocks.tenantId = "";
    render();
    act(() => button("History").click());

    expect(document.body.textContent).toContain("Verifying your access");
    expect(
      document.querySelectorAll(".mcp-access-boundary .mcp-kicker"),
    ).toHaveLength(1);
    await act(async () => Promise.resolve());
    expect(mocks.getStats).not.toHaveBeenCalled();
    expect(mocks.getTrend).not.toHaveBeenCalled();
    expect(mocks.listExecutions).not.toHaveBeenCalled();
    expect(mocks.listQuotas).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("mounts no telemetry owner for a resolved non-admin role", async () => {
    mocks.effectiveRole = "viewer";
    render();
    act(() => button("History").click());

    expect(document.body.textContent).toContain("Admin access required");
    expect(document.body.textContent).toContain("No cached rows shown");
    expect(document.body.textContent).toContain("Export remains unavailable");
    expect(
      Array.from(document.querySelectorAll("button")).some((candidate) =>
        /export/iu.test(candidate.textContent ?? ""),
      ),
    ).toBe(false);
    await act(async () => Promise.resolve());
    expect(mocks.getStats).not.toHaveBeenCalled();
    expect(mocks.getTrend).not.toHaveBeenCalled();
    expect(mocks.listExecutions).not.toHaveBeenCalled();
    expect(mocks.listQuotas).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("loads the exact windowed telemetry fanout and renders executions", async () => {
    await openHistory();
    const since = "2026-07-09T08:00:00.000Z";

    expect(mocks.getStats).toHaveBeenCalledWith({
      window: "7d",
      include: "mcp",
    });
    expect(mocks.getTrend).toHaveBeenCalledWith({
      window: "7d",
      include: "mcp",
    });
    expect(mocks.listExecutions).toHaveBeenCalledWith({
      include: "mcp",
      tool: undefined,
      since,
      limit: 50,
    });
    expect(mocks.listQuotas).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("91.7%");
    expect(document.body.textContent).toContain("pw_live_12");
    expect(document.body.textContent).toContain(
      "MCP per-tool quota utilization today",
    );
    expect(document.body.textContent).toContain("MCP HTTP status distribution");
    expect(document.body.textContent).toContain("Moosewave MCP quotas API");
    expect(document.body.textContent).toContain("Moosewave MCP statistics API");
    expect(document.body.textContent).toContain(
      "configured estimate 10 micro-USD per call",
    );
    expect(document.body.textContent).not.toContain("(10 micro-USD)");
    expect(
      document.querySelectorAll("table.data-table").length,
    ).toBeGreaterThanOrEqual(2);
    expect(document.body.textContent).toContain(
      "Telemetry export is unavailable",
    );
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (candidate) => candidate.textContent?.trim() === "Export CSV",
      ),
    ).toBe(false);
  });

  it("keeps the status and quota visuals available when the execution list fails", async () => {
    mocks.listExecutions.mockResolvedValueOnce({
      error: {
        kind: "network",
        message: "raw db host api-key=pw_secret_internal",
      },
    });
    render();
    act(() => button("History").click());

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "The service could not be reached. Check the connection and retry.",
      );
    });
    expect(document.body.textContent).not.toContain("pw_secret_internal");
    expect(document.body.textContent).toContain("MCP HTTP status distribution");
    expect(document.body.textContent).toContain(
      "MCP per-tool quota utilization today",
    );
    expect(document.body.textContent).not.toContain(
      "Couldn't load HTTP status distribution",
    );
  });

  it("fails one malformed telemetry dataset without collapsing verified siblings", async () => {
    mocks.getStats.mockResolvedValueOnce({
      data: {
        ...stats(),
        topTools: [null],
      } as unknown as MCPStats,
    });
    render();
    act(() => button("History").click());

    await waitFor(() => {
      expect(document.body.textContent).toContain("MCP statistics unavailable");
    });
    expect(document.querySelector(".mcp-exec-table")).not.toBeNull();
    expect(document.body.textContent).toContain(
      "MCP per-tool quota utilization today",
    );
    expect(document.body.textContent).toContain("Calls per hour");
  });

  it("reports quota overage exactly while clamping only the supplemental bar", async () => {
    mocks.listQuotas.mockResolvedValueOnce({
      data: quotaEnvelope([quota({ usedToday: 120, dailyLimit: 100 })]),
    });
    await openHistory();

    expect(document.body.textContent).toContain(
      "120.0% · above or near threshold",
    );
    expect(
      document.querySelector<HTMLElement>(".mcp-status-bar-fill")?.style.width,
    ).toBe("100.0%");
    expect(document.querySelector("table.data-table")?.textContent).toContain(
      "120.0%",
    );
  });

  it("does not append an old cursor page after the tool filter changes", async () => {
    const oldPage = deferred<{ data: MCPExecutionsResponse }>();
    mocks.listExecutions
      .mockResolvedValueOnce({
        data: executionPage([execution()], 100),
      })
      .mockReturnValueOnce(oldPage.promise)
      .mockResolvedValueOnce({
        data: executionPage([
          execution({ id: 200, toolName: "campaigns_list" }),
        ]),
      });
    await openHistory();
    act(() => button("Load older").click());
    expect(mocks.listExecutions).toHaveBeenCalledTimes(2);

    setInput("e.g. subscribers_list", "campaigns_list");
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 275));
    });
    await waitFor(() => expect(mocks.listExecutions).toHaveBeenCalledTimes(3));
    expect(mocks.listExecutions).toHaveBeenLastCalledWith({
      include: "mcp",
      tool: "campaigns_list",
      since: "2026-07-09T08:00:00.000Z",
      limit: 50,
    });

    oldPage.resolve({
      data: executionPage([execution({ id: 50, toolName: "stale_tool" })]),
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("campaigns_list");
    expect(document.body.textContent).not.toContain("stale_tool");
  });

  it("stops pagination explicitly at the 500-row local inspection cap", async () => {
    const rows = Array.from({ length: 500 }, (_, index) =>
      execution({ id: 600 - index }),
    );
    mocks.listExecutions.mockResolvedValueOnce({
      data: executionPage(rows, rows.at(-1)!.id),
    });

    await openHistory();
    expect(document.querySelectorAll(".mcp-exec-table tbody tr")).toHaveLength(
      500,
    );
    expect(document.body.textContent).toContain(
      "Local inspection limit reached",
    );
    expect(document.body.textContent).toContain(
      "500 response-validated rows are retained",
    );
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (candidate) => candidate.textContent?.trim() === "Load older",
      ),
    ).toBe(false);
  });

  it("opens an authenticated live tail and prepends valid execution events", async () => {
    await openHistory();
    const checkbox = document.querySelector<HTMLInputElement>(
      ".mcp-auto-refresh input[type='checkbox']",
    );
    expect(checkbox).not.toBeNull();
    act(() => checkbox?.click());

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const stream = FakeEventSource.instances[0];
    expect(mocks.buildStreamUrl).toHaveBeenCalledWith(
      "/api/v1/mcp/executions/stream",
    );
    expect(stream?.url).toContain("stream_token=short-lived");
    expect(stream?.options).toEqual({ withCredentials: true });

    act(() => {
      stream?.emit(
        "execution",
        JSON.stringify(execution({ id: 101, toolName: "campaigns_send" })),
      );
    });
    expect(document.body.textContent).toContain("campaigns_send");

    act(() => root?.unmount());
    root = null;
    expect(stream?.closed).toBe(true);
  });

  it("structurally withholds the release-held CSV transport", async () => {
    await openHistory();
    expect(document.body.textContent).toContain("No export action is mounted");
    expect(document.body.textContent).toContain("formula-safe evidence file");
    expect(mocks.buildCsvUrl).not.toHaveBeenCalled();
    expect(mocks.downloadUrlToFile).not.toHaveBeenCalled();
    expect(
      Array.from(document.querySelectorAll("button")).some((candidate) =>
        candidate.textContent?.includes("Export"),
      ),
    ).toBe(false);
  });

  it("keeps exact identifiers and times in a semantic, axe-clean table", async () => {
    await openHistory();

    const table = document.querySelector<HTMLTableElement>(".mcp-exec-table")!;
    expect(table.textContent).toContain("100");
    expect(table.textContent).toContain("key-1");
    expect(table.textContent).toContain("Prefix pw_live_12");
    expect(table.textContent).toContain("2026");
    expect(table.querySelectorAll('tr[role="button"]')).toHaveLength(0);
    expect(table.querySelectorAll("tbody button")).toHaveLength(1);
    expect(document.querySelectorAll("[title]")).toHaveLength(0);

    const result = await axe.run(container!);
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });
});

describe("MCP History resilience and transfer controls", () => {
  it("single-flights same-tick full refreshes and retains verified data", async () => {
    await openHistory();
    const pending = deferred<{ data: MCPStats }>();
    mocks.getStats.mockReturnValueOnce(pending.promise);
    const refresh = button("Refresh");

    act(() => {
      refresh.click();
      refresh.click();
    });
    expect(mocks.getStats).toHaveBeenCalledTimes(2);
    expect(refresh.disabled).toBe(false);
    expect(refresh.getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain("key-1");

    pending.resolve({
      data: stats({
        totalCalls: 13,
        successfulCalls: 12,
        successRate: 12 / 13,
        statusBreakdown: [
          { class: 2, calls: 12 },
          { class: 5, calls: 1 },
        ],
      }),
    });
    await act(async () => {
      await pending.promise;
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("13");
    });
  });

  it("terminates a visually live stream on the first malformed payload", async () => {
    await openHistory();
    const checkbox = document.querySelector<HTMLInputElement>(
      ".mcp-auto-refresh input[type='checkbox']",
    )!;
    act(() => checkbox.click());
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const stream = FakeEventSource.instances[0]!;

    act(() => {
      stream.emit(
        "execution",
        JSON.stringify({
          id: 999,
          calledAt: "not-a-time",
          toolName: "raw_secret_should_not_render",
        }),
      );
    });

    expect(stream.closed).toBe(true);
    expect(document.body.textContent).toContain(
      "Live stream stopped because an event failed scope validation.",
    );
    expect(document.body.textContent).not.toContain(
      "raw_secret_should_not_render",
    );
    expect(document.querySelectorAll(".mcp-exec-table tbody tr")).toHaveLength(
      1,
    );
  });

  it("terminates live tail when a structurally valid row names another tenant", async () => {
    await openHistory();
    const checkbox = document.querySelector<HTMLInputElement>(
      ".mcp-auto-refresh input[type='checkbox']",
    )!;
    act(() => checkbox.click());
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const stream = FakeEventSource.instances[0]!;

    act(() => {
      stream.emit(
        "execution",
        JSON.stringify(execution({ id: 101, tenantId: "tenant-other" })),
      );
    });

    expect(stream.closed).toBe(true);
    expect(document.body.textContent).toContain(
      "Live stream stopped because an event failed scope validation.",
    );
    expect(document.querySelectorAll(".mcp-exec-table tbody tr")).toHaveLength(
      1,
    );
  });

  it("ignores valid nonmatching live rows without terminating a filtered stream", async () => {
    await openHistory();
    mocks.listExecutions.mockResolvedValueOnce({
      data: executionPage([execution({ id: 200, toolName: "campaigns_list" })]),
    });
    setInput("e.g. subscribers_list", "campaigns_list");
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 275));
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("campaigns_list");
    });
    const checkbox = document.querySelector<HTMLInputElement>(
      ".mcp-auto-refresh input[type='checkbox']",
    )!;
    act(() => checkbox.click());
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const stream = FakeEventSource.instances[0]!;

    act(() => {
      stream.emit(
        "execution",
        JSON.stringify(execution({ id: 201, toolName: "subscribers_list" })),
      );
    });
    expect(stream.closed).toBe(false);
    expect(document.querySelectorAll(".mcp-exec-table tbody tr")).toHaveLength(
      1,
    );

    act(() => {
      stream.emit(
        "execution",
        JSON.stringify(execution({ id: 202, toolName: "campaigns_list" })),
      );
    });
    expect(stream.closed).toBe(false);
    expect(document.querySelectorAll(".mcp-exec-table tbody tr")).toHaveLength(
      2,
    );
  });

  it("honors the server's typed terminal-unavailable stream signal immediately", async () => {
    await openHistory();
    const checkbox = document.querySelector<HTMLInputElement>(
      ".mcp-auto-refresh input[type='checkbox']",
    )!;
    act(() => checkbox.click());
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const stream = FakeEventSource.instances[0]!;

    act(() => {
      stream.emit(
        "unavailable",
        JSON.stringify({ code: "stream_read_unavailable", retryable: true }),
      );
    });

    expect(stream.closed).toBe(true);
    expect(document.body.textContent).toContain(
      "Live stream is unavailable. Use Refresh for current records.",
    );
    expect(button("Reconnect live stream")).not.toBeNull();
  });

  it("invalidates an expired stream credential before explicit reconnect", async () => {
    await openHistory();
    const checkbox = document.querySelector<HTMLInputElement>(
      ".mcp-auto-refresh input[type='checkbox']",
    )!;
    act(() => checkbox.click());
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const first = FakeEventSource.instances[0]!;

    act(() => {
      first.emit("closed", JSON.stringify({ reason: "credential_expired" }));
    });
    expect(first.closed).toBe(true);
    expect(mocks.invalidateStreamCredential).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(
      "Live stream is unavailable. Use Refresh for current records.",
    );

    act(() => button("Reconnect live stream").click());
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(mocks.buildStreamUrl).toHaveBeenCalledTimes(2);
  });

  it("retains and labels verified rows when a manual refresh fails safely", async () => {
    await openHistory();
    mocks.getStats.mockResolvedValueOnce({
      error: { kind: "network", message: "raw stats credential" },
    });
    mocks.getTrend.mockResolvedValueOnce({
      error: { kind: "network", message: "raw trend credential" },
    });
    mocks.listQuotas.mockResolvedValueOnce({
      error: { kind: "network", message: "raw quota credential" },
    });
    mocks.listExecutions.mockResolvedValueOnce({
      error: { kind: "network", message: "raw execution credential" },
    });

    act(() => button("Refresh").click());
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Some telemetry is from the last valid response",
      );
    });
    expect(document.body.textContent).toContain("key-1");
    expect(document.body.textContent).toContain(
      "Showing previously response-validated rows",
    );
    expect(document.body.textContent).toContain(
      "Showing the last response-validated MCP statistics",
    );
    expect(document.body.textContent).toContain("MCP HTTP status distribution");
    expect(document.body.textContent).not.toContain("raw stats credential");
    expect(document.body.textContent).not.toContain("raw execution credential");
  });

  it("clears retained execution data when refreshed access is denied", async () => {
    await openHistory();
    mocks.listExecutions.mockResolvedValueOnce({
      error: {
        status: 403,
        code: "forbidden",
        message: "raw forbidden detail",
      },
    });

    act(() => button("Refresh").click());
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Your current role does not have permission",
      );
    });
    expect(document.querySelector(".mcp-exec-table")).toBeNull();
    expect(document.body.textContent).not.toContain("raw forbidden detail");
  });

  it("atomically discards mixed-success telemetry and closes live tail after one denial", async () => {
    await openHistory();
    const checkbox = document.querySelector<HTMLInputElement>(
      ".mcp-auto-refresh input[type='checkbox']",
    )!;
    act(() => checkbox.click());
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const stream = FakeEventSource.instances[0]!;
    mocks.listExecutions.mockResolvedValueOnce({
      error: { status: 403, code: "forbidden", message: "raw denied" },
    });

    act(() => button("Refresh").click());
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Telemetry hidden and live access closed",
      );
    });

    expect(stream.closed).toBe(true);
    expect(document.querySelector(".mcp-exec-table")).toBeNull();
    expect(document.body.textContent).not.toContain("MCP per-tool quota");
    act(() => {
      stream.emit(
        "execution",
        JSON.stringify(execution({ id: 102, toolName: "must_not_render" })),
      );
    });
    expect(document.body.textContent).not.toContain("must_not_render");
  });

  it("treats an older-page denial as authority loss and tears down live evidence", async () => {
    await openHistory();
    const checkbox = document.querySelector<HTMLInputElement>(
      ".mcp-auto-refresh input[type='checkbox']",
    )!;
    act(() => checkbox.click());
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const stream = FakeEventSource.instances[0]!;
    mocks.listExecutions.mockResolvedValueOnce({
      error: { status: 401, code: "unauthorized", message: "raw session" },
    });

    act(() => button("Load older").click());
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Telemetry hidden and live access closed",
      );
    });

    expect(stream.closed).toBe(true);
    expect(document.querySelector(".mcp-exec-table")).toBeNull();
    expect(document.body.textContent).not.toContain("raw session");
    act(() => {
      stream.emit(
        "execution",
        JSON.stringify(execution({ id: 103, toolName: "post_denial_row" })),
      );
    });
    expect(document.body.textContent).not.toContain("post_denial_row");
  });
});
