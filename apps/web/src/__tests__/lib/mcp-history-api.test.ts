// SPDX-License-Identifier: AGPL-3.0-only
//
// The three MCP history reads, and the minimization every row passes through
// before a surface may retain it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/lib/api", () => ({
  api: { get: mocks.get },
}));

import {
  getMcpStats,
  getMcpTrend,
  isCanonicalMcpToolToken,
  listMcpExecutions,
  MAX_RETAINED_MCP_EXECUTIONS,
  mcpRequestMetadata,
  mcpWindowSinceISO,
  mergeMcpExecutions,
  projectSafeMcpExecution,
  safeMcpPath,
  type McpExecution,
} from "@/lib/mcp-api";

const NOW = Date.parse("2026-09-05T12:00:00.000Z");

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 42,
    tenantId: "tenant-1",
    apiKeyId: "key-1",
    apiKeyPrefix: "pw_live_ab",
    method: "post",
    path: "/api/v1/subscribers",
    queryString: "key_count=3",
    toolName: "subscribers_list",
    statusCode: 201,
    latencyMs: 12.5,
    userAgent: "postwave-mcp-server/1.4.0",
    remoteIp: "203.0.113.9",
    errorCode: "",
    requestBody: { _summary: true, type: "object", key_count: 4 },
    dryRun: true,
    costMicros: 1_500,
    calledAt: "2026-09-05T11:59:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  mocks.get.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("MCP history reads", () => {
  it("asks for stats over the selected window and source", async () => {
    mocks.get.mockResolvedValue({
      windowHours: 24,
      totalCalls: 10,
      successfulCalls: 9,
      averageLatencyMs: 30,
      p95LatencyMs: 90,
      totalCostMicros: 2_000,
      lastCallAt: "2026-09-05T11:00:00Z",
      topTools: [
        { toolName: "campaigns_list", calls: 3 },
        { toolName: "subscribers_list", calls: 6 },
      ],
      statusBreakdown: [{ class: 2, calls: 9 }],
    });

    const stats = await getMcpStats({ window: "24h", include: "all" });

    expect(mocks.get).toHaveBeenCalledWith(
      "/api/v1/mcp/stats?window=24h&include=all",
      { signal: undefined },
    );
    // The rate is DERIVED, never trusted from the payload.
    expect(stats.successRate).toBeCloseTo(0.9, 6);
    // Top tools arrive in whatever order; the drill-down list is ranked.
    expect(stats.topTools.map((tool) => tool.toolName)).toEqual([
      "subscribers_list",
      "campaigns_list",
    ]);
  });

  it("omits include when the source is the npm proxy only", async () => {
    mocks.get.mockResolvedValue({ points: [] });
    await getMcpTrend({ window: "7d", include: "mcp" });
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/mcp/trend?window=7d", {
      signal: undefined,
    });
  });

  it("bounds the execution page by window, tool, limit and cursor", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    mocks.get.mockResolvedValue({ rows: [], nextBeforeId: 0 });

    await listMcpExecutions({
      window: "24h",
      include: "mcp",
      tool: "subscribers_list",
      beforeId: 91,
    });

    expect(mocks.get).toHaveBeenCalledWith(
      "/api/v1/mcp/executions?tool=subscribers_list" +
        `&since=${encodeURIComponent(mcpWindowSinceISO("24h", NOW))}` +
        "&limit=50&before_id=91",
      { signal: undefined },
    );
  });

  it("drops a tool filter the server would reject rather than sending a 400", async () => {
    mocks.get.mockResolvedValue({ rows: [] });
    expect(isCanonicalMcpToolToken("9lives")).toBe(false);

    await listMcpExecutions({ include: "mcp", tool: "9lives", limit: 8 });

    expect(mocks.get).toHaveBeenCalledWith("/api/v1/mcp/executions?limit=8", {
      signal: undefined,
    });
  });

  it("requests an unbounded newest-first page when no window is given", async () => {
    mocks.get.mockResolvedValue({ rows: [] });
    await listMcpExecutions({ include: "mcp", limit: 8 });
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/mcp/executions?limit=8", {
      signal: undefined,
    });
  });

  it("keeps a cursor only when the server sent a usable one", async () => {
    mocks.get.mockResolvedValue({
      rows: [row()],
      nextBeforeId: 0,
      detailPolicy: "minimized_v1",
      evidenceClass: "best_effort_observability",
    });
    const page = await listMcpExecutions({ window: "24h", include: "mcp" });
    expect(page.nextBeforeId).toBeUndefined();
    expect(page.evidenceClass).toBe("best_effort_observability");
    expect(page.rows).toHaveLength(1);
  });
});

