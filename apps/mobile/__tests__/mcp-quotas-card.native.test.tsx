import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { McpActivityScreen } from "../src/components/mcp/McpActivityScreen";
import { McpQuotasCard } from "../src/components/mcp/McpQuotasCard";
import { ToastProvider } from "../src/components/Toast";
import {
  normalizeMcpExecutions,
  normalizeMcpStats,
  normalizeMcpTrend,
} from "../src/lib/mcpActivity";
import { normalizeMcpQuotas } from "../src/lib/mcpQuotas";

const queryHooks = require("./mocks/queryHooks.cjs");
const authStore = require("./mocks/authStore.cjs");

jest.mock("@/hooks/useMcpActivity", () => require("./mocks/queryHooks.cjs"));
jest.mock("@/hooks/useMcpQuotas", () => require("./mocks/queryHooks.cjs"));
jest.mock("@/hooks/useMcpCatalog", () => require("./mocks/queryHooks.cjs"));
jest.mock("@/hooks/useMcpExecutionDetail", () =>
  require("./mocks/queryHooks.cjs"),
);

/**
 * P2.52 — per-tool daily quota utilisation. The places a "does it render"
 * test never reaches, each one a claim the server never made:
 *
 *   ENFORCED  — the payload says advisory_unverified / authoritative:false /
 *               a release-hold code. A full bar must not read as "blocked".
 *   UNLIMITED — dailyLimit is a nullable pointer. A missing threshold is an
 *               empty track and "no configured threshold row", never
 *               "unlimited".
 *   HELD      — a 503 on the read is the server's sentence, verbatim, with no
 *               Retry (a hold is a boundary, not a fault).
 *   ROLE      — the card is only mounted for owner/admin, like the monitor.
 */

const TENANT = "11111111-1111-4111-8111-111111111111";
const NOW = Date.UTC(2026, 6, 25, 3, 0, 0);

