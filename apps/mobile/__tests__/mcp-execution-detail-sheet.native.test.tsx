import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

const mockCopy = jest.fn(async (_value: string) => true);

jest.mock("@/lib/clipboard", () => ({
  copyToClipboard: (value: string) => mockCopy(value),
}));
jest.mock("@/hooks/useMcpActivity", () => require("./mocks/queryHooks.cjs"));
jest.mock("@/hooks/useMcpQuotas", () => require("./mocks/queryHooks.cjs"));
jest.mock("@/hooks/useMcpCatalog", () => require("./mocks/queryHooks.cjs"));
jest.mock("@/hooks/useMcpExecutionDetail", () =>
  require("./mocks/queryHooks.cjs"),
);

// eslint-disable-next-line import/first
import { McpActivityScreen } from "../src/components/mcp/McpActivityScreen";
// eslint-disable-next-line import/first
import { McpExecutionDetailSheet } from "../src/components/mcp/McpExecutionDetailSheet";
// eslint-disable-next-line import/first
import { ToastProvider } from "../src/components/Toast";
// eslint-disable-next-line import/first
import {
  normalizeMcpExecutions,
  normalizeMcpStats,
  normalizeMcpTrend,
} from "../src/lib/mcpActivity";
// eslint-disable-next-line import/first
import { normalizeMcpExecutionDetail } from "../src/lib/mcpExecutionDetail";

const queryHooks = require("./mocks/queryHooks.cjs");
const authStore = require("./mocks/authStore.cjs");

/**
 * P3 — execution-log detail sheet. Every assertion is written from the
 * leaking side, because the sheet renders identifiers as exact tokens and
 * offers one of them to the clipboard:
 *
 *   MASK    — a path with an e-mail address in it is replaced, and the
 *             address appears NOWHERE in the tree; a tool name outside its
 *             grammar reads "suppressed"; the remote IP is stated as removed.
 *   SHAPE   — query and body render as key COUNTS; the copy action carries
 *             the constant summary and never a key name.
 *   ASSERT  — dry-run is a caller assertion and the sheet says so; replay is
 *             release-held in the desktop's words.
 *   RE-READ — the row's own detail can be loading / offline / not retained
 *             without blanking what the log already knew.
 */

const TENANT = "11111111-1111-4111-8111-111111111111";

function executionWire(over: Record<string, unknown> = {}) {
  return {
    id: 9,
    apiKeyPrefix: "pw_live_ab12",
    method: "POST",
    path: "/api/v1/subscribers/*",
    toolName: "subscribers_create",
    statusCode: 500,
    latencyMs: 3100,
    userAgent: "postwave-mcp-server/1.4.0",
    errorCode: "internal_error",
    dryRun: false,
    costMicros: 1_250_000,
    calledAt: "2026-07-25T03:00:00Z",
    ...over,
  };
}

function detailWire(rowOver: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    rows: [
      {
        ...executionWire(),
        apiKeyId: "key-1",
        queryString: "key_count=1",
        requestBody: { _summary: true, type: "object", key_count: 3 },
        dryRunAsserted: false,
        ...rowOver,
      },
    ],
    detailPolicy: "minimized_v1",
    evidenceClass: "best_effort_observability",
  };
}

function queryResult(over: Record<string, unknown>) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    refetch: async () => ({ data: undefined }),
    ...over,
  };
}

function loadDetail(wire: Record<string, unknown> | null, over: Record<string, unknown> = {}) {
  queryHooks.__setHookResultForTests(
    "useMcpExecutionDetail",
    queryResult({
      data: wire ? (normalizeMcpExecutionDetail(wire, 9, TENANT).detail ?? undefined) : undefined,
      ...over,
    }),
  );
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ToastProvider>{children}</ToastProvider>
    </SafeAreaProvider>
  );
}

async function renderSheet(
  execution: Record<string, unknown> | null,
  gate = { enabled: true },
  onClose = jest.fn(),
) {
  const call = execution ? normalizeMcpExecutions({ rows: [execution] })[0] ?? null : null;
  return render(
    <McpExecutionDetailSheet call={call} allowed gate={gate} onClose={onClose} />,
    { wrapper },
  );
}

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
  authStore.__resetAuthStateForTests();
  mockCopy.mockClear();
});