describe("execution minimization", () => {
  it("strips the remote IP and raw request values at the boundary", () => {
    const projected = projectSafeMcpExecution(row());
    expect(projected).not.toBeNull();
    expect(projected).toMatchObject({
      id: 42,
      method: "POST",
      path: "/api/v1/subscribers",
      toolName: "subscribers_list",
      queryString: "key_count=3",
      dryRunAsserted: true,
    });
    // The IP is not merely hidden — the field does not exist on the row.
    expect(Object.keys(projected as McpExecution)).not.toContain("remoteIp");
    expect(projected?.requestBody).toEqual({
      _summary: true,
      type: "object",
      key_count: 4,
      _truncated: false,
    });
  });

  it("refuses a row with no usable identity or timestamp", () => {
    expect(projectSafeMcpExecution(row({ id: 0 }))).toBeNull();
    expect(projectSafeMcpExecution(row({ calledAt: "not a date" }))).toBeNull();
    expect(projectSafeMcpExecution(null)).toBeNull();
  });

  it("suppresses a path carrying secret-shaped material", () => {
    expect(safeMcpPath("/api/v1/x?pw_abcdefghijkl")).toBe(
      "/[SENSITIVE_PATH_SUPPRESSED]",
    );
    expect(safeMcpPath("relative")).toBe("/");
  });

  it("reduces a raw request body to constant shape fields only", () => {
    const metadata = mcpRequestMetadata({
      queryString: "email=someone@example.com&list=7",
      requestBody: { email: "someone@example.com", tags: ["vip"] },
    });
    expect(metadata.bodyJson).not.toContain("example.com");
    expect(metadata.bodyJson).not.toContain("tags");
    expect(JSON.parse(metadata.bodyJson)).toEqual({
      _summary: true,
      type: "object",
      key_count: 2,
      _truncated: false,
    });
    // The query is reduced to a count, so no key NAME survives either.
    expect(metadata.query).toBe("key_count=2");
    expect(metadata.redactionCount).toBe(4);
  });

  it("merges live rows ahead of paged rows without duplicating an id", () => {
    const paged = [row({ id: 3 }), row({ id: 2 })]
      .map(projectSafeMcpExecution)
      .filter((entry): entry is McpExecution => entry !== null);
    const live = projectSafeMcpExecution(row({ id: 4 })) as McpExecution;
    const duplicate = projectSafeMcpExecution(row({ id: 3 })) as McpExecution;

    expect(mergeMcpExecutions([live, duplicate], paged).map((r) => r.id)).toEqual(
      [4, 3, 2],
    );
  });

  it("stops accumulating at the retention ceiling the notice names", () => {
    const many = Array.from({ length: MAX_RETAINED_MCP_EXECUTIONS + 25 }, (_, i) =>
      projectSafeMcpExecution(row({ id: i + 1 })),
    ).filter((entry): entry is McpExecution => entry !== null);

    const merged = mergeMcpExecutions([], many);

    expect(merged).toHaveLength(MAX_RETAINED_MCP_EXECUTIONS);
    // The ceiling drops the OLDEST rows, never the newest.
    expect(merged[0].id).toBe(MAX_RETAINED_MCP_EXECUTIONS + 25);
  });
});
