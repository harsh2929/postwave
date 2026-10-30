import { describe, expect, it } from "vitest";

import {
  filterMcpExecutions,
  isMcpFailure,
  mcpActivityVerdict,
  mcpCallOutcome,
  mcpCostUnits,
  mcpExecutionCounts,
  mcpToolCoverageNotice,
  mcpWindowClampNotice,
  mcpWindowHours,
  mcpWindowLabel,
  normalizeMcpExecutions,
  normalizeMcpStats,
  normalizeMcpTrend,
} from "@/lib/mcpActivity";

/**
 * These tests pin the five server facts named at the top of lib/mcpActivity.ts.
 * Each `it` below corresponds to a place where the obvious implementation
 * states something the server never said.
 */

function statsWire(over: Record<string, unknown> = {}) {
  return {
    windowHours: 24,
    totalCalls: 40,
    successfulCalls: 38,
    successRate: 0.95,
    averageLatencyMs: 122.5,
    p95LatencyMs: 480,
    lastCallAt: "2026-07-25T03:00:00Z",
    topTools: [
      { toolName: "subscribers_list", calls: 20 },
      { toolName: "campaign_send", calls: 6 },
    ],
    topApiKeys: [{ apiKeyId: "key-1", apiKeyPrefix: "pw_live_ab", calls: 40 }],
    statusBreakdown: [
      { class: 2, calls: 38 },
      { class: 5, calls: 2 },
    ],
    totalCostMicros: 2_500_000,
    ...over,
  };
}

describe("mcpCallOutcome", () => {
  it("counts 3xx as success because the server's own filter does", () => {
    // apikeycalls.go:356 — status_code >= 200 AND status_code < 400.
    expect(mcpCallOutcome(200)).toBe("ok");
    expect(mcpCallOutcome(302)).toBe("ok");
    expect(mcpCallOutcome(399)).toBe("ok");
  });

  it("separates the three 4xx incidents an operator fixes differently", () => {
    expect(mcpCallOutcome(401)).toBe("denied");
    expect(mcpCallOutcome(403)).toBe("denied");
    expect(mcpCallOutcome(429)).toBe("throttled");
    expect(mcpCallOutcome(422)).toBe("client");
  });

  it("treats an unrecorded status as unknown, never as a success", () => {
    expect(mcpCallOutcome(0)).toBe("unknown");
    expect(mcpCallOutcome(Number.NaN)).toBe("unknown");
    expect(isMcpFailure("unknown")).toBe(false);
    expect(isMcpFailure("ok")).toBe(false);
    expect(isMcpFailure("server")).toBe(true);
  });
});

describe("normalizeMcpStats", () => {
  it("derives failedCalls from the two counters the server actually sends", () => {
    const stats = normalizeMcpStats(statsWire());
    expect(stats.failedCalls).toBe(2);
    expect(stats.hasCalls).toBe(true);
  });

  it("marks an empty window as hasCalls=false so 0% is never printed", () => {
    // The Go code only assigns SuccessRate when TotalCalls > 0, so an idle
    // window arrives as a literal successRate: 0.
    const stats = normalizeMcpStats(
      statsWire({
        totalCalls: 0,
        successfulCalls: 0,
        successRate: 0,
        lastCallAt: null,
      }),
    );
    expect(stats.hasCalls).toBe(false);
    expect(stats.successRate).toBe(0);
    expect(stats.lastCallAt).toBe("");
  });

  it("never reports a negative failure count from an inconsistent payload", () => {
    const stats = normalizeMcpStats(
      statsWire({ totalCalls: 3, successfulCalls: 9 }),
    );
    expect(stats.failedCalls).toBe(0);
  });

  it("survives a payload that is not an object at all", () => {
    const stats = normalizeMcpStats(null);
    expect(stats.totalCalls).toBe(0);
    expect(stats.hasCalls).toBe(false);
    expect(stats.topTools).toEqual([]);
    expect(stats.statusBreakdown).toEqual([]);
  });

  it("drops nameless tool rows rather than rendering a blank bar", () => {
    const stats = normalizeMcpStats(
      statsWire({
        topTools: [
          { toolName: "", calls: 5 },
          { toolName: "x", calls: 1 },
        ],
      }),
    );
    expect(stats.topTools.map((tool) => tool.toolName)).toEqual(["x"]);
  });
});

describe("mcpToolCoverageNotice", () => {
  it("states the shortfall without guessing which cause produced it", () => {
    const stats = normalizeMcpStats(statsWire());
    // 40 total, 26 accounted for by the top-5 tool rows.
    expect(mcpToolCoverageNotice(stats)).toContain("14 of 40 calls");
  });

  it("says nothing when the tool rows account for every call", () => {
    const stats = normalizeMcpStats(
      statsWire({ topTools: [{ toolName: "only", calls: 40 }] }),
    );
    expect(mcpToolCoverageNotice(stats)).toBeNull();
  });

  it("says nothing for an idle window — there is no shortfall to explain", () => {
    const stats = normalizeMcpStats(statsWire({ totalCalls: 0, topTools: [] }));
    expect(mcpToolCoverageNotice(stats)).toBeNull();
  });
});

