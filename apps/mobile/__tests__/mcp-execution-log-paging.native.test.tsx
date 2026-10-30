import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

const mockFetchPage = jest.fn(
  async (_query: unknown): Promise<unknown> => ({ rows: [], nextBeforeId: null }),
);

jest.mock("@/hooks/useMcpActivity", () => require("./mocks/queryHooks.cjs"));
jest.mock("@/hooks/useMcpQuotas", () => require("./mocks/queryHooks.cjs"));
jest.mock("@/hooks/useMcpCatalog", () => require("./mocks/queryHooks.cjs"));
jest.mock("@/hooks/useMcpExecutionDetail", () =>
  require("./mocks/queryHooks.cjs"),
);
// The pager hook (hooks/useMcpExecutionLog) runs for REAL; only the transport
// beneath it is replaced, so what is asserted is the traversal itself — the
// cursor sent, the rows kept, when it stops — not a mock of it.
jest.mock("@/api/mcpExecutionLog", () => ({
  fetchMcpExecutionPage: (query: unknown) => mockFetchPage(query),
}));

// eslint-disable-next-line import/first
import { McpActivityScreen } from "../src/components/mcp/McpActivityScreen";
// eslint-disable-next-line import/first
import { ToastProvider } from "../src/components/Toast";
// eslint-disable-next-line import/first
import {
  normalizeMcpExecutions,
  normalizeMcpStats,
  normalizeMcpTrend,
} from "../src/lib/mcpActivity";
// eslint-disable-next-line import/first
import {
  MCP_OLDER_EXHAUSTED,
  MCP_OLDER_OFFLINE,
  parseMcpExecutionPage,
} from "../src/lib/mcpExecutionLog";

const queryHooks = require("./mocks/queryHooks.cjs");
const authStore = require("./mocks/authStore.cjs");

/**
 * P3 (mcp) — tool filter and before-id paging on the execution log. The
 * places a "does it render" test never reaches, each one a claim the app
 * could make falsely:
 *
 *   CURSOR — "Load older" is offered only after a FULL first page, sends the
 *            oldest loaded id as before_id, and the sentence names it.
 *   ONCE   — an older page's rows are appended once: a row already on screen,
 *            or one at or above the cursor (a server that ignored before_id),
 *            is dropped rather than shown twice or forever.
 *   STOP   — a short page ends the traversal with the desktop's sentence,
 *            which says "were not returned", not "do not exist".
 *   SERVER — a chip sends the exact identifier to the server through the
 *            first-page hook; it is not a client-side hide.
 *   MEMORY — chips seen stay after the rows narrow, so there is a way back.
 *   RESET  — a filter change discards pages loaded under the old filter.
 *   FAULT  — a failed page keeps the cursor for a retry and says why.
 */

const TOOLS = ["campaign_send", "subscribers_list"] as const;

function executionWire(over: Record<string, unknown> = {}) {
  return {
    id: 9,
    apiKeyPrefix: "pw_live_ab",
    method: "POST",
    path: "/api/v1/subscribers",
    toolName: "subscribers_create",
    statusCode: 200,
    latencyMs: 31,
    userAgent: "postwave-mcp-server/1.4.0",
    errorCode: "",
    dryRun: false,
    costMicros: 0,
    calledAt: "2026-07-25T03:00:00Z",
    ...over,
  };
}

/** `count` rows with ids `top` downward, alternating between the two tools. */
function pageWire(count: number, top = 100) {
  return Array.from({ length: count }, (_, index) =>
    executionWire({ id: top - index, toolName: TOOLS[index % 2] }),
  );
}

function statsWire() {
  return {
    windowHours: 24,
    totalCalls: 40,
    successfulCalls: 40,
    successRate: 1,
    averageLatencyMs: 30,
    p95LatencyMs: 80,
    lastCallAt: "2026-07-25T03:00:00Z",
    topTools: [{ toolName: "subscribers_list", calls: 20 }],
    topApiKeys: [],
    statusBreakdown: [{ class: 2, calls: 40 }],
    totalCostMicros: 0,
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

function setFirstPage(executions: Record<string, unknown>[]) {
  queryHooks.__setHookResultForTests(
    "useMcpExecutions",
    queryResult({ data: normalizeMcpExecutions({ rows: executions }) }),
  );
}

function loadAll(executions: Record<string, unknown>[]) {
  queryHooks.__setHookResultForTests(
    "useMcpStats",
    queryResult({ data: normalizeMcpStats(statsWire()) }),
  );
  queryHooks.__setHookResultForTests(
    "useMcpTrend",
    queryResult({ data: normalizeMcpTrend({ points: [], windowHours: 24 }) }),
  );
  setFirstPage(executions);
}

function lastExecutionsCall(): unknown[] {
  const calls = queryHooks.__getHookCallsForTests("useMcpExecutions");
  return calls[calls.length - 1] ?? [];
}

async function renderScreen() {
  return render(
    React.createElement(ToastProvider, null, React.createElement(McpActivityScreen)),
    {
      wrapper: ({ children }) => (
        <SafeAreaProvider
          initialMetrics={{
            frame: { height: 844, width: 390, x: 0, y: 0 },
            insets: { bottom: 34, left: 0, right: 0, top: 47 },
          }}
        >
          {children}
        </SafeAreaProvider>
      ),
    },
  );
}

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
  authStore.__resetAuthStateForTests();
});