describe("masking", () => {
  it("suppresses a path carrying an address and never renders the address", async () => {
    loadDetail(detailWire());
    const result = await renderSheet(
      executionWire({ path: "/api/v1/subscribers/person@example.test" }),
    );
    expect(result.getByLabelText("Path: /[SENSITIVE_PATH_SUPPRESSED]")).toBeTruthy();
    expect(result.queryByText(/example\.test/)).toBeNull();
    expect(result.queryByLabelText(/example\.test/)).toBeNull();
  });

  it("names a suppressed tool identifier and an absent one differently", async () => {
    loadDetail(detailWire());
    const suppressed = await renderSheet(executionWire({ toolName: "pw_live_abcdef123456" }));
    expect(suppressed.getByText("Tool identifier suppressed")).toBeTruthy();
    expect(suppressed.getByLabelText("Tool identifier: Not recorded or suppressed")).toBeTruthy();
    expect(suppressed.queryByText(/pw_live_abcdef/)).toBeNull();
    // unmount() is async in this RNTL; left un-awaited it empties every render
    // that follows in the file, which is exactly the order-dependent failure
    // a per-test cleanup is supposed to prevent.
    await suppressed.unmount();
    const absent = await renderSheet(executionWire({ toolName: "" }));
    expect(absent.getByText("No tool identifier recorded")).toBeTruthy();
  });

  it("states the remote IP as removed and reduces the agent to its product token", async () => {
    loadDetail(detailWire());
    const result = await renderSheet(executionWire({ userAgent: "curl/8.0 (person@example.test)" }));
    expect(result.getByLabelText("Remote IP: Removed before UI retention")).toBeTruthy();
    expect(result.getByLabelText("User agent: Suppressed")).toBeTruthy();
    expect(result.queryByText(/curl/)).toBeNull();
    expect(result.getByText(/Sensitive request values stay hidden/)).toBeTruthy();
  });

  it("keeps a well-formed row's identifiers and figures", async () => {
    loadDetail(detailWire());
    const result = await renderSheet(executionWire());
    expect(result.getByText("Execution 9")).toBeTruthy();
    // The identifier appears twice on purpose: as the title and as the fact.
    expect(result.getAllByText("subscribers_create")).toHaveLength(2);
    expect(result.getByLabelText("Tool identifier: subscribers_create")).toBeTruthy();
    expect(result.getByLabelText("Method: POST")).toBeTruthy();
    expect(result.getByLabelText("Path: /api/v1/subscribers/*")).toBeTruthy();
    expect(result.getByLabelText("Status: HTTP 500 · server error")).toBeTruthy();
    expect(result.getByLabelText("Latency: 3,100 ms")).toBeTruthy();
    expect(result.getByLabelText("API key prefix: pw_live_ab12")).toBeTruthy();
    expect(result.getByLabelText("User agent: postwave-mcp-server/1.4.0")).toBeTruthy();
    expect(result.getByLabelText("Error code: internal_error")).toBeTruthy();
    expect(result.getByLabelText("Recorded cost estimate: $1.25")).toBeTruthy();
    expect(result.getByLabelText("API key ID: key-1")).toBeTruthy();
    expect(result.getByText("No dry-run header recorded")).toBeTruthy();
  });
});

describe("request metadata", () => {
  it("renders query and body as key counts and copies only the constant summary", async () => {
    loadDetail(detailWire());
    const result = await renderSheet(executionWire());
    expect(result.getByLabelText("Query metadata: key_count=1")).toBeTruthy();
    const block = result.getByLabelText("Minimized request body metadata");
    const json = JSON.parse(block.props.children);
    expect(json).toEqual({ _summary: true, type: "object", key_count: 3, _truncated: false });
    expect(result.getByText(/At least 4 request metadata items were omitted/)).toBeTruthy();
    await act(async () => {
      await fireEvent.press(result.getByLabelText("Copy minimized request body metadata"));
      await Promise.resolve();
    });
    expect(mockCopy).toHaveBeenCalledTimes(1);
    const copied = mockCopy.mock.calls[0]?.[0] ?? "";
    expect(JSON.parse(copied)).toEqual(json);
    expect(copied).not.toContain("email");
    expect(await result.findByText("Minimized request metadata copied")).toBeTruthy();
  });

  it("offers no copy when no body was retained", async () => {
    loadDetail(detailWire({ requestBody: undefined, queryString: undefined }));
    const result = await renderSheet(executionWire());
    expect(result.getByText("No request body metadata was retained for this call.")).toBeTruthy();
    expect(result.queryByLabelText("Copy minimized request body metadata")).toBeNull();
    expect(result.getByLabelText("Query metadata: Not retained")).toBeTruthy();
  });

  it("says the row is no longer retained when the cursor answers a different row", async () => {
    loadDetail({ ...detailWire(), rows: [{ ...detailWire().rows[0], id: 8 }] });
    const result = await renderSheet(executionWire());
    expect(result.getAllByText("This row is no longer retained on the server.").length).toBeGreaterThan(0);
    expect(result.queryByLabelText("Copy minimized request body metadata")).toBeNull();
    // What the log already knew is still on screen.
    expect(result.getByLabelText("Path: /api/v1/subscribers/*")).toBeTruthy();
  });

  it("says the metadata needs a connection while offline, without blanking the row", async () => {
    loadDetail(null);
    const result = await renderSheet(executionWire(), { enabled: false });
    expect(result.getByText("Request metadata needs a connection.")).toBeTruthy();
    expect(result.getByLabelText("Query metadata: Needs a connection")).toBeTruthy();
    expect(result.getByLabelText("Path: /api/v1/subscribers/*")).toBeTruthy();
  });

  it("says it is loading rather than 'not retained' before the re-read answers", async () => {
    loadDetail(null, { isLoading: true, isPending: true });
    const result = await renderSheet(executionWire());
    expect(result.getByText("Loading request metadata…")).toBeTruthy();
    expect(result.getByLabelText("Query metadata: Loading…")).toBeTruthy();
  });
});

