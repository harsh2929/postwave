import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import AgentActivityRoute, {
  ErrorBoundary as AgentActivityErrorBoundary,
} from "../app/(tabs)/agent-activity";
import { McpActivityScreen } from "../src/components/mcp/McpActivityScreen";
import {
  normalizeMcpExecutions,
  normalizeMcpStats,
  normalizeMcpTrend,
} from "../src/lib/mcpActivity";
import { ToastProvider } from "../src/components/Toast";

const queryHooks = require("./mocks/queryHooks.cjs");
const authStore = require("./mocks/authStore.cjs");

jest.mock("@/hooks/useMcpActivity", () => require("./mocks/queryHooks.cjs"));

/**
 * The agent-activity monitor has five states a "does it render" test never
 * reaches, and each one is a place where the app could state something false:
 *
 *   ROLE   — every /api/v1/mcp/* route is mounted behind
 *            RequireScope(ScopeAdmin) (identity_api.go:111-120), even though
 *            the generated routeauth manifest lists the reads as viewer with
 *            review_status: fail_closed_default. Rendering "no calls" for a
 *            member would be a claim about the WORKSPACE when the true
 *            statement is about the SESSION.
 *   0 vs — — successRate/averageLatency/p95 are the zero values of an
 *            aggregate over an empty set; the Go code only assigns
 *            SuccessRate when TotalCalls > 0. "0%" on an idle window reads as
 *            a total outage.
 *   SCOPE  — the default read is MCP-only (user_agent ILIKE
 *            'postwave-mcp-server/%'), so "no calls" is a much narrower claim
 *            than "no API traffic", and the empty state has to say which.
 *   STATUS — a call with statusCode 0 was never given one by the recorder;
 *            "HTTP 0" would be an invented status.
 *   FILTER — "nothing failed" is a statement about the newest 50 rows, not
 *            about every call ever.
 */

function statsWire(over: Record<string, unknown> = {}) {
  return {
    windowHours: 24,
    totalCalls: 40,
    successfulCalls: 30,
    successRate: 0.75,
    averageLatencyMs: 122.4,
    p95LatencyMs: 480,
    lastCallAt: "2026-07-25T03:00:00Z",
    topTools: [{ toolName: "subscribers_list", calls: 20 }],
    topApiKeys: [{ apiKeyId: "key-1", apiKeyPrefix: "pw_live_ab", calls: 40 }],
    statusBreakdown: [
      { class: 2, calls: 30 },
      { class: 5, calls: 10 },
    ],
    totalCostMicros: 2_500_000,
    ...over,
  };
}