describe("load older — cursor", () => {
  it("offers Load older only after a full first page, and names the cursor", async () => {
    loadAll(pageWire(50));
    const full = await renderScreen();
    expect(full.getByText("Load older")).toBeTruthy();
    expect(full.getByText("Next cursor begins before execution 51.")).toBeTruthy();
    expect(full.queryByText(MCP_OLDER_EXHAUSTED)).toBeNull();
    // unmount() is async in this RNTL; left un-awaited it empties every render
    // that follows in the file (the sibling detail-sheet suite hit the same
    // order-dependent failure).
    await full.unmount();

    loadAll([executionWire()]);
    const short = await renderScreen();
    expect(short.queryByText("Load older")).toBeNull();
    expect(short.getByText(MCP_OLDER_EXHAUSTED)).toBeTruthy();
  });

  it("sends the oldest loaded id as before_id, appends each unseen older row once, and stops after a short page", async () => {
    mockFetchPage.mockImplementation(async () =>
      parseMcpExecutionPage({
        rows: [
          executionWire({ id: 50, toolName: "older_tool" }),
          // Already on screen (the cursor row) and above the cursor: neither
          // may be shown, or the log would repeat itself.
          executionWire({ id: 51, toolName: "dup_tool" }),
          executionWire({ id: 200, toolName: "future_tool" }),
        ],
        nextBeforeId: null,
      }),
    );
    loadAll(pageWire(50));
    const result = await renderScreen();

    fireEvent.press(result.getByText("Load older"));
    expect(mockFetchPage).toHaveBeenCalledTimes(1);
    expect(mockFetchPage).toHaveBeenCalledWith({
      includeAll: false,
      tool: "",
      limit: 50,
      beforeId: 51,
    });

    await waitFor(() => expect(result.getByText("older_tool")).toBeTruthy());
    expect(result.getAllByText("older_tool")).toHaveLength(1);
    expect(result.queryByText("dup_tool")).toBeNull();
    expect(result.queryByText("future_tool")).toBeNull();
    expect(result.queryByText("Load older")).toBeNull();
    expect(result.getByText(MCP_OLDER_EXHAUSTED)).toBeTruthy();
  });

  it("keeps paging from the new cursor while pages are full and the server offers one", async () => {
    mockFetchPage
      .mockImplementationOnce(async () =>
        parseMcpExecutionPage({ rows: pageWire(50, 50), nextBeforeId: 1 }),
      )
      .mockImplementationOnce(async () =>
        parseMcpExecutionPage({ rows: [], nextBeforeId: null }),
      );
    loadAll(pageWire(50));
    const result = await renderScreen();

    fireEvent.press(result.getByText("Load older"));
    await waitFor(() =>
      expect(result.getByText("Next cursor begins before execution 1.")).toBeTruthy(),
    );
    fireEvent.press(result.getByText("Load older"));
    expect(mockFetchPage).toHaveBeenLastCalledWith({
      includeAll: false,
      tool: "",
      limit: 50,
      beforeId: 1,
    });
    await waitFor(() => expect(result.getByText(MCP_OLDER_EXHAUSTED)).toBeTruthy());
    expect(result.queryByText("Load older")).toBeNull();
  });

  it("keeps the cursor for a retry when an older page fails, and says why", async () => {
    mockFetchPage.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    loadAll(pageWire(50));
    const result = await renderScreen();

    fireEvent.press(result.getByText("Load older"));
    await waitFor(() =>
      expect(result.getByText("Older executions were not added")).toBeTruthy(),
    );
    expect(result.getByText("boom")).toBeTruthy();
    expect(result.getByText("Load older")).toBeTruthy();
    expect(result.getByText("Next cursor begins before execution 51.")).toBeTruthy();
  });

  it("says older calls need a connection rather than offering a dead button", async () => {
    queryHooks.__setOnlineGateForTests({ enabled: false });
    loadAll(pageWire(50));
    const result = await renderScreen();
    expect(result.queryByText("Load older")).toBeNull();
    expect(result.getByText(MCP_OLDER_OFFLINE)).toBeTruthy();
  });
});