describe("mcpActivityVerdict", () => {
  it("treats an empty MCP-labelled window as recorder absence, not zero traffic", () => {
    const stats = normalizeMcpStats(
      statsWire({ totalCalls: 0, successfulCalls: 0 }),
    );
    const verdict = mcpActivityVerdict(stats, "24h", false);
    expect(verdict.tone).toBe("idle");
    expect(verdict.headline).toBe(
      "No MCP-labelled recorder rows retained in the last 24 hours",
    );
    expect(verdict.detail).toContain("forgeable");
    expect(verdict.detail).toContain("does not prove");
  });

  it("changes the subject when the reader widened to every API-key call", () => {
    const stats = normalizeMcpStats(
      statsWire({ totalCalls: 0, successfulCalls: 0 }),
    );
    expect(mcpActivityVerdict(stats, "7d", true).headline).toBe(
      "No API-key recorder rows retained in the last 7 days",
    );
  });

  it("is 'ok' only when nothing failed", () => {
    const stats = normalizeMcpStats(
      statsWire({ totalCalls: 5, successfulCalls: 5 }),
    );
    const verdict = mcpActivityVerdict(stats, "24h", false);
    expect(verdict.tone).toBe("ok");
    expect(verdict.headline).toBe(
      "0 failures among 5 MCP-labelled recorder rows",
    );
    expect(verdict.detail).toContain("not proof that every call succeeded");
  });

  it("escalates from warn to bad at a quarter of the window failing", () => {
    const warn = normalizeMcpStats(
      statsWire({ totalCalls: 100, successfulCalls: 90 }),
    );
    const bad = normalizeMcpStats(
      statsWire({ totalCalls: 100, successfulCalls: 75 }),
    );
    expect(mcpActivityVerdict(warn, "24h", false).tone).toBe("warn");
    expect(mcpActivityVerdict(bad, "24h", false).tone).toBe("bad");
  });

  it("reports 'no reading yet' rather than inventing an idle window", () => {
    expect(mcpActivityVerdict(null, "24h", false).tone).toBe("idle");
    expect(mcpActivityVerdict(null, "24h", false).headline).toBe(
      "No reading yet",
    );
  });
});

describe("mcpWindowClampNotice", () => {
  it("discloses the trend endpoint's independent 30-day clamp", () => {
    // Repo.Trend clamps to 30d; parseWindow would have allowed 90d.
    expect(mcpWindowClampNotice("30d", 24 * 30)).toBeNull();
    const notice = mcpWindowClampNotice("30d", 24 * 7);
    expect(notice).toContain("7 days");
  });

  it("says nothing when the server has not answered yet", () => {
    expect(mcpWindowClampNotice("24h", 0)).toBeNull();
  });

  it("renders a sub-two-day clamp in hours", () => {
    expect(mcpWindowClampNotice("7d", 24)).toContain("24 hours");
  });
});

describe("windows", () => {
  it("maps each window to the hours the client asked for", () => {
    expect(mcpWindowHours("24h")).toBe(24);
    expect(mcpWindowHours("7d")).toBe(168);
    expect(mcpWindowHours("30d")).toBe(720);
    expect(mcpWindowLabel("7d")).toBe("7 days");
  });
});

describe("normalizeMcpTrend", () => {
  it("keeps the server's zero-filled buckets — an empty hour is a fact", () => {
    const trend = normalizeMcpTrend({
      points: [
        { bucket: "2026-07-25T01:00:00Z", calls: 0 },
        { bucket: "2026-07-25T02:00:00Z", calls: 4 },
      ],
      windowHours: 24,
    });
    expect(trend.points).toHaveLength(2);
    expect(trend.points[0]?.calls).toBe(0);
  });

  it("drops a bucket with no timestamp rather than plotting it at zero time", () => {
    const trend = normalizeMcpTrend({ points: [{ bucket: "", calls: 9 }] });
    expect(trend.points).toEqual([]);
  });
});

describe("normalizeMcpExecutions", () => {
  const wire = {
    rows: [
      {
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
      },
      { id: 8, statusCode: 200, calledAt: "2026-07-25T02:59:00Z" },
    ],
    nextBeforeId: 8,
  };

  it("classifies each row and keeps the untagged one", () => {
    const rows = normalizeMcpExecutions(wire);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.outcome).toBe("server");
    expect(rows[1]?.outcome).toBe("ok");
    expect(rows[1]?.toolName).toBe("");
  });

  it("accepts a bare array for a server that drops the envelope", () => {
    expect(normalizeMcpExecutions([{ id: 1, statusCode: 204 }])).toHaveLength(
      1,
    );
  });

  it("filters and counts failures without touching the source order", () => {
    const rows = normalizeMcpExecutions(wire);
    expect(mcpExecutionCounts(rows)).toEqual({ all: 2, failed: 1 });
    expect(filterMcpExecutions(rows, "failed").map((row) => row.id)).toEqual([
      9,
    ]);
    expect(filterMcpExecutions(rows, "all").map((row) => row.id)).toEqual([
      9, 8,
    ]);
  });
});

describe("mcpCostUnits", () => {
  it("converts micros to whole currency units", () => {
    expect(mcpCostUnits(normalizeMcpStats(statsWire()))).toBe(2.5);
  });

  it("returns null for an idle window rather than a $0.00 that was never measured", () => {
    expect(
      mcpCostUnits(
        normalizeMcpStats(statsWire({ totalCalls: 0, totalCostMicros: 0 })),
      ),
    ).toBeNull();
  });
});