function executionWire(over: Record<string, unknown> = {}) {
  return {
    id: 9,
    apiKeyPrefix: "pw_live_ab",
    method: "POST",
    path: "/api/v1/subscribers",
    toolName: "subscribers_create",
    statusCode: 500,
    latencyMs: 3100,
    userAgent: "postwave-mcp-server/1.4.0",
    errorCode: "internal_error",
    dryRun: false,
    costMicros: 0,
    calledAt: "2026-07-25T03:00:00Z",
    ...over,
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

function loadAll(
  stats: Record<string, unknown>,
  executions: Record<string, unknown>[],
) {
  queryHooks.__setHookResultForTests(
    "useMcpStats",
    queryResult({ data: normalizeMcpStats(stats) }),
  );
  queryHooks.__setHookResultForTests(
    "useMcpTrend",
    queryResult({
      data: normalizeMcpTrend({
        points: [
          { bucket: "2026-07-25T01:00:00Z", calls: 0 },
          { bucket: "2026-07-25T02:00:00Z", calls: 4 },
        ],
        windowHours: 24,
      }),
    }),
  );
  queryHooks.__setHookResultForTests(
    "useMcpExecutions",
    queryResult({ data: normalizeMcpExecutions({ rows: executions }) }),
  );
}

async function renderScreen(Component: React.ComponentType = McpActivityScreen) {
  return render(
    React.createElement(ToastProvider, null, React.createElement(Component)),
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

describe("agent-activity route file", () => {
  it("mounts the default export the router actually loads", async () => {
    loadAll(statsWire(), [executionWire()]);
    const result = await renderScreen(AgentActivityRoute);
    expect(result.getByText("Agent activity")).toBeTruthy();
  });

  it("exports a route-scoped ErrorBoundary", async () => {
    expect(typeof AgentActivityErrorBoundary).toBe("function");
  });
});

describe("role gate", () => {
  it("refuses a member session BEFORE issuing a request, and never says 'no calls'", async () => {
    authStore.__setAuthStateForTests({ session: { effectiveRole: "member" } });
    loadAll(statsWire({ totalCalls: 0, successfulCalls: 0 }), []);
    const result = await renderScreen();
    expect(result.getByText("Needs an owner or admin session")).toBeTruthy();
    expect(result.queryByText("No MCP-labelled recorder rows loaded")).toBeNull();
  });

  it("refuses an editor session — editor is not in editorWriteScopes for admin", async () => {
    authStore.__setAuthStateForTests({ session: { effectiveRole: "editor" } });
    loadAll(statsWire(), [executionWire()]);
    expect((await renderScreen()).getByText("Needs an owner or admin session")).toBeTruthy();
  });

  it("refuses an api_key session — mobile never receives the admin scope", async () => {
    authStore.__setAuthStateForTests({ mode: "api_key" });
    loadAll(statsWire(), [executionWire()]);
    expect((await renderScreen()).getByText("Needs an owner or admin session")).toBeTruthy();
  });

  it("treats a live 403 as the role state rather than a generic error", async () => {
    queryHooks.__setHookResultForTests(
      "useMcpStats",
      queryResult({ isError: true, error: { status: 403 } }),
    );
    queryHooks.__setHookResultForTests("useMcpExecutions", queryResult({ data: [] }));
    const result = await renderScreen();
    expect(result.getByText("Needs an owner or admin session")).toBeTruthy();
    expect(
      result.getByText(/refused this read just now/),
    ).toBeTruthy();
  });

  it("admits an admin session", async () => {
    authStore.__setAuthStateForTests({ session: { effectiveRole: "admin" } });
    loadAll(statsWire(), [executionWire()]);
    expect((await renderScreen()).queryByText("Needs an owner or admin session")).toBeNull();
  });
});

describe("absence is not zero", () => {
  it("renders an em-dash rather than 0% for a window with no calls", async () => {
    loadAll(statsWire({ totalCalls: 0, successfulCalls: 0, successRate: 0, p95LatencyMs: 0, averageLatencyMs: 0, totalCostMicros: 0, topTools: [], statusBreakdown: [] }), []);
    const result = await renderScreen();
    expect(
      result.getByText(
        "No MCP-labelled recorder rows retained in the last 24 hours",
      ),
    ).toBeTruthy();
    expect(result.queryByText("0%")).toBeNull();
    expect(result.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("names the User-Agent filter in the idle empty state", async () => {
    loadAll(statsWire({ totalCalls: 0, successfulCalls: 0, topTools: [] }), []);
    expect(
      (await renderScreen()).getByText(
        "No MCP-labelled recorder rows loaded",
      ),
    ).toBeTruthy();
  });

  it("states the failure count when calls did fail", async () => {
    loadAll(statsWire(), [executionWire()]);
    const result = await renderScreen();
    expect(
      result.getByText("10 failures among 40 MCP-labelled recorder rows"),
    ).toBeTruthy();
    expect(result.getByText("40 retained rows · 10 recorded failures")).toBeTruthy();
    expect(result.getByText("Recorded success rate")).toBeTruthy();
    expect(result.getByText("Recorded cost estimate")).toBeTruthy();
    expect(result.queryByText("Billable cost")).toBeNull();
    expect(result.getByText(/best-effort and droppable/)).toBeTruthy();
  });
});

describe("execution log", () => {
  it("says 'no status' rather than inventing HTTP 0", async () => {
    loadAll(statsWire(), [executionWire({ id: 3, statusCode: 0, errorCode: "" })]);
    const result = await renderScreen();
    expect(result.getByText("no status")).toBeTruthy();
    // The meta run is hidden from the a11y tree (the row speaks every figure
    // once, in full), so both surfaces are asserted: the spoken sentence, and
    // the visible run with hidden elements included.
    expect(
      result.getByLabelText(/No HTTP status was recorded/),
    ).toBeTruthy();
    expect(
      result.getByText("HTTP —", { includeHiddenElements: true }),
    ).toBeTruthy();
    expect(
      result.queryByText("HTTP 0", { includeHiddenElements: true }),
    ).toBeNull();
  });

  it("falls back to method and path for a call that carried no tool name", async () => {
    loadAll(statsWire(), [executionWire({ toolName: "" })]);
    expect((await renderScreen()).getByText("POST /api/v1/subscribers")).toBeTruthy();
  });

  it("scopes 'nothing failed' to the page rather than to all time", async () => {
    loadAll(statsWire(), [executionWire({ statusCode: 200, errorCode: "" })]);
    const result = await renderScreen();
    await fireEvent.press(result.getByLabelText(/Calls that failed/));
    expect(result.getByText("Nothing failed in this page")).toBeTruthy();
  });

  it("keeps the failed call when the failed filter is on", async () => {
    loadAll(statsWire(), [
      executionWire({ id: 1, statusCode: 200, toolName: "ok_tool", errorCode: "" }),
      executionWire({ id: 2, statusCode: 500, toolName: "bad_tool" }),
    ]);
    const result = await renderScreen();
    await fireEvent.press(result.getByLabelText(/Calls that failed/));
    expect(result.getByText("bad_tool")).toBeTruthy();
    expect(result.queryByText("ok_tool")).toBeNull();
  });
});

describe("offline", () => {
  it("says the reading is unavailable rather than that nothing ran", async () => {
    queryHooks.__setOnlineGateForTests({ enabled: false });
    queryHooks.__setHookResultForTests("useMcpStats", queryResult({ data: undefined }));
    queryHooks.__setHookResultForTests("useMcpExecutions", queryResult({ data: [] }));
    const result = await renderScreen();
    expect(
      result.getByText(/Agent activity needs a connection/),
    ).toBeTruthy();
  });
});

describe("monitor scoping", () => {
  it("says out loud that key minting and quotas stay on the web admin", async () => {
    loadAll(statsWire(), [executionWire()]);
    expect(
      (await renderScreen()).getByText(/Minting a scoped key/),
    ).toBeTruthy();
  });
});