/**
 * The chips sit behind a disclosure, so every chip assertion opens it first.
 * The press is awaited because a state change only reaches the render on the
 * next flush in this RNTL.
 */
async function openToolFilter(
  result: Awaited<ReturnType<typeof renderScreen>>,
): Promise<void> {
  fireEvent.press(result.getByLabelText("Filter calls by tool identifier"));
  await waitFor(() => expect(result.getByLabelText("All tools")).toBeTruthy());
}

describe("tool filter — chips", () => {
  it("offers the tools seen, sends the exact identifier to the server, and keeps the others after the rows narrow", async () => {
    loadAll(pageWire(4));
    const result = await renderScreen();
    // Folded until asked for — but the caption naming what the log is a list
    // OF is outside the fold, so the unfiltered claim is never silent.
    expect(result.getByText("All recorded identifiers.")).toBeTruthy();
    expect(result.queryByLabelText("Only campaign_send")).toBeNull();

    await openToolFilter(result);
    expect(result.getByLabelText("Only campaign_send")).toBeTruthy();
    expect(result.getByLabelText("Only subscribers_list")).toBeTruthy();
    // The chip must NOT repeat the identifier the rows already show: two
    // campaign_send rows are loaded, so two is the whole count. A chip
    // labelled with the bare name would make it three, and would make the
    // execution log's own "this tool is not in the filtered page" assertions
    // (agent-activity.native.test.tsx) pass on a chip instead of on a row.
    expect(result.getAllByText("campaign_send")).toHaveLength(2);
    expect(lastExecutionsCall()[2]).toBe("");

    // The server answers the narrowed read with campaign_send rows only.
    setFirstPage(pageWire(4).filter((row) => row.toolName === "campaign_send"));
    fireEvent.press(result.getByLabelText("Only campaign_send"));

    // A chip press only reaches the render on the next flush in this RNTL, so
    // the re-render is awaited before anything is asserted about it; the "Load
    // older" assertions above need no wait because they read the request the
    // handler makes synchronously.
    await waitFor(() => expect(lastExecutionsCall()[2]).toBe("campaign_send"));
    expect(result.queryByLabelText(/^ok\. subscribers_list\./)).toBeNull();
    expect(result.getAllByLabelText(/^ok\. campaign_send\./)).toHaveLength(2);
    // The chip for the tool no longer in the rows is still there.
    expect(result.getByLabelText("Only subscribers_list")).toBeTruthy();
    // …and an active filter cannot be folded away: the disclosure that would
    // hide the only way back is not offered while one is applied.
    expect(result.queryByLabelText("Filter calls by tool identifier")).toBeNull();
    expect(
      result.getByText(
        "Only rows recorded under campaign_send. The server applies this filter; 2 rows loaded so far.",
      ),
    ).toBeTruthy();
  });

  it("discards older pages loaded under the previous filter", async () => {
    mockFetchPage.mockImplementation(async () =>
      parseMcpExecutionPage({
        rows: [executionWire({ id: 50, toolName: "older_tool" })],
        nextBeforeId: null,
      }),
    );
    loadAll(pageWire(50));
    const result = await renderScreen();
    fireEvent.press(result.getByText("Load older"));
    await waitFor(() => expect(result.getByText("older_tool")).toBeTruthy());

    await openToolFilter(result);
    fireEvent.press(result.getByLabelText("Only campaign_send"));
    await waitFor(() => expect(lastExecutionsCall()[2]).toBe("campaign_send"));
    expect(result.queryByText("older_tool")).toBeNull();
    // The older row's tool was seen, so it is still offered as a chip.
    expect(result.getByLabelText("Only older_tool")).toBeTruthy();
  });

  it("names the filter in the empty state and offers the way out", async () => {
    loadAll(pageWire(4));
    const result = await renderScreen();
    await openToolFilter(result);
    setFirstPage([]);
    fireEvent.press(result.getByLabelText("Only campaign_send"));

    await waitFor(() =>
      expect(result.getByText("No loaded rows for campaign_send")).toBeTruthy(),
    );
    expect(result.queryByText("No MCP-labelled recorder rows loaded")).toBeNull();
    fireEvent.press(result.getByText("Clear tool filter"));
    await waitFor(() => expect(lastExecutionsCall()[2]).toBe(""));
    expect(result.getByLabelText("Only campaign_send")).toBeTruthy();
  });
});