function quotasWire(over: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    quotas: [
      { toolName: "subscribers_list", dailyLimit: 50, estimatedCostMicros: 0, usedToday: 12 },
      { toolName: "campaign_send", estimatedCostMicros: 2_500_000, usedToday: 3 },
    ],
    enforcementMode: "advisory_unverified",
    authoritative: false,
    releaseHold: "mcp_quota_enforcement_release_held",
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

function loadQuotas(wire: Record<string, unknown> | null, over: Record<string, unknown> = {}) {
  const parsed = wire ? normalizeMcpQuotas(wire, TENANT) : null;
  queryHooks.__setHookResultForTests(
    "useMcpQuotas",
    queryResult({ data: parsed?.snapshot ?? undefined, ...over }),
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

async function renderCard(gate = { enabled: true }) {
  return render(<McpQuotasCard allowed gate={gate} now={NOW} />, { wrapper });
}

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
  authStore.__resetAuthStateForTests();
});

describe("quota bars", () => {
  it("renders one progressbar per configured tool with the desktop's captions", async () => {
    loadQuotas(quotasWire());
    const result = await renderCard();
    const bar = result.getByLabelText("subscribers_list");
    expect(bar.props.accessibilityRole).toBe("progressbar");
    expect(bar.props.accessibilityValue).toEqual({ min: 0, max: 100, now: 24 });
    expect(
      result.getByText("12 used / 50 configured threshold · 24.0% · below configured threshold"),
    ).toBeTruthy();
    expect(
      result.getByText(
        "38 calls until the configured threshold (not an enforcement promise) · configured estimate $0.00 per call",
      ),
    ).toBeTruthy();
    expect(result.getByText("24.0%")).toBeTruthy();
  });

  it("renders a row without a threshold as 'no configured threshold row', never 'unlimited'", async () => {
    loadQuotas(quotasWire());
    const result = await renderCard();
    const bar = result.getByLabelText("campaign_send");
    expect(bar.props.accessibilityValue).toBeUndefined();
    expect(result.getByText("3 used · no configured threshold row")).toBeTruthy();
    expect(
      result.getByText(
        "No daily threshold represented · configured estimate $2.50 per call",
      ),
    ).toBeTruthy();
    expect(result.getByText("no threshold")).toBeTruthy();
    expect(result.queryByText(/unlimited/i)).toBeNull();
  });

  it("calls a bar at or over the threshold 'above or near threshold' and states the overage", async () => {
    loadQuotas(
      quotasWire({
        quotas: [
          { toolName: "campaign_send", dailyLimit: 40, estimatedCostMicros: 0, usedToday: 50 },
        ],
      }),
    );
    const result = await renderCard();
    expect(
      result.getByText("50 used / 40 configured threshold · 125.0% · above or near threshold"),
    ).toBeTruthy();
    expect(result.getByText(/10 observed calls above the configured threshold/)).toBeTruthy();
    expect(result.getByLabelText("campaign_send").props.accessibilityValue).toEqual({
      min: 0,
      max: 100,
      now: 100,
    });
  });
});

describe("what the card refuses to claim", () => {
  it("prints the server's stance verbatim and never asserts enforcement", async () => {
    loadQuotas(quotasWire());
    const result = await renderCard();
    expect(
      result.getByText(
        "Server stance: enforcement advisory_unverified · not authoritative · hold mcp_quota_enforcement_release_held",
      ),
    ).toBeTruthy();
    expect(
      result.getByText(
        "2 configured per-tool quota observations. Best-effort usage is counted from 00:00 UTC; cost values are configured estimates per call and are not billing receipts.",
      ),
    ).toBeTruthy();
    // The card may NEGATE enforcement in prose; it must never assert it.
    expect(result.queryByText("Enforced")).toBeNull();
    expect(result.queryByText("Authoritative")).toBeNull();
    expect(result.queryByText(/\bis enforced\b/i)).toBeNull();
  });

  it("names the UTC reset time and says the counters are observations", async () => {
    loadQuotas(quotasWire());
    const result = await renderCard();
    expect(result.getByText(/^Usage resets at .+\. These counters and tool labels are caller-influenced/)).toBeTruthy();
    expect(result.getByText(/do not prove that a threshold was enforced, that an excess call was blocked, or that every call was counted\.$/)).toBeTruthy();
  });

  it("says an empty list is not an unlimited policy", async () => {
    loadQuotas(quotasWire({ quotas: [] }));
    const result = await renderCard();
    expect(result.getByText("No configured per-tool quota observations")).toBeTruthy();
    expect(
      result.getByText(/Absence does not establish an enforced unlimited policy\./),
    ).toBeTruthy();
  });

  it("renders a 503 hold in the server's sentence with no Retry", async () => {
    loadQuotas(null, {
      isError: true,
      error: {
        status: 503,
        code: "mcp_quota_enforcement_release_held",
        message:
          "per-tool quota mutation is release-held until server-attributed atomic reservations are available",
      },
    });
    const result = await renderCard();
    expect(result.getByText("Release-held on this server")).toBeTruthy();
    expect(
      result.getByText(
        "per-tool quota mutation is release-held until server-attributed atomic reservations are available",
      ),
    ).toBeTruthy();
    expect(result.getByText("mcp_quota_enforcement_release_held")).toBeTruthy();
    expect(result.queryByText("Retry")).toBeNull();
  });

  it("says offline is not the same as no quota being configured", async () => {
    loadQuotas(null);
    const result = await renderCard({ enabled: false });
    expect(result.getByText(/Quota observations need a connection/)).toBeTruthy();
    expect(result.queryByText("No configured per-tool quota observations")).toBeNull();
  });
});

describe("mounted in the monitor", () => {
  function loadMonitor() {
    queryHooks.__setHookResultForTests(
      "useMcpStats",
      queryResult({
        data: normalizeMcpStats({
          windowHours: 24,
          totalCalls: 4,
          successfulCalls: 4,
          successRate: 1,
          averageLatencyMs: 10,
          p95LatencyMs: 20,
          lastCallAt: "2026-07-25T03:00:00Z",
          topTools: [],
          topApiKeys: [],
          statusBreakdown: [],
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
      queryResult({ data: normalizeMcpExecutions({ rows: [] }) }),
    );
    queryHooks.__setHookResultForTests("useMcpCatalog", queryResult({ data: undefined }));
    queryHooks.__setHookResultForTests("useMcpExecutionDetail", queryResult({ data: undefined }));
    loadQuotas(quotasWire());
  }

  it("shows the quota card to an admin, between the trend and the log", async () => {
    authStore.__setAuthStateForTests({ session: { effectiveRole: "admin" } });
    loadMonitor();
    const result = await render(<McpActivityScreen />, { wrapper });
    expect(result.getByText("Provisional quota signals")).toBeTruthy();
    expect(result.getByLabelText("subscribers_list")).toBeTruthy();
    expect(queryHooks.__getHookCallsForTests("useMcpQuotas").at(-1)).toEqual([true]);
  });

  it("does not mount the card — or issue the read — for a member", async () => {
    authStore.__setAuthStateForTests({ session: { effectiveRole: "member" } });
    loadMonitor();
    const result = await render(<McpActivityScreen />, { wrapper });
    expect(result.queryByText("Provisional quota signals")).toBeNull();
    expect(queryHooks.__getHookCallsForTests("useMcpQuotas")).toEqual([]);
  });
});