describe("assertions, not proofs", () => {
  it("calls a dry-run header an assertion and keeps replay release-held", async () => {
    loadDetail(detailWire({ dryRun: true, dryRunAsserted: true }));
    const result = await renderSheet(executionWire({ dryRun: true }));
    expect(result.getByText("Dry-run header asserted")).toBeTruthy();
    expect(result.getByText(/Executable replay is release-held/)).toBeTruthy();
    expect(
      result.getByText(/does not prove that the target endpoint prevented mutations, sends, or other side effects\./),
    ).toBeTruthy();
    expect(result.queryByText(/Replay/)).toBeNull();
    expect(
      result.getByText("Detail policy minimized_v1 · evidence class best_effort_observability"),
    ).toBeTruthy();
  });

  it("renders nothing while no row is selected", async () => {
    loadDetail(null);
    const result = await renderSheet(null);
    expect(result.queryByText("Close")).toBeNull();
    expect(result.queryByText(/Sensitive request values/)).toBeNull();
  });
});

describe("opened from the log row", () => {
  it("a tap on a row opens its sheet, and Close dismisses it", async () => {
    authStore.__setAuthStateForTests({ session: { effectiveRole: "admin" } });
    queryHooks.__setHookResultForTests(
      "useMcpStats",
      queryResult({
        data: normalizeMcpStats({
          windowHours: 24,
          totalCalls: 1,
          successfulCalls: 0,
          successRate: 0,
          averageLatencyMs: 3100,
          p95LatencyMs: 3100,
          lastCallAt: "2026-07-25T03:00:00Z",
          topTools: [{ toolName: "subscribers_create", calls: 1 }],
          topApiKeys: [],
          statusBreakdown: [{ class: 5, calls: 1 }],
          totalCostMicros: 0,
        }),
      }),
    );
    queryHooks.__setHookResultForTests(
      "useMcpTrend",
      queryResult({ data: normalizeMcpTrend({ points: [], windowHours: 24 }) }),
    );
    queryHooks.__setHookResultForTests(
      "useMcpExecutions",
      queryResult({ data: normalizeMcpExecutions({ rows: [executionWire()] }) }),
    );
    queryHooks.__setHookResultForTests("useMcpQuotas", queryResult({ data: undefined }));
    queryHooks.__setHookResultForTests("useMcpCatalog", queryResult({ data: undefined }));
    loadDetail(detailWire());

    const result = await render(<McpActivityScreen />, { wrapper });
    expect(result.queryByText("Execution 9")).toBeNull();
    // No sheet is open, so no detail read has been asked for.
    expect(queryHooks.__getHookCallsForTests("useMcpExecutionDetail").at(-1)).toEqual([null, true]);

    const row = result.getByRole("button", { name: /subscribers_create/ });
    expect(row.props.accessibilityHint).toBe("Opens the call's masked request metadata");
    await fireEvent.press(row);
    expect(result.getByText("Execution 9")).toBeTruthy();
    expect(queryHooks.__getHookCallsForTests("useMcpExecutionDetail").at(-1)).toEqual([9, true]);
    expect(result.getByLabelText("Query metadata: key_count=1")).toBeTruthy();

    await fireEvent.press(result.getByLabelText("Close"));
    expect(result.queryByText("Execution 9")).toBeNull();
  });
});
